package logs

import (
	"context"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

type AgentLogWriter struct {
	serverId string
	sender   *VictoriaLogsSender
	buffer   []AgentLog
	mu       sync.Mutex
	stdout   io.Writer
}

func NewAgentLogWriter(serverId string, sender *VictoriaLogsSender) *AgentLogWriter {
	return &AgentLogWriter{
		serverId: serverId,
		sender:   sender,
		stdout:   os.Stdout,
		buffer:   make([]AgentLog, 0, 100),
	}
}

func (w *AgentLogWriter) Write(p []byte) (n int, err error) {
	w.stdout.Write(p)

	msg := strings.TrimSpace(string(p))
	if msg == "" {
		return len(p), nil
	}

	level := detectLogLevel(msg)

	w.mu.Lock()
	w.buffer = append(w.buffer, AgentLog{
		ServerID:  w.serverId,
		Message:   msg,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Level:     level,
		LogType:   "agent",
	})
	w.mu.Unlock()

	return len(p), nil
}

func detectLogLevel(msg string) string {
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "error") || strings.Contains(lower, "failed") {
		return "error"
	}
	if strings.Contains(lower, "warn") {
		return "warn"
	}
	return "info"
}

func (w *AgentLogWriter) Flush() error {
	w.mu.Lock()
	if len(w.buffer) == 0 {
		w.mu.Unlock()
		return nil
	}
	logs := make([]AgentLog, len(w.buffer))
	copy(logs, w.buffer)
	w.mu.Unlock()

	err := w.sender.SendAgentLogs(logs)
	if err != nil {
		return err
	}

	w.mu.Lock()
	w.buffer = w.buffer[len(logs):]
	w.mu.Unlock()

	return nil
}

func (w *AgentLogWriter) StartFlusher(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})

	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		defer close(done)

		for {
			select {
			case <-ctx.Done():
				w.Flush()
				return
			case <-ticker.C:
				w.Flush()
			}
		}
	}()

	return done
}
