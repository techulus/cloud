package serverless

import (
	"context"
	"errors"
	"testing"
)

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
