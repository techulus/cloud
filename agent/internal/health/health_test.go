package health

import (
	"testing"

	"github.com/shirou/gopsutil/v3/cpu"
)

func TestCalculateAgentCPUUsagePercentNormalizesByCPUCount(t *testing.T) {
	previous := &cpu.TimesStat{User: 10, System: 5}
	current := &cpu.TimesStat{User: 12, System: 7}

	got := calculateAgentCPUUsagePercent(previous, current, 1, 4)
	if got != 100 {
		t.Fatalf("cpu percent = %f, want 100", got)
	}
}

func TestCalculateAgentCPUUsagePercentWarmupOrInvalidInputs(t *testing.T) {
	current := &cpu.TimesStat{User: 12, System: 7}

	tests := map[string]struct {
		previous       *cpu.TimesStat
		current        *cpu.TimesStat
		elapsedSeconds float64
		cpuCount       int
	}{
		"missing previous sample": {
			previous:       nil,
			current:        current,
			elapsedSeconds: 1,
			cpuCount:       4,
		},
		"missing current sample": {
			previous:       &cpu.TimesStat{User: 10, System: 5},
			current:        nil,
			elapsedSeconds: 1,
			cpuCount:       4,
		},
		"zero elapsed": {
			previous:       &cpu.TimesStat{User: 10, System: 5},
			current:        current,
			elapsedSeconds: 0,
			cpuCount:       4,
		},
		"negative counter delta": {
			previous:       current,
			current:        &cpu.TimesStat{User: 10, System: 5},
			elapsedSeconds: 1,
			cpuCount:       4,
		},
	}

	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			got := calculateAgentCPUUsagePercent(
				test.previous,
				test.current,
				test.elapsedSeconds,
				test.cpuCount,
			)
			if got != 0 {
				t.Fatalf("cpu percent = %f, want 0", got)
			}
		})
	}
}
