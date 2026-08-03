package container

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResourceStatsFromSamplesUsesRecentCPUInterval(t *testing.T) {
	container := Container{ID: "container-1", ServiceID: "service-1", DeploymentID: "deployment-1"}
	previous := podmanStatsSample{CPUNano: 1_000_000_000, SystemNano: 10_000_000_000}
	current := podmanStatsSample{
		CPUNano:    1_500_000_000,
		SystemNano: 11_000_000_000,
		MemUsage:   64 * 1024 * 1024,
		MemPerc:    12.5,
		NetInput:   1_500_000,
		NetOutput:  2_500_000,
	}

	stats := resourceStatsFromSamples(container, previous, current)
	if !stats.CPUUsageValid || math.Abs(stats.CPUUsagePercent-50) > 0.001 {
		t.Fatalf("CPU stats = %f, valid=%v", stats.CPUUsagePercent, stats.CPUUsageValid)
	}
	if !stats.MemoryUsedValid || stats.MemoryUsedBytes != 64*1024*1024 {
		t.Fatalf("memory bytes = %f, valid=%v", stats.MemoryUsedBytes, stats.MemoryUsedValid)
	}
	if !stats.MemoryUsageValid || stats.MemoryUsagePercent != 12.5 {
		t.Fatalf("memory percent = %f, valid=%v", stats.MemoryUsagePercent, stats.MemoryUsageValid)
	}
	if stats.NetworkReceiveBytes != 1_500_000 || stats.NetworkTransmitBytes != 2_500_000 {
		t.Fatalf("network stats = %f/%f", stats.NetworkReceiveBytes, stats.NetworkTransmitBytes)
	}
}

func TestResourceStatsFromSamplesKeepsGenuineZeroValid(t *testing.T) {
	container := Container{ID: "container-1", ServiceID: "service-1", DeploymentID: "deployment-1"}
	stats := resourceStatsFromSamples(container,
		podmanStatsSample{CPUNano: 1, SystemNano: 1},
		podmanStatsSample{
			CPUNano:    1,
			SystemNano: 2,
			MemUsage:   0,
			MemPerc:    0,
		},
	)
	if !stats.CPUUsageValid || !stats.MemoryUsageValid || !stats.MemoryUsedValid {
		t.Fatalf("zero observations marked invalid: %#v", stats)
	}
}

func TestFetchPodmanStatsUsesVersionedEndpointAndContainerIDs(t *testing.T) {
	containerIDs := []string{strings.Repeat("a", 64), strings.Repeat("b", 64)}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v4.0.0/libpod/containers/stats" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.URL.Query().Get("stream") != "false" {
			t.Errorf("stream = %q", r.URL.Query().Get("stream"))
		}
		if got := r.URL.Query()["containers"]; len(got) != 2 || got[0] != containerIDs[0] || got[1] != containerIDs[1] {
			t.Errorf("containers = %#v", got)
		}
		writeStatsReport(t, w, []podmanStatsSample{{ContainerID: containerIDs[0], CPUNano: 100, SystemNano: 1_000}})
	}))
	defer server.Close()

	samples, err := fetchPodmanStats(t.Context(), server.Client(), server.URL+"/v4.0.0/libpod/containers/stats", containerIDs)
	if err != nil {
		t.Fatalf("fetch stats: %v", err)
	}
	if len(samples) != 1 || samples[0].ContainerID != containerIDs[0] {
		t.Fatalf("samples = %#v", samples)
	}
}

func TestFetchPodmanStatsDecodesPodmanNetworkShapes(t *testing.T) {
	tests := []struct {
		name         string
		body         string
		wantReceive  uint64
		wantTransmit uint64
	}{
		{
			name:         "Podman 4 aggregate fields",
			body:         `{"Error":null,"Stats":[{"ContainerID":"container","NetInput":100,"NetOutput":200}]}`,
			wantReceive:  100,
			wantTransmit: 200,
		},
		{
			name:         "Podman 5 per-interface fields",
			body:         `{"Error":null,"Stats":[{"ContainerID":"container","Network":{"eth0":{"RxBytes":100,"TxBytes":200},"eth1":{"RxBytes":30,"TxBytes":40}}}]}`,
			wantReceive:  130,
			wantTransmit: 240,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()

			samples, err := fetchPodmanStats(t.Context(), server.Client(), server.URL, []string{"container"})
			if err != nil {
				t.Fatalf("fetch stats: %v", err)
			}
			receive, transmit := samples[0].networkTotals()
			if receive != tt.wantReceive || transmit != tt.wantTransmit {
				t.Fatalf("network totals = %d/%d, want %d/%d", receive, transmit, tt.wantReceive, tt.wantTransmit)
			}
		})
	}
}

