package container

import (
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestParsePodmanStatsSample(t *testing.T) {
	sample, err := parsePodmanStatsSample("abcdef123456\t1000000000\t2000000000\t64MiB / 512MiB\t12.50%\t1.5MB / 2.5MB")
	if err != nil {
		t.Fatalf("parse sample: %v", err)
	}
	if sample.containerID != "abcdef123456" || sample.cpuNano != 1_000_000_000 || sample.systemNano != 2_000_000_000 || !sample.cpuCountersValid {
		t.Fatalf("unexpected sample: %#v", sample)
	}
}

func TestParsePodmanStatsSamplesSkipsMalformedRows(t *testing.T) {
	containerID := strings.Repeat("e", 64)
	samples, err := parsePodmanStatsSamples([]byte("malformed\n" + statsLine(containerID, 100, 1000)))
	if err != nil {
		t.Fatalf("parse samples: %v", err)
	}
	if len(samples) != 1 || samples[0].containerID != containerID {
		t.Fatalf("expected valid row to survive malformed peer, got %+v", samples)
	}
}

func TestResourceStatsFromSamplesUsesRecentCPUInterval(t *testing.T) {
	container := Container{ID: "container-1", ServiceID: "service-1", DeploymentID: "deployment-1"}
	previous := podmanStatsSample{cpuNano: 1_000_000_000, systemNano: 10_000_000_000, cpuCountersValid: true}
	current := podmanStatsSample{
		cpuNano:            1_500_000_000,
		systemNano:         11_000_000_000,
		cpuCountersValid:   true,
		memoryUsage:        "64MiB / 512MiB",
		memoryUsagePercent: "12.50%",
		networkIO:          "1.5MB / 2.5MB",
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
	if stats.NetworkReceiveBytes != 1.5*1000*1000 || stats.NetworkTransmitBytes != 2.5*1000*1000 {
		t.Fatalf("network stats = %f/%f", stats.NetworkReceiveBytes, stats.NetworkTransmitBytes)
	}
}

func TestResourceStatsFromSamplesKeepsInvalidValuesMissing(t *testing.T) {
	container := Container{ID: "container-1", ServiceID: "service-1", DeploymentID: "deployment-1"}
	stats := resourceStatsFromSamples(container,
		podmanStatsSample{cpuNano: 2, systemNano: 2, cpuCountersValid: true},
		podmanStatsSample{
			cpuNano:            1,
			systemNano:         3,
			cpuCountersValid:   true,
			memoryUsage:        "-- / 512MiB",
			memoryUsagePercent: "NaN%",
			networkIO:          "-- / --",
		},
	)
	if stats.CPUUsageValid || stats.MemoryUsageValid || stats.MemoryUsedValid {
		t.Fatalf("invalid observations marked valid: %#v", stats)
	}
}

func TestResourceStatsFromSamplesKeepsGenuineZeroValid(t *testing.T) {
	container := Container{ID: "container-1", ServiceID: "service-1", DeploymentID: "deployment-1"}
	stats := resourceStatsFromSamples(container,
		podmanStatsSample{cpuNano: 1, systemNano: 1, cpuCountersValid: true},
		podmanStatsSample{
			cpuNano:            1,
			systemNano:         2,
			cpuCountersValid:   true,
			memoryUsage:        "0B / 512MiB",
			memoryUsagePercent: "0%",
		},
	)
	if !stats.CPUUsageValid || !stats.MemoryUsageValid || !stats.MemoryUsedValid {
		t.Fatalf("zero observations marked invalid: %#v", stats)
	}
}

func TestParseByteQuantity(t *testing.T) {
	tests := map[string]float64{
		"42B":    42,
		"1 kB":   1000,
		"1KiB":   1024,
		"1.5GB":  1.5 * 1000 * 1000 * 1000,
		"2 MiB":  2 * 1024 * 1024,
		"--":     0,
		"broken": 0,
	}

	for input, expected := range tests {
		if actual := parseByteQuantity(input); actual != expected {
			t.Fatalf("%q = %f, want %f", input, actual, expected)
		}
	}
}

func TestCollectResourceStatsUsesCounterDeltas(t *testing.T) {
	statsOutput := installFakeStatsPodman(t, []string{strings.Repeat("a", 64)})
	resetPreviousResourceSamples(t)
	containerID := strings.Repeat("a", 64)

	writeStatsOutput(t, statsOutput, statsLine(containerID, 1_000_000_000, 10_000_000_000))
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

	writeStatsOutput(t, statsOutput, statsLine(containerID, 2_000_000_000, 12_000_000_000))
	second, err := CollectResourceStats()
	if err != nil {
		t.Fatalf("second collection failed: %v", err)
	}
	if !second[0].CPUUsageValid || second[0].CPUUsagePercent != 50 {
		t.Fatalf("expected 50%% CPU from counter delta, got %+v", second[0])
	}
}

func TestCollectResourceStatsRejectsInvalidCounterDeltas(t *testing.T) {
	statsOutput := installFakeStatsPodman(t, []string{strings.Repeat("b", 64)})
	containerID := strings.Repeat("b", 64)
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
			writeStatsOutput(t, statsOutput, statsLine(containerID, tt.firstCPU, tt.firstTime))
			if _, err := CollectResourceStats(); err != nil {
				t.Fatalf("first collection failed: %v", err)
			}
			writeStatsOutput(t, statsOutput, statsLine(containerID, tt.secondCPU, tt.secondTime))
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
	statsOutput := installFakeStatsPodman(t, []string{firstID, missingID})
	resetPreviousResourceSamples(t)

	writeStatsOutput(t, statsOutput, statsLine(firstID, 100, 1000)+statsLine(missingID, 100, 1000))
	if _, err := CollectResourceStats(); err != nil {
		t.Fatalf("first collection failed: %v", err)
	}

	failPath := statsOutput + ".fail"
	if err := os.WriteFile(failPath, nil, 0o600); err != nil {
		t.Fatalf("create failure marker: %v", err)
	}
	if _, err := CollectResourceStats(); err == nil {
		t.Fatal("expected Podman failure")
	}
	if err := os.Remove(failPath); err != nil {
		t.Fatalf("remove failure marker: %v", err)
	}

	writeStatsOutput(t, statsOutput, statsLine(firstID, 300, 2000))
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

	writeContainersOutput(t, filepath.Join(filepath.Dir(statsOutput), "containers-output"), []string{firstID})
	writeStatsOutput(t, statsOutput, statsLine(firstID, 400, 3000))
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

func installFakeStatsPodman(t *testing.T, containerIDs []string) string {
	t.Helper()
	dir := t.TempDir()
	statsOutput := filepath.Join(dir, "stats-output")
	containersOutput := filepath.Join(dir, "containers-output")
	script := `#!/bin/sh
if [ "$1" = "ps" ]; then
  cat "$PODMAN_CONTAINERS_OUTPUT"
elif [ -f "$PODMAN_STATS_OUTPUT.fail" ]; then
  exit 1
else
  cat "$PODMAN_STATS_OUTPUT"
fi
`
	if err := os.WriteFile(filepath.Join(dir, "podman"), []byte(script), 0o700); err != nil {
		t.Fatalf("write fake podman: %v", err)
	}
	writeContainersOutput(t, containersOutput, containerIDs)
	t.Setenv("PODMAN_STATS_OUTPUT", statsOutput)
	t.Setenv("PODMAN_CONTAINERS_OUTPUT", containersOutput)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return statsOutput
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

func writeStatsOutput(t *testing.T, path, output string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(output), 0o600); err != nil {
		t.Fatalf("write stats output: %v", err)
	}
}

func statsLine(containerID string, cpuNano, systemNano uint64) string {
	return containerID + "\t" + strconv.FormatUint(cpuNano, 10) + "\t" + strconv.FormatUint(systemNano, 10) + "\t100 MB / 1 GB\t10%\t1 MB / 2 MB\n"
}
