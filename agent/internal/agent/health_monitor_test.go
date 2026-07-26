package agent

import (
	"context"
	"testing"
	"time"

	agenthttp "techulus/cloud-agent/internal/http"
)

func TestPollContainerHealthStopsAtTerminalState(t *testing.T) {
	calls := 0
	status := pollContainerHealth(context.Background(), "container-1", time.Millisecond, time.Second, func(context.Context, string) string {
		calls++
		if calls < 3 {
			return "starting"
		}
		return "healthy"
	})

	if status != "healthy" || calls != 3 {
		t.Fatalf("status = %q, calls = %d; want healthy after 3 calls", status, calls)
	}
}

func TestMonitorContainerHealthDeduplicatesContainerID(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	agent := &Agent{
		runContext:     ctx,
		healthMonitors: map[string]struct{}{},
	}
	expected := agenthttp.ExpectedContainer{HealthCheck: &agenthttp.HealthCheck{Cmd: "true"}}

	agent.monitorContainerHealth("container-1", expected)
	agent.monitorContainerHealth("container-1", expected)
	agent.monitorContainerHealth("container-2", expected)

	agent.healthMonitorMutex.Lock()
	defer agent.healthMonitorMutex.Unlock()
	if len(agent.healthMonitors) != 2 {
		t.Fatalf("active monitors = %d, want one per container ID", len(agent.healthMonitors))
	}
}