func TestFetchPodmanStatsRejectsInvalidResponses(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
	}{
		{name: "HTTP error", status: http.StatusInternalServerError, body: `{"cause":"failed"}`},
		{name: "malformed JSON", status: http.StatusOK, body: `{`},
		{name: "in-band error", status: http.StatusOK, body: `{"Error":{},"Stats":null}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()

			if _, err := fetchPodmanStats(t.Context(), server.Client(), server.URL, []string{"container"}); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestCollectResourceStatsUsesCounterDeltas(t *testing.T) {
	containerID := strings.Repeat("a", 64)
	api := installFakeStatsEnvironment(t, []string{containerID})
	resetPreviousResourceSamples(t)

	api.setSamples(t, statsSample(containerID, 1_000_000_000, 10_000_000_000))
	first, err := CollectResourceStats()
	if err != nil {
		t.Fatalf("first collection failed: %v", err)
	}
	if len(first) != 1 {
		t.Fatalf("expected one stat, got %d", len(first))
	}
	if first[0].CPUUsageValid {
		t.Fatal("expected first CPU sample to be invalid without a baseline")
	}
	if !first[0].MemoryUsageValid || !first[0].MemoryUsedValid {
		t.Fatal("expected memory values to remain valid on first sample")
	}

	api.setSamples(t, statsSample(containerID, 2_000_000_000, 12_000_000_000))
	second, err := CollectResourceStats()
	if err != nil {
		t.Fatalf("second collection failed: %v", err)
	}
	if !second[0].CPUUsageValid || second[0].CPUUsagePercent != 50 {
		t.Fatalf("expected 50%% CPU from counter delta, got %+v", second[0])
	}
}

func TestCollectResourceStatsRejectsInvalidCounterDeltas(t *testing.T) {
	containerID := strings.Repeat("b", 64)
	api := installFakeStatsEnvironment(t, []string{containerID})
	tests := []struct {
		name       string
		firstCPU   uint64
		firstTime  uint64
		secondCPU  uint64
		secondTime uint64
	}{
		{name: "CPU counter reset", firstCPU: 200, firstTime: 2000, secondCPU: 100, secondTime: 3000},
		{name: "system counter unchanged", firstCPU: 100, firstTime: 2000, secondCPU: 200, secondTime: 2000},
		{name: "system counter reset", firstCPU: 100, firstTime: 2000, secondCPU: 200, secondTime: 1000},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetPreviousResourceSamples(t)
			api.setSamples(t, statsSample(containerID, tt.firstCPU, tt.firstTime))
			if _, err := CollectResourceStats(); err != nil {
				t.Fatalf("first collection failed: %v", err)
			}
			api.setSamples(t, statsSample(containerID, tt.secondCPU, tt.secondTime))
			stats, err := CollectResourceStats()
			if err != nil {
				t.Fatalf("second collection failed: %v", err)
			}
			if stats[0].CPUUsageValid {
				t.Fatal("expected invalid CPU sample")
			}
		})
	}
}

func TestCollectResourceStatsPreservesBaselinesAndPrunesStoppedContainers(t *testing.T) {
	firstID := strings.Repeat("c", 64)
	missingID := strings.Repeat("d", 64)
	api := installFakeStatsEnvironment(t, []string{firstID, missingID})
	resetPreviousResourceSamples(t)

	api.setSamples(t, statsSample(firstID, 100, 1000), statsSample(missingID, 100, 1000))
	if _, err := CollectResourceStats(); err != nil {
		t.Fatalf("first collection failed: %v", err)
	}

	api.status = http.StatusInternalServerError
	if _, err := CollectResourceStats(); err == nil {
		t.Fatal("expected Podman failure")
	}

	api.status = http.StatusOK
	api.setSamples(t, statsSample(firstID, 300, 2000))
	stats, err := CollectResourceStats()
	if err != nil {
		t.Fatalf("collection after failure failed: %v", err)
	}
	if !stats[0].CPUUsageValid || stats[0].CPUUsagePercent != 20 {
		t.Fatalf("expected preserved baseline to produce 20%% CPU, got %+v", stats[0])
	}

	previousResourceSamples.Lock()
	_, retained := previousResourceSamples.byContainer[firstID]
	_, missingRetained := previousResourceSamples.byContainer[missingID]
	previousResourceSamples.Unlock()
	if !retained || !missingRetained {
		t.Fatalf("expected baselines for running containers to survive partial output: retained=%v missingRetained=%v", retained, missingRetained)
	}

	writeContainersOutput(t, api.containersOutput, []string{firstID})
	api.setSamples(t, statsSample(firstID, 400, 3000))
	if _, err := CollectResourceStats(); err != nil {
		t.Fatalf("collection after container removal failed: %v", err)
	}
	previousResourceSamples.Lock()
	_, stoppedRetained := previousResourceSamples.byContainer[missingID]
	previousResourceSamples.Unlock()
	if stoppedRetained {
		t.Fatal("expected stopped container baseline to be pruned")
	}
}

type fakeStatsAPI struct {
	server           *httptest.Server
	status           int
	body             []byte
	containersOutput string
}

func installFakeStatsEnvironment(t *testing.T, containerIDs []string) *fakeStatsAPI {
	t.Helper()
	dir := t.TempDir()
	containersOutput := filepath.Join(dir, "containers-output")
	script := `#!/bin/sh
if [ "$1" = "ps" ]; then
  cat "$PODMAN_CONTAINERS_OUTPUT"
else
  exit 1
fi
`
	if err := os.WriteFile(filepath.Join(dir, "podman"), []byte(script), 0o700); err != nil {
		t.Fatalf("write fake podman: %v", err)
	}
	writeContainersOutput(t, containersOutput, containerIDs)
	t.Setenv("PODMAN_CONTAINERS_OUTPUT", containersOutput)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	api := &fakeStatsAPI{status: http.StatusOK, containersOutput: containersOutput}
	api.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(api.status)
		_, _ = w.Write(api.body)
	}))
	previousClient := podmanStatsClient
	previousURL := podmanStatsURL
	podmanStatsClient = api.server.Client()
	podmanStatsURL = api.server.URL
	t.Cleanup(func() {
		podmanStatsClient = previousClient
		podmanStatsURL = previousURL
		api.server.Close()
	})
	return api
}

func (api *fakeStatsAPI) setSamples(t *testing.T, samples ...podmanStatsSample) {
	t.Helper()
	data, err := json.Marshal(podmanStatsReport{Stats: samples})
	if err != nil {
		t.Fatalf("marshal stats report: %v", err)
	}
	api.body = data
}

func writeStatsReport(t *testing.T, w http.ResponseWriter, samples []podmanStatsSample) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(podmanStatsReport{Stats: samples}); err != nil {
		t.Fatalf("encode stats report: %v", err)
	}
}

func writeContainersOutput(t *testing.T, path string, containerIDs []string) {
	t.Helper()
	containersJSON := "["
	for i, containerID := range containerIDs {
		if i > 0 {
			containersJSON += ","
		}
		containersJSON += "{\"Id\":\"" + containerID + "\",\"Names\":[\"test\"],\"State\":\"running\",\"Labels\":{\"techulus.service.id\":\"service-1\",\"techulus.deployment.id\":\"deployment-1\"}}"
	}
	containersJSON += "]"
	if err := os.WriteFile(path, []byte(containersJSON), 0o600); err != nil {
		t.Fatalf("write fake containers: %v", err)
	}
}

func resetPreviousResourceSamples(t *testing.T) {
	t.Helper()
	previousResourceSamples.Lock()
	previousResourceSamples.byContainer = make(map[string]podmanStatsSample)
	previousResourceSamples.Unlock()
	t.Cleanup(func() {
		previousResourceSamples.Lock()
		previousResourceSamples.byContainer = make(map[string]podmanStatsSample)
		previousResourceSamples.Unlock()
	})
}

func statsSample(containerID string, cpuNano, systemNano uint64) podmanStatsSample {
	return podmanStatsSample{
		ContainerID: containerID,
		CPUNano:     cpuNano,
		SystemNano:  systemNano,
		MemUsage:    100_000_000,
		MemPerc:     10,
		NetInput:    1_000_000,
		NetOutput:   2_000_000,
	}
}
