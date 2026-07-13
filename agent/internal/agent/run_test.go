package agent

import (
	"context"
	"testing"
)

func TestRetryStartupStatusIsBounded(t *testing.T) {
	attempts := 0
	reported := retryStartupStatus(context.Background(), 3, 0, func() bool {
		attempts++
		return false
	})

	if reported {
		t.Fatal("expected startup reporting to fall through to cached state")
	}
	if attempts != 3 {
		t.Fatalf("attempts = %d, want 3", attempts)
	}
}

func TestRetryStartupStatusStopsAfterSuccess(t *testing.T) {
	attempts := 0
	reported := retryStartupStatus(context.Background(), 3, 0, func() bool {
		attempts++
		return attempts == 2
	})

	if !reported {
		t.Fatal("expected startup reporting to succeed")
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
}
