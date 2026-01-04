package logs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

type VictoriaLogsSender struct {
	endpoint string
	client   *http.Client
}

func NewVictoriaLogsSender(endpoint string) *VictoriaLogsSender {
	return &VictoriaLogsSender{
		endpoint: endpoint,
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

type victoriaLogEntry struct {
	Msg          string `json:"_msg"`
	Time         string `json:"_time"`
	DeploymentID string `json:"deployment_id"`
	ServiceID    string `json:"service_id"`
	Stream       string `json:"stream"`
	LogType      string `json:"log_type"`
}

func (v *VictoriaLogsSender) SendLogs(batch *LogBatch) error {
	var buf bytes.Buffer
	for _, l := range batch.Logs {
		if strings.TrimSpace(l.Message) == "" {
			continue
		}
		entry := victoriaLogEntry{
			Msg:          l.Message,
			Time:         l.Timestamp,
			DeploymentID: l.DeploymentID,
			ServiceID:    l.ServiceID,
			Stream:       l.Stream,
			LogType:      "container",
		}
		data, err := json.Marshal(entry)
		if err != nil {
			continue
		}
		buf.Write(data)
		buf.WriteByte('\n')
	}

	if buf.Len() == 0 {
		return nil
	}

	url := v.endpoint + "/insert/jsonline"
	log.Printf("[logs] sending %d logs (%d bytes) to %s", len(batch.Logs), buf.Len(), url)

	req, err := http.NewRequest("POST", url, &buf)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	start := time.Now()
	resp, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send logs: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[logs] response: %d in %v", resp.StatusCode, time.Since(start))

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	return nil
}

type victoriaHTTPLogEntry struct {
	Msg       string  `json:"_msg"`
	Time      string  `json:"_time"`
	ServiceID string  `json:"service_id"`
	Host      string  `json:"host"`
	Method    string  `json:"method"`
	Path      string  `json:"path"`
	Status    int     `json:"status"`
	Duration  float64 `json:"duration_ms"`
	Size      int     `json:"size"`
	ClientIP  string  `json:"client_ip"`
	LogType   string  `json:"log_type"`
}

func (v *VictoriaLogsSender) SendHTTPLogs(logs []HTTPLogEntry) error {
	var buf bytes.Buffer
	for _, l := range logs {
		msg := fmt.Sprintf("%s %s %d %dms", l.Method, l.Path, l.Status, int(l.Duration))
		entry := victoriaHTTPLogEntry{
			Msg:       msg,
			Time:      l.Timestamp,
			ServiceID: l.ServiceId,
			Host:      l.Host,
			Method:    l.Method,
			Path:      l.Path,
			Status:    l.Status,
			Duration:  l.Duration,
			Size:      l.Size,
			ClientIP:  l.ClientIP,
			LogType:   "http",
		}
		data, err := json.Marshal(entry)
		if err != nil {
			continue
		}
		buf.Write(data)
		buf.WriteByte('\n')
	}

	url := v.endpoint + "/insert/jsonline"
	log.Printf("[caddy-logs] sending %d HTTP logs (%d bytes) to %s", len(logs), buf.Len(), url)

	req, err := http.NewRequest("POST", url, &buf)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	start := time.Now()
	resp, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send HTTP logs: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[caddy-logs] response: %d in %v", resp.StatusCode, time.Since(start))

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	return nil
}

type victoriaBuildLogEntry struct {
	Msg       string `json:"_msg"`
	Time      string `json:"_time"`
	BuildID   string `json:"build_id"`
	ServiceID string `json:"service_id"`
	ProjectID string `json:"project_id"`
	LogType   string `json:"log_type"`
}

type AgentLog struct {
	ServerID  string `json:"server_id"`
	Message   string `json:"_msg"`
	Timestamp string `json:"_time"`
	Level     string `json:"level"`
	LogType   string `json:"log_type"`
}

func (v *VictoriaLogsSender) SendBuildLogs(buildID, serviceID, projectID string, logs []string) error {
	if len(logs) == 0 {
		return nil
	}

	var buf bytes.Buffer
	baseTime := time.Now()

	for i, msg := range logs {
		if strings.TrimSpace(msg) == "" {
			continue
		}
		logTime := baseTime.Add(time.Duration(i) * time.Microsecond)
		entry := victoriaBuildLogEntry{
			Msg:       msg,
			Time:      logTime.Format(time.RFC3339Nano),
			BuildID:   buildID,
			ServiceID: serviceID,
			ProjectID: projectID,
			LogType:   "build",
		}
		data, err := json.Marshal(entry)
		if err != nil {
			continue
		}
		buf.Write(data)
		buf.WriteByte('\n')
	}

	if buf.Len() == 0 {
		return nil
	}

	url := v.endpoint + "/insert/jsonline"

	req, err := http.NewRequest("POST", url, &buf)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send build logs: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	return nil
}

func (v *VictoriaLogsSender) SendAgentLogs(logs []AgentLog) error {
	if len(logs) == 0 {
		return nil
	}

	var buf bytes.Buffer
	for _, l := range logs {
		if strings.TrimSpace(l.Message) == "" {
			continue
		}
		data, err := json.Marshal(l)
		if err != nil {
			continue
		}
		buf.Write(data)
		buf.WriteByte('\n')
	}

	if buf.Len() == 0 {
		return nil
	}

	url := v.endpoint + "/insert/jsonline"

	req, err := http.NewRequest("POST", url, &buf)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send agent logs: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	return nil
}
