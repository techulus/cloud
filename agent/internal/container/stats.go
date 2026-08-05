package container

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type ResourceStats struct {
	ContainerID          string
	ServiceID            string
	DeploymentID         string
	CPUUsagePercent      float64
	CPUUsageValid        bool
	MemoryUsagePercent   float64
	MemoryUsageValid     bool
	MemoryUsedBytes      float64
	MemoryUsedValid      bool
	NetworkReceiveBytes  float64
	NetworkTransmitBytes float64
}

type podmanStatsSample struct {
	ContainerID string                         `json:"ContainerID"`
	CPUNano     uint64                         `json:"CPUNano"`
	SystemNano  uint64                         `json:"SystemNano"`
	MemUsage    uint64                         `json:"MemUsage"`
	MemPerc     float64                        `json:"MemPerc"`
	NetInput    uint64                         `json:"NetInput"`
	NetOutput   uint64                         `json:"NetOutput"`
	Network     *map[string]podmanNetworkStats `json:"Network"`
}

type podmanNetworkStats struct {
	RxBytes uint64 `json:"RxBytes"`
	TxBytes uint64 `json:"TxBytes"`
}

type podmanStatsReport struct {
	Error json.RawMessage     `json:"Error"`
	Stats []podmanStatsSample `json:"Stats"`
}

const podmanSocketPath = "/run/podman/podman.sock"

var (
	podmanBaseURL     = "http://podman"
	podmanDialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", podmanSocketPath)
	}
	podmanHTTPClient = &http.Client{Transport: &http.Transport{
		DisableCompression: true,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return podmanDialContext(ctx, network, address)
		},
	}}
)

var previousResourceSamples = struct {
	sync.Mutex
	byContainer map[string]podmanStatsSample
}{byContainer: make(map[string]podmanStatsSample)}

// resourceStatsCollectionMu ensures overlapping periodic and requested reports
// compare CPU counters from snapshots collected in order.
var resourceStatsCollectionMu sync.Mutex

func CollectResourceStats() ([]ResourceStats, error) {
	resourceStatsCollectionMu.Lock()
	defer resourceStatsCollectionMu.Unlock()

	containers, err := List()
	if err != nil {
		return nil, err
	}

	running := make([]Container, 0, len(containers))
	containerIDs := make([]string, 0, len(containers))
	for _, c := range containers {
		if c.State != "running" || c.ServiceID == "" || c.DeploymentID == "" {
			continue
		}
		running = append(running, c)
		containerIDs = append(containerIDs, c.ID)
	}
	if len(running) == 0 {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	samples, err := fetchPodmanStats(ctx, podmanHTTPClient, podmanBaseURL+"/v4.0.0/libpod/containers/stats", containerIDs)
	if err != nil {
		return nil, err
	}

	previousResourceSamples.Lock()
	defer previousResourceSamples.Unlock()
	nextSamples := make(map[string]podmanStatsSample, len(samples))
	for _, container := range running {
		if previous, ok := previousResourceSamples.byContainer[container.ID]; ok {
			nextSamples[container.ID] = previous
		}
	}
	stats := make([]ResourceStats, 0, len(samples))
	for _, sample := range samples {
		container := findStatsContainerByID(sample.ContainerID, running)
		if container == nil {
			continue
		}
		previous := previousResourceSamples.byContainer[container.ID]
		stats = append(stats, resourceStatsFromSamples(*container, previous, sample))
		nextSamples[container.ID] = sample
	}
	previousResourceSamples.byContainer = nextSamples
	return stats, nil
}

func fetchPodmanStats(ctx context.Context, client *http.Client, endpoint string, containerIDs []string) ([]podmanStatsSample, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create container stats request: %w", err)
	}
	query := req.URL.Query()
	query.Set("stream", "false")
	for _, containerID := range containerIDs {
		query.Add("containers", containerID)
	}
	req.URL.RawQuery = query.Encode()

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to collect container stats: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024))
		return nil, fmt.Errorf("failed to collect container stats: podman returned %s: %s", resp.Status, strings.TrimSpace(string(message)))
	}

	var report podmanStatsReport
	decoder := json.NewDecoder(resp.Body)
	if err := decoder.Decode(&report); err != nil {
		return nil, fmt.Errorf("failed to decode container stats: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("failed to decode container stats: unexpected additional response")
		}
		return nil, fmt.Errorf("failed to decode container stats: %w", err)
	}
	if value := bytes.TrimSpace(report.Error); len(value) > 0 && !bytes.Equal(value, []byte("null")) {
		return nil, fmt.Errorf("failed to collect container stats: podman report error: %.1024s", value)
	}
	return report.Stats, nil
}

func findStatsContainerByID(value string, containers []Container) *Container {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}

	for i := range containers {
		containerID := strings.TrimSpace(containers[i].ID)
		if value == containerID {
			return &containers[i]
		}
		if containerID != "" && (strings.HasPrefix(containerID, value) || strings.HasPrefix(value, containerID)) {
			return &containers[i]
		}
	}
	return nil
}

func resourceStatsFromSamples(container Container, previous, current podmanStatsSample) ResourceStats {
	cpuUsagePercent := 0.0
	// Podman SystemNano is a wall-clock timestamp, so CPU nanoseconds divided
	// by its delta yields used cores; the metrics sender converts percent to cores.
	cpuUsageValid :=
		previous.SystemNano > 0 &&
			current.CPUNano >= previous.CPUNano &&
			current.SystemNano > previous.SystemNano
	if cpuUsageValid {
		cpuUsagePercent = 100 * float64(current.CPUNano-previous.CPUNano) /
			float64(current.SystemNano-previous.SystemNano)
		cpuUsageValid = isFinite(cpuUsagePercent)
	}
	networkReceiveBytes, networkTransmitBytes := current.networkTotals()
	return ResourceStats{
		ContainerID:          container.ID,
		ServiceID:            container.ServiceID,
		DeploymentID:         container.DeploymentID,
		CPUUsagePercent:      cpuUsagePercent,
		CPUUsageValid:        cpuUsageValid,
		MemoryUsagePercent:   current.MemPerc,
		MemoryUsageValid:     isFinite(current.MemPerc),
		MemoryUsedBytes:      float64(current.MemUsage),
		MemoryUsedValid:      true,
		NetworkReceiveBytes:  float64(networkReceiveBytes),
		NetworkTransmitBytes: float64(networkTransmitBytes),
	}
}

func (sample podmanStatsSample) networkTotals() (uint64, uint64) {
	if sample.Network == nil {
		return sample.NetInput, sample.NetOutput
	}

	var receive, transmit uint64
	for _, network := range *sample.Network {
		receive += network.RxBytes
		transmit += network.TxBytes
	}
	return receive, transmit
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
