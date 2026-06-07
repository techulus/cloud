package metrics

import (
	"bytes"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"techulus/cloud-agent/internal/health"
)

type VictoriaMetricsSender struct {
	endpoint string
	serverID string
	username string
	password string
	client   *http.Client
}

func NewVictoriaMetricsSender(endpoint, serverID string) *VictoriaMetricsSender {
	var username, password string
	cleanEndpoint := strings.TrimRight(endpoint, "/")

	if parsedURL, err := url.Parse(endpoint); err == nil && parsedURL.User != nil {
		username = parsedURL.User.Username()
		password, _ = parsedURL.User.Password()
		parsedURL.User = nil
		cleanEndpoint = strings.TrimRight(parsedURL.String(), "/")
	}

	return &VictoriaMetricsSender{
		endpoint: cleanEndpoint,
		serverID: serverID,
		username: username,
		password: password,
		client: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

func (v *VictoriaMetricsSender) SendSystemStats(stats *health.SystemStats, collectedAt time.Time) error {
	if stats == nil {
		return nil
	}

	timestampMs := collectedAt.UnixMilli()
	serverID := escapeLabelValue(v.serverID)

	var buf bytes.Buffer
	writeGauge(&buf, "techulus_node_cpu_usage_percent", serverID, stats.CpuUsagePercent, timestampMs)
	writeGauge(&buf, "techulus_node_memory_usage_percent", serverID, stats.MemoryUsagePercent, timestampMs)
	writeGauge(&buf, "techulus_node_memory_used_bytes", serverID, float64(stats.MemoryUsedMb)*1024*1024, timestampMs)
	writeGauge(&buf, "techulus_node_disk_usage_percent", serverID, stats.DiskUsagePercent, timestampMs)
	writeGauge(&buf, "techulus_node_disk_used_bytes", serverID, float64(stats.DiskUsedGb)*1024*1024*1024, timestampMs)

	req, err := http.NewRequest("POST", v.endpoint+"/api/v1/import/prometheus", &buf)
	if err != nil {
		return fmt.Errorf("failed to create metrics request: %w", err)
	}
	req.Header.Set("Content-Type", "text/plain; version=0.0.4")
	if v.username != "" {
		req.SetBasicAuth(v.username, v.password)
	}

	resp, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send metrics: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("unexpected metrics status code: %d", resp.StatusCode)
	}

	return nil
}

func writeGauge(buf *bytes.Buffer, name, serverID string, value float64, timestampMs int64) {
	fmt.Fprintf(buf, "%s{server_id=\"%s\"} %f %d\n", name, serverID, value, timestampMs)
}

func escapeLabelValue(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "\n", "\\n")
	value = strings.ReplaceAll(value, "\"", "\\\"")
	return value
}
