package logs

import (
	"context"
	"log"
	"sync"
	"time"

	"techulus/cloud-agent/internal/podman"
)

const (
	maxBatchSize   = 1000
	flushInterval  = 5 * time.Second
	maxQueueSize   = 10000
	defaultSince   = "1m"
)

type LogEntry struct {
	DeploymentID string
	ServiceID    string
	Stream       string
	Message      string
	Timestamp    string
}

type LogBatch struct {
	Logs []LogEntry
}

type ContainerInfo struct {
	DeploymentID string
	ServiceID    string
	ContainerID  string
}

type LogSender interface {
	SendLogs(batch *LogBatch) error
}

type Collector struct {
	sender       LogSender
	state        *State
	dataDir      string
	queue        []LogEntry
	queueMu      sync.Mutex
	containers   map[string]ContainerInfo
	containersMu sync.RWMutex
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	droppedCount int
}

func NewCollector(sender LogSender, dataDir string) *Collector {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Collector{
		sender:     sender,
		state:      NewState(),
		dataDir:    dataDir,
		queue:      make([]LogEntry, 0, maxBatchSize),
		containers: make(map[string]ContainerInfo),
		ctx:        ctx,
		cancel:     cancel,
	}

	if err := c.state.Load(dataDir); err != nil {
		log.Printf("[logs] failed to load state: %v, starting fresh", err)
	}

	return c
}

func (c *Collector) UpdateContainers(containers []ContainerInfo) {
	c.containersMu.Lock()
	defer c.containersMu.Unlock()

	newContainers := make(map[string]ContainerInfo)
	for _, container := range containers {
		newContainers[container.ContainerID] = container
	}

	for containerID := range c.containers {
		if _, exists := newContainers[containerID]; !exists {
			c.state.RemovePosition(containerID)
		}
	}

	c.containers = newContainers
}

func (c *Collector) Start() {
	c.wg.Add(1)
	go c.flushLoop()
}

func (c *Collector) flushLoop() {
	defer c.wg.Done()
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			c.flush()
		}
	}
}

func (c *Collector) Collect() {
	c.containersMu.RLock()
	containers := make([]ContainerInfo, 0, len(c.containers))
	for _, container := range c.containers {
		containers = append(containers, container)
	}
	c.containersMu.RUnlock()

	for _, container := range containers {
		c.collectFromContainer(container)
	}
}

func (c *Collector) collectFromContainer(container ContainerInfo) {
	since := c.state.GetPosition(container.ContainerID)
	if since == "" {
		since = defaultSince
	}

	entryCh := make(chan podman.LogEntry, 100)
	errCh := make(chan error, 1)

	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()

	go podman.StreamLogs(ctx, podman.LogsOptions{
		ContainerID: container.ContainerID,
		Follow:      false,
		Tail:        -1,
		Since:       since,
	}, entryCh, errCh)

	var lastTimestamp time.Time
	for entry := range entryCh {
		logEntry := LogEntry{
			DeploymentID: container.DeploymentID,
			ServiceID:    container.ServiceID,
			Stream:       entry.Stream,
			Message:      string(entry.Message),
			Timestamp:    entry.Timestamp.Format(time.RFC3339Nano),
		}

		c.enqueue(logEntry)
		lastTimestamp = entry.Timestamp
	}

	if err := <-errCh; err != nil {
		log.Printf("[logs] error streaming from container %s: %v", container.ContainerID[:12], err)
	}

	if !lastTimestamp.IsZero() {
		c.state.SetPosition(container.ContainerID, lastTimestamp.Add(time.Nanosecond).Format(time.RFC3339Nano))
	}
}

func (c *Collector) enqueue(entry LogEntry) {
	c.queueMu.Lock()
	defer c.queueMu.Unlock()

	if len(c.queue) >= maxQueueSize {
		c.droppedCount++
		if c.droppedCount%100 == 1 {
			log.Printf("[logs] dropping logs due to queue overflow (total dropped: %d)", c.droppedCount)
		}
		return
	}

	c.queue = append(c.queue, entry)

	if len(c.queue) >= maxBatchSize {
		c.flushLocked()
	}
}

func (c *Collector) flush() {
	c.queueMu.Lock()
	defer c.queueMu.Unlock()
	c.flushLocked()
}

func (c *Collector) flushLocked() {
	if len(c.queue) == 0 {
		return
	}

	batch := &LogBatch{
		Logs: make([]LogEntry, len(c.queue)),
	}
	copy(batch.Logs, c.queue)
	c.queue = c.queue[:0]

	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		if err := c.sendWithRetry(batch); err != nil {
			log.Printf("[logs] failed to send batch of %d logs: %v", len(batch.Logs), err)
		}
	}()
}

func (c *Collector) sendWithRetry(batch *LogBatch) error {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if err := c.sender.SendLogs(batch); err != nil {
			lastErr = err
			time.Sleep(time.Duration(attempt+1) * time.Second)
			continue
		}
		return nil
	}
	log.Printf("[logs] dropped batch of %d logs after 3 attempts", len(batch.Logs))
	return lastErr
}

func (c *Collector) Stop() {
	c.cancel()

	c.flush()

	c.wg.Wait()

	if err := c.state.Save(c.dataDir); err != nil {
		log.Printf("[logs] failed to save state: %v", err)
	}
}
