package logs

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	traefikLogPath       = "/var/log/traefik/access.log"
	traefikFlushInterval = 5 * time.Second
	traefikMaxBatchSize  = 500
	traefikMaxQueueSize  = 5000
	traefikPollInterval  = 500 * time.Millisecond
)

type HTTPLogEntry struct {
	ServiceId string  `json:"service_id"`
	Host      string  `json:"host"`
	Method    string  `json:"method"`
	Path      string  `json:"path"`
	Status    int     `json:"status"`
	Duration  float64 `json:"duration_ms"`
	Size      int     `json:"size"`
	ClientIP  string  `json:"client_ip"`
	Timestamp string  `json:"timestamp"`
}

type HTTPLogSender interface {
	SendHTTPLogs(logs []HTTPLogEntry) error
}

type TraefikLogEntry struct {
	ClientAddr             string `json:"ClientAddr"`
	ClientHost             string `json:"ClientHost"`
	ClientPort             string `json:"ClientPort"`
	ClientUsername         string `json:"ClientUsername"`
	DownstreamContentSize  int    `json:"DownstreamContentSize"`
	DownstreamStatus       int    `json:"DownstreamStatus"`
	Duration               int64  `json:"Duration"`
	OriginContentSize      int    `json:"OriginContentSize"`
	OriginDuration         int64  `json:"OriginDuration"`
	OriginStatus           int    `json:"OriginStatus"`
	Overhead               int64  `json:"Overhead"`
	RequestAddr            string `json:"RequestAddr"`
	RequestContentSize     int    `json:"RequestContentSize"`
	RequestCount           int    `json:"RequestCount"`
	RequestHost            string `json:"RequestHost"`
	RequestMethod          string `json:"RequestMethod"`
	RequestPath            string `json:"RequestPath"`
	RequestPort            string `json:"RequestPort"`
	RequestProtocol        string `json:"RequestProtocol"`
	RequestScheme          string `json:"RequestScheme"`
	RetryAttempts          int    `json:"RetryAttempts"`
	RouterName             string `json:"RouterName"`
	ServiceAddr            string `json:"ServiceAddr"`
	ServiceName            string `json:"ServiceName"`
	ServiceURL             string `json:"ServiceURL"`
	StartLocal             string `json:"StartLocal"`
	StartUTC               string `json:"StartUTC"`
	TLSCipher              string `json:"TLSCipher"`
	TLSVersion             string `json:"TLSVersion"`
	Time                   string `json:"time"`
	Level                  string `json:"level"`
	Msg                    string `json:"msg"`
}

type TraefikCollector struct {
	sender       HTTPLogSender
	queue        []HTTPLogEntry
	queueMu      sync.Mutex
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	lastPos      int64
	droppedCount int
}

func NewTraefikCollector(sender HTTPLogSender) *TraefikCollector {
	ctx, cancel := context.WithCancel(context.Background())
	return &TraefikCollector{
		sender: sender,
		queue:  make([]HTTPLogEntry, 0, traefikMaxBatchSize),
		ctx:    ctx,
		cancel: cancel,
	}
}

func (c *TraefikCollector) Start() {
	c.wg.Add(2)
	go c.tailLoop()
	go c.flushLoop()
}

func (c *TraefikCollector) tailLoop() {
	defer c.wg.Done()

	for {
		select {
		case <-c.ctx.Done():
			return
		default:
		}

		if err := c.tailFile(); err != nil {
			if !os.IsNotExist(err) {
				log.Printf("[traefik-logs] error tailing file: %v", err)
			}
			select {
			case <-c.ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
		}
	}
}

func (c *TraefikCollector) tailFile() error {
	file, err := os.Open(traefikLogPath)
	if err != nil {
		return err
	}
	defer file.Close()

	if c.lastPos == 0 {
		log.Printf("[traefik-logs] started tailing %s", traefikLogPath)
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
				case <-time.After(traefikPollInterval):
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

func (c *TraefikCollector) processLine(line []byte) {
	var entry TraefikLogEntry
	if err := json.Unmarshal(line, &entry); err != nil {
		log.Printf("[traefik-logs] failed to parse line: %v", err)
		return
	}

	if entry.RequestHost == "" || entry.RouterName == "" {
		return
	}

	serviceId := extractServiceId(entry.RouterName)
	if serviceId == "" {
		return
	}

	timestamp := entry.Time
	if timestamp == "" && entry.StartUTC != "" {
		timestamp = entry.StartUTC
	}

	durationMs := float64(entry.Duration) / 1e6

	httpEntry := HTTPLogEntry{
		ServiceId: serviceId,
		Host:      entry.RequestHost,
		Method:    entry.RequestMethod,
		Path:      entry.RequestPath,
		Status:    entry.DownstreamStatus,
		Duration:  durationMs,
		Size:      entry.DownstreamContentSize,
		ClientIP:  entry.ClientHost,
		Timestamp: timestamp,
	}

	c.enqueue(httpEntry)
}

func extractServiceId(routerName string) string {
	parts := strings.Split(routerName, "@")
	if len(parts) > 0 && parts[0] != "" {
		return parts[0]
	}
	return ""
}

func (c *TraefikCollector) enqueue(entry HTTPLogEntry) {
	c.queueMu.Lock()
	defer c.queueMu.Unlock()

	if len(c.queue) >= traefikMaxQueueSize {
		c.droppedCount++
		if c.droppedCount%100 == 1 {
			log.Printf("[traefik-logs] dropping logs due to queue overflow (total dropped: %d)", c.droppedCount)
		}
		return
	}

	c.queue = append(c.queue, entry)

	if len(c.queue) >= traefikMaxBatchSize {
		c.flushLocked()
	}
}

func (c *TraefikCollector) flushLoop() {
	defer c.wg.Done()
	ticker := time.NewTicker(traefikFlushInterval)
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

func (c *TraefikCollector) flush() {
	c.queueMu.Lock()
	defer c.queueMu.Unlock()
	c.flushLocked()
}

func (c *TraefikCollector) flushLocked() {
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
			log.Printf("[traefik-logs] failed to send batch of %d logs: %v", len(batch), err)
		}
	}()
}

func (c *TraefikCollector) sendWithRetry(batch []HTTPLogEntry) error {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if err := c.sender.SendHTTPLogs(batch); err != nil {
			lastErr = err
			time.Sleep(time.Duration(attempt+1) * time.Second)
			continue
		}
		return nil
	}
	log.Printf("[traefik-logs] dropped batch of %d logs after 3 attempts", len(batch))
	return lastErr
}

func (c *TraefikCollector) Stop() {
	c.cancel()
	c.flush()
	c.wg.Wait()
}
