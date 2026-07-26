package agent

import (
	"context"
	"testing"
	"time"
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

func TestPollContainerHealthIsBounded(t *testing.T) {
	started := time.Now()
	status := pollContainerHealth(context.Background(), "container-1", time.Millisecond, 10*time.Millisecond, func(context.Context, string) string {
		return "starting"
	})

	if status != "" {
		t.Fatalf("status = %q, want no terminal status", status)
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("poll exceeded deadline: %s", elapsed)
	}
}

func TestClaimHealthMonitorDeduplicatesContainerID(t *testing.T) {
	agent := &Agent{runContext: context.Background()}

	if _, ok := agent.claimHealthMonitor("container-1"); !ok {
		t.Fatal("first monitor claim was rejected")
	}
	if _, ok := agent.claimHealthMonitor("container-1"); ok {
		t.Fatal("duplicate monitor claim was accepted")
	}
	if _, ok := agent.claimHealthMonitor("container-2"); !ok {
		t.Fatal("different container ID was rejected")
	}
}
