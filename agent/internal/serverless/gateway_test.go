package serverless

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	agenthttp "techulus/cloud-agent/internal/http"
)

type fakeControlPlaneClient struct {
	mu     sync.Mutex
	events []string
}

func (f *fakeControlPlaneClient) WakeServerlessService(host string) (*agenthttp.ServerlessWakeResult, error) {
	return nil, nil
}

func (f *fakeControlPlaneClient) RecordServerlessActivity(host, event string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, event)
	return nil
}

func (f *fakeControlPlaneClient) snapshotEvents() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.events...)
}

func TestGetUpstreamsReturnsWhenFollowerContextIsCancelled(t *testing.T) {
	g := NewGateway(nil)
	g.wakeCalls["sleepy.example.com"] = &wakeCall{done: make(chan struct{})}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := g.getUpstreams(ctx, "sleepy.example.com")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestActivityIsDebouncedAcrossBusyWindow(t *testing.T) {
	previousDebounce := activityFinishDebounceInterval
	activityFinishDebounceInterval = 20 * time.Millisecond
	t.Cleanup(func() {
		activityFinishDebounceInterval = previousDebounce
	})

	client := &fakeControlPlaneClient{}
	gateway := NewGateway(client)
	if err := gateway.beginActivity("app.example.com"); err != nil {
		t.Fatalf("first beginActivity failed: %v", err)
	}
	if err := gateway.beginActivity("app.example.com"); err != nil {
		t.Fatalf("second beginActivity failed: %v", err)
	}

	gateway.endActivity("app.example.com")
	time.Sleep(2 * activityFinishDebounceInterval)
	expectEvents(t, client.snapshotEvents(), []string{"start"})

	gateway.endActivity("app.example.com")
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		got := client.snapshotEvents()
		if len(got) == 2 {
			expectEvents(t, got, []string{"start", "finish"})
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	expectEvents(t, client.snapshotEvents(), []string{"start", "finish"})
}

func expectEvents(t *testing.T, got []string, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("events = %v, want %v", got, want)
		}
	}
}
