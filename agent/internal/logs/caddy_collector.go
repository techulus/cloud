package logs

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"sync"
	"time"
)

const (
	caddyLogPath         = "/var/log/caddy/techulus.log"
	caddyFlushInterval   = 5 * time.Second
	caddyMaxBatchSize    = 500
	caddyMaxQueueSize    = 5000
	caddyPollInterval    = 500 * time.Millisecond
)

type CaddyLogEntry struct {
	Level     string       `json:"level"`
	Ts        float64      `json:"ts"`
	Logger    string       `json:"logger"`
	Msg       string       `json:"msg"`
	Request   CaddyRequest `json:"request"`
	Duration  float64      `json:"duration"`
	Status    int          `json:"status"`
	Size      int          `json:"size"`
	ServiceId string       `json:"service_id"`
}

type CaddyRequest struct {
	RemoteIP   string `json:"remote_ip"`
	RemotePort string `json:"remote_port"`
	ClientIP   string `json:"client_ip"`
	Proto      string `json:"proto"`
	Method     string `json:"method"`
	Host       string `json:"host"`
	URI        string `json:"uri"`
}

type HTTPLogEntry struct {
	ServiceId  string  `json:"service_id"`
	Host       string  `json:"host"`
	Method     string  `json:"method"`
	Path       string  `json:"path"`
	Status     int     `json:"status"`
	Duration   float64 `json:"duration_ms"`
	Size       int     `json:"size"`
	ClientIP   string  `json:"client_ip"`
	Timestamp  string  `json:"timestamp"`
}

type HTTPLogSender interface {
	SendHTTPLogs(logs []HTTPLogEntry) error
}

type CaddyCollector struct {
	sender       HTTPLogSender
	queue        []HTTPLogEntry
	queueMu      sync.Mutex
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	lastPos      int64
	droppedCount int
}

func NewCaddyCollector(sender HTTPLogSender) *CaddyCollector {
	ctx, cancel := context.WithCancel(context.Background())
	return &CaddyCollector{
		sender: sender,
		queue:  make([]HTTPLogEntry, 0, caddyMaxBatchSize),
		ctx:    ctx,
		cancel: cancel,
	}
}

func (c *CaddyCollector) Start() {
	c.wg.Add(2)
	go c.tailLoop()
	go c.flushLoop()
}

func (c *CaddyCollector) tailLoop() {
	defer c.wg.Done()

	for {
		select {
		case <-c.ctx.Done():
			return
		default:
		}

		if err := c.tailFile(); err != nil {
			if !os.IsNotExist(err) {
				log.Printf("[caddy-logs] error tailing file: %v", err)
			}
			select {
			case <-c.ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
		}
	}
}

func (c *CaddyCollector) tailFile() error {
	file, err := os.Open(caddyLogPath)
	if err != nil {
		return err
	}
	defer file.Close()

	if c.lastPos == 0 {
		log.Printf("[caddy-logs] started tailing %s", caddyLogPath)
	}

	stat, err := file.Stat()
	if err != nil {
		return err
	}

	if stat.Size() < c.lastPos {
		c.lastPos = 0
	}

	if c.lastPos > 0 {
		_, err = file.Seek(c.lastPos, io.SeekStart)
		if err != nil {
			return err
		}
	}

	reader := bufio.NewReader(file)

	for {
		select {
		case <-c.ctx.Done():
			return nil
		default:
		}

		line, err := reader.ReadBytes('\n')
		if err != nil {
			if err == io.EOF {
				pos, _ := file.Seek(0, io.SeekCurrent)
				c.lastPos = pos

				select {
				case <-c.ctx.Done():
					return nil
				case <-time.After(caddyPollInterval):
				}

				newStat, err := file.Stat()
				if err != nil {
					return err
				}
				if newStat.Size() < c.lastPos {
					return nil
				}
				continue
			}
			return err
		}

		c.processLine(line)
	}
}

func (c *CaddyCollector) processLine(line []byte) {
	var entry CaddyLogEntry
	if err := json.Unmarshal(line, &entry); err != nil {
		log.Printf("[caddy-logs] failed to parse line: %v", err)
		return
	}

	if entry.Msg != "handled request" || entry.Request.Host == "" {
		return
	}

	timestamp := time.Unix(int64(entry.Ts), int64((entry.Ts-float64(int64(entry.Ts)))*1e9))

	httpEntry := HTTPLogEntry{
		ServiceId: entry.ServiceId,
		Host:      entry.Request.Host,
		Method:    entry.Request.Method,
		Path:      entry.Request.URI,
		Status:    entry.Status,
		Duration:  entry.Duration * 1000,
		Size:      entry.Size,
		ClientIP:  entry.Request.ClientIP,
		Timestamp: timestamp.Format(time.RFC3339Nano),
	}

	c.enqueue(httpEntry)
}

func (c *CaddyCollector) enqueue(entry HTTPLogEntry) {
	c.queueMu.Lock()
	defer c.queueMu.Unlock()

	if len(c.queue) >= caddyMaxQueueSize {
		c.droppedCount++
		if c.droppedCount%100 == 1 {
			log.Printf("[caddy-logs] dropping logs due to queue overflow (total dropped: %d)", c.droppedCount)
		}
		return
	}

	c.queue = append(c.queue, entry)

	if len(c.queue) >= caddyMaxBatchSize {
		c.flushLocked()
	}
}

func (c *CaddyCollector) flushLoop() {
	defer c.wg.Done()
	ticker := time.NewTicker(caddyFlushInterval)
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

func (c *CaddyCollector) flush() {
	c.queueMu.Lock()
	defer c.queueMu.Unlock()
	c.flushLocked()
}

func (c *CaddyCollector) flushLocked() {
	if len(c.queue) == 0 {
		return
	}

	batch := make([]HTTPLogEntry, len(c.queue))
	copy(batch, c.queue)
	c.queue = c.queue[:0]

	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		if err := c.sendWithRetry(batch); err != nil {
			log.Printf("[caddy-logs] failed to send batch of %d logs: %v", len(batch), err)
		}
	}()
}

func (c *CaddyCollector) sendWithRetry(batch []HTTPLogEntry) error {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if err := c.sender.SendHTTPLogs(batch); err != nil {
			lastErr = err
			time.Sleep(time.Duration(attempt+1) * time.Second)
			continue
		}
		return nil
	}
	log.Printf("[caddy-logs] dropped batch of %d logs after 3 attempts", len(batch))
	return lastErr
}

func (c *CaddyCollector) Stop() {
	c.cancel()
	c.flush()
	c.wg.Wait()
}
