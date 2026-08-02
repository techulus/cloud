package container

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"log"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
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
	containerID        string
	cpuNano            uint64
	systemNano         uint64
	cpuCountersValid   bool
	memoryUsage        string
	memoryUsagePercent string
	networkIO          string
}

const podmanStatsFormat = "{{.ContainerID}}\t{{.CPUNano}}\t{{.SystemNano}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}"

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
	args := []string{
		"stats",
		"--no-stream",
		"--no-trunc",
		"--format", podmanStatsFormat,
	}
	for _, c := range containers {
		if c.State != "running" || c.ServiceID == "" || c.DeploymentID == "" {
			continue
		}
		running = append(running, c)
		args = append(args, c.ID)
	}
	if len(running) == 0 {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "podman", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to collect container stats: %s: %w", stderr.String(), err)
	}
	samples, err := parsePodmanStatsSamples(output)
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
		container := findStatsContainerByID(sample.containerID, running)
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

func parsePodmanStatsSamples(output []byte) ([]podmanStatsSample, error) {
	samples := make([]podmanStatsSample, 0)
	skipped := 0
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		sample, err := parsePodmanStatsSample(scanner.Text())
		if err != nil {
			skipped++
			continue
		}
		samples = append(samples, sample)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("failed to read container stats: %w", err)
	}
	if skipped > 0 {
		log.Printf("[metrics] skipped %d malformed container stats rows", skipped)
	}
	return samples, nil
}

func parsePodmanStatsSample(line string) (podmanStatsSample, error) {
	parts := strings.Split(line, "\t")
	if len(parts) != 6 {
		return podmanStatsSample{}, fmt.Errorf("failed to parse podman stats row: expected 6 fields, got %d", len(parts))
	}
	cpuNano, cpuErr := strconv.ParseUint(strings.TrimSpace(parts[1]), 10, 64)
	systemNano, systemErr := strconv.ParseUint(strings.TrimSpace(parts[2]), 10, 64)
	return podmanStatsSample{
		containerID:        strings.TrimSpace(parts[0]),
		cpuNano:            cpuNano,
		systemNano:         systemNano,
		cpuCountersValid:   cpuErr == nil && systemErr == nil,
		memoryUsage:        parts[3],
		memoryUsagePercent: parts[4],
		networkIO:          parts[5],
	}, nil
}

func resourceStatsFromSamples(container Container, previous, current podmanStatsSample) ResourceStats {
	cpuUsagePercent := 0.0
	// Podman SystemNano is a wall-clock timestamp, so CPU nanoseconds divided
	// by its delta yields used cores; the metrics sender converts percent to cores.
	cpuUsageValid :=
		previous.cpuCountersValid &&
			current.cpuCountersValid &&
			current.cpuNano >= previous.cpuNano &&
			current.systemNano > previous.systemNano
	if cpuUsageValid {
		cpuUsagePercent = 100 * float64(current.cpuNano-previous.cpuNano) /
			float64(current.systemNano-previous.systemNano)
		cpuUsageValid = isFinite(cpuUsagePercent)
	}
	memoryUsagePercent, memoryUsageValid := parsePercent(current.memoryUsagePercent)
	memoryUsedBytes, memoryUsedValid := parseMemUsed(current.memoryUsage)
	rx, tx := parseNetIO(current.networkIO)
	return ResourceStats{
		ContainerID:          container.ID,
		ServiceID:            container.ServiceID,
		DeploymentID:         container.DeploymentID,
		CPUUsagePercent:      cpuUsagePercent,
		CPUUsageValid:        cpuUsageValid,
		MemoryUsagePercent:   memoryUsagePercent,
		MemoryUsageValid:     memoryUsageValid,
		MemoryUsedBytes:      memoryUsedBytes,
		MemoryUsedValid:      memoryUsedValid,
		NetworkReceiveBytes:  rx,
		NetworkTransmitBytes: tx,
	}
}

func parsePercent(value string) (float64, bool) {
	value = strings.TrimSpace(strings.TrimSuffix(value, "%"))
	if value == "" || value == "--" {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || !isFinite(parsed) {
		return 0, false
	}
	return parsed, true
}

func parseMemUsed(value string) (float64, bool) {
	parts := strings.Split(value, "/")
	if len(parts) == 0 {
		return 0, false
	}
	return parseByteQuantityValue(parts[0])
}

func parseNetIO(value string) (float64, float64) {
	parts := strings.Split(value, "/")
	if len(parts) != 2 {
		return 0, 0
	}
	rx, _ := parseByteQuantityValue(parts[0])
	tx, _ := parseByteQuantityValue(parts[1])
	return rx, tx
}

func parseByteQuantity(value string) float64 {
	parsed, _ := parseByteQuantityValue(value)
	return parsed
}

func parseByteQuantityValue(value string) (float64, bool) {
	value = strings.TrimSpace(value)
	if value == "" || value == "--" {
		return 0, false
	}

	compact := strings.ReplaceAll(value, " ", "")
	splitAt := len(compact)
	for i, r := range compact {
		if !(unicode.IsDigit(r) || r == '.' || r == '-') {
			splitAt = i
			break
		}
	}

	numberText := compact[:splitAt]
	unit := strings.ToLower(compact[splitAt:])
	parsed, err := strconv.ParseFloat(numberText, 64)
	if err != nil || !isFinite(parsed) {
		return 0, false
	}

	switch unit {
	case "", "b":
		return parsed, true
	case "kb", "k", "kib", "ki":
		return parsed * unitMultiplier(unit, 1), true
	case "mb", "m", "mib", "mi":
		return parsed * unitMultiplier(unit, 2), true
	case "gb", "g", "gib", "gi":
		return parsed * unitMultiplier(unit, 3), true
	case "tb", "t", "tib", "ti":
		return parsed * unitMultiplier(unit, 4), true
	default:
		return 0, false
	}
}

func unitMultiplier(unit string, power float64) float64 {
	base := 1000.0
	if strings.Contains(unit, "i") {
		base = 1024.0
	}
	return math.Pow(base, power)
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
