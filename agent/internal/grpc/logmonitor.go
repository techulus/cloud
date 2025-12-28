package grpc

import (
	"context"
	"log"
	"sync"
	"time"

	"techulus/cloud-agent/internal/podman"
	pb "techulus/cloud-agent/internal/proto"
)

type ContainerLogMonitor struct {
	sendLogEntry  func(entry *pb.LogEntry) error
	activeStreams map[string]context.CancelFunc
	mu            sync.Mutex
	checkInterval time.Duration
	parentCtx     context.Context
}

func NewContainerLogMonitor(sendLogEntry func(entry *pb.LogEntry) error) *ContainerLogMonitor {
	return &ContainerLogMonitor{
		sendLogEntry:  sendLogEntry,
		activeStreams: make(map[string]context.CancelFunc),
		checkInterval: 5 * time.Second,
	}
}

func (m *ContainerLogMonitor) Run(ctx context.Context) {
	m.parentCtx = ctx
	ticker := time.NewTicker(m.checkInterval)
	defer ticker.Stop()

	m.reconcile()

	for {
		select {
		case <-ctx.Done():
			m.stopAll()
			return
		case <-ticker.C:
			m.reconcile()
		}
	}
}

func (m *ContainerLogMonitor) reconcile() {
	containers, err := podman.ListContainers()
	if err != nil {
		log.Printf("[logmonitor] Failed to list containers: %v", err)
		return
	}

	runningContainers := make(map[string]bool)
	for _, c := range containers {
		if c.State == "running" {
			runningContainers[c.ID] = true
		}
	}

	var toStart []string
	var toStop []struct {
		id     string
		cancel context.CancelFunc
	}

	m.mu.Lock()
	for containerID := range runningContainers {
		if _, exists := m.activeStreams[containerID]; !exists {
			toStart = append(toStart, containerID)
		}
	}
	for containerID, cancel := range m.activeStreams {
		if !runningContainers[containerID] {
			toStop = append(toStop, struct {
				id     string
				cancel context.CancelFunc
			}{containerID, cancel})
			delete(m.activeStreams, containerID)
		}
	}
	m.mu.Unlock()

	for _, s := range toStop {
		s.cancel()
		log.Printf("[logmonitor] Stopped streaming for container %s (no longer running)", s.id)
	}

	for _, containerID := range toStart {
		ctx, cancel := context.WithCancel(m.parentCtx)
		m.mu.Lock()
		m.activeStreams[containerID] = cancel
		m.mu.Unlock()
		go m.streamContainerLogs(ctx, containerID)
	}
}

func (m *ContainerLogMonitor) streamContainerLogs(ctx context.Context, containerID string) {
	log.Printf("[logmonitor] Starting log stream for container %s", containerID)

	opts := podman.LogsOptions{
		ContainerID: containerID,
		Follow:      true,
		Tail:        100,
	}

	entryCh := make(chan podman.LogEntry, 100)
	errCh := make(chan error, 1)

	go podman.StreamLogs(ctx, opts, entryCh, errCh)

	for {
		select {
		case <-ctx.Done():
			return

		case entry, ok := <-entryCh:
			if !ok {
				return
			}

			streamType := pb.LogStreamType_LOG_STREAM_TYPE_STDOUT
			if entry.Stream == "stderr" {
				streamType = pb.LogStreamType_LOG_STREAM_TYPE_STDERR
			}

			if err := m.sendLogEntry(&pb.LogEntry{
				StreamType:  streamType,
				Timestamp:   entry.Timestamp.UnixMilli(),
				Message:     entry.Message,
				ContainerId: containerID,
			}); err != nil {
				log.Printf("[logmonitor] Failed to send log entry: %v", err)
				return
			}

		case err := <-errCh:
			if err != nil {
				log.Printf("[logmonitor] Stream error for %s: %v", containerID, err)
			}
			return
		}
	}
}

func (m *ContainerLogMonitor) stopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for containerID, cancel := range m.activeStreams {
		cancel()
		log.Printf("[logmonitor] Stopped streaming for container %s", containerID)
	}
	m.activeStreams = make(map[string]context.CancelFunc)
}
