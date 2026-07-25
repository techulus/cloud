package logs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type VictoriaLogsSender struct {
	endpoint string
	serverID string
	username string
	password string
	client   *http.Client
}

func NewVictoriaLogsSender(endpoint, serverID string) *VictoriaLogsSender {
	var username, password string
	cleanEndpoint := endpoint

	if parsedURL, err := url.Parse(endpoint); err == nil && parsedURL.User != nil {
		username = parsedURL.User.Username()
		password, _ = parsedURL.User.Password()
		parsedURL.User = nil
		cleanEndpoint = parsedURL.String()
	}

	return &VictoriaLogsSender{
		endpoint: cleanEndpoint,
		serverID: serverID,
		username: username,
		password: password,
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

func (v *VictoriaLogsSender) setAuthHeader(req *http.Request) {
	if v.username != "" {
		req.SetBasicAuth(v.username, v.password)
	}
}

func (v *VictoriaLogsSender) post(body []byte, transportError string) (int, time.Duration, error) {
	req, err := http.NewRequest("POST", v.endpoint+"/insert/jsonline", bytes.NewReader(body))
	if err != nil {
		return 0, 0, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	v.setAuthHeader(req)

	start := time.Now()
	resp, err := v.client.Do(req)
	elapsed := time.Since(start)
	if err != nil {
		return 0, elapsed, fmt.Errorf("%s: %w", transportError, err)
	}
	defer resp.Body.Close()

	return resp.StatusCode, elapsed, nil
}

func acceptedVictoriaStatus(status int) error {
	if status != http.StatusOK && status != http.StatusNoContent {
		return fmt.Errorf("unexpected status code: %d", status)
	}
	return nil
}

type victoriaLogEntry struct {
	Msg          string `json:"_msg"`
	Time         string `json:"_time"`
	EventID      string `json:"event_id"`
	DeploymentID string `json:"deployment_id"`
	ServiceID    string `json:"service_id"`
	ServerID     string `json:"server_id"`
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
			EventID:      l.EventID,
			DeploymentID: l.DeploymentID,
			ServiceID:    l.ServiceID,
			ServerID:     v.serverID,
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

	status, elapsed, err := v.post(buf.Bytes(), "failed to send logs")
	if err != nil {
		return err
	}
	log.Printf("[logs] response: %d in %v", status, elapsed)
	return acceptedVictoriaStatus(status)
}

type victoriaHTTPLogEntry struct {
	Msg       string  `json:"_msg"`
	Time      string  `json:"_time"`
	ServiceID string  `json:"service_id"`
	ServerID  string  `json:"server_id"`
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
			ServerID:  v.serverID,
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
	log.Printf("[traefik-logs] sending %d HTTP logs (%d bytes) to %s", len(logs), buf.Len(), url)

	status, elapsed, err := v.post(buf.Bytes(), "failed to send HTTP logs")
	if err != nil {
		return err
	}
	log.Printf("[traefik-logs] response: %d in %v", status, elapsed)
	return acceptedVictoriaStatus(status)
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

	status, _, err := v.post(buf.Bytes(), "failed to send build logs")
	if err != nil {
		return err
	}
	return acceptedVictoriaStatus(status)
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

	status, _, err := v.post(buf.Bytes(), "failed to send agent logs")
	if err != nil {
		return err
	}
	return acceptedVictoriaStatus(status)
}
