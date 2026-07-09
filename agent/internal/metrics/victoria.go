package metrics

import (
	"bytes"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/health"
)

type VictoriaMetricsSender struct {
	endpoint string
	serverID string
	username string
	password string
	client   *http.Client
}

type serviceResourceStats struct {
	ServiceID            string
	CPUUsagePercent      float64
	MemoryUsagePercent   float64
	MemoryUsedBytes      float64
	NetworkReceiveBytes  float64
	NetworkTransmitBytes float64
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

func (v *VictoriaMetricsSender) SendContainerStats(stats []container.ResourceStats, collectedAt time.Time) error {
	if len(stats) == 0 {
		return nil
	}

	aggregates := aggregateContainerStats(stats)
	if len(aggregates) == 0 {
		return nil
	}

	timestampMs := collectedAt.UnixMilli()
	serverID := escapeLabelValue(v.serverID)

	var buf bytes.Buffer
	for _, stat := range aggregates {
		labels := map[string]string{
			"server_id":  serverID,
			"service_id": escapeLabelValue(stat.ServiceID),
		}
		writeGaugeWithLabels(&buf, "techulus_service_cpu_usage_percent", labels, stat.CPUUsagePercent, timestampMs)
		writeGaugeWithLabels(&buf, "techulus_service_memory_usage_percent", labels, stat.MemoryUsagePercent, timestampMs)
		writeGaugeWithLabels(&buf, "techulus_service_memory_used_bytes", labels, stat.MemoryUsedBytes, timestampMs)
		writeGaugeWithLabels(&buf, "techulus_service_network_receive_bytes_total", labels, stat.NetworkReceiveBytes, timestampMs)
		writeGaugeWithLabels(&buf, "techulus_service_network_transmit_bytes_total", labels, stat.NetworkTransmitBytes, timestampMs)
	}

	return v.postPrometheusImport(buf.Bytes(), nil)
}

func aggregateContainerStats(stats []container.ResourceStats) []serviceResourceStats {
	byService := make(map[string]*serviceResourceStats)
	for _, stat := range stats {
		if stat.ServiceID == "" {
			continue
		}
		aggregate := byService[stat.ServiceID]
		if aggregate == nil {
			aggregate = &serviceResourceStats{ServiceID: stat.ServiceID}
			byService[stat.ServiceID] = aggregate
		}
		aggregate.CPUUsagePercent += stat.CPUUsagePercent
		aggregate.MemoryUsagePercent += stat.MemoryUsagePercent
		aggregate.MemoryUsedBytes += stat.MemoryUsedBytes
		aggregate.NetworkReceiveBytes += stat.NetworkReceiveBytes
		aggregate.NetworkTransmitBytes += stat.NetworkTransmitBytes
	}

	serviceIDs := make([]string, 0, len(byService))
	for serviceID := range byService {
		serviceIDs = append(serviceIDs, serviceID)
	}
	sort.Strings(serviceIDs)

	aggregates := make([]serviceResourceStats, 0, len(serviceIDs))
	for _, serviceID := range serviceIDs {
		aggregates = append(aggregates, *byService[serviceID])
	}
	return aggregates
}

func (v *VictoriaMetricsSender) SendPrometheusMetrics(data []byte, extraLabels map[string]string) error {
	if len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	return v.postPrometheusImport(data, extraLabels)
}

func (v *VictoriaMetricsSender) postPrometheusImport(data []byte, extraLabels map[string]string) error {
	requestURL, err := url.Parse(v.endpoint + "/api/v1/import/prometheus")
	if err != nil {
		return fmt.Errorf("failed to parse metrics endpoint: %w", err)
	}
	query := requestURL.Query()
	for _, key := range sortedKeys(extraLabels) {
		if key == "" || extraLabels[key] == "" {
			continue
		}
		query.Add("extra_label", fmt.Sprintf("%s=%s", key, extraLabels[key]))
	}
	requestURL.RawQuery = query.Encode()

	req, err := http.NewRequest("POST", requestURL.String(), bytes.NewReader(data))
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
	writeGaugeWithLabels(buf, name, map[string]string{"server_id": serverID}, value, timestampMs)
}

func writeGaugeWithLabels(buf *bytes.Buffer, name string, labels map[string]string, value float64, timestampMs int64) {
	fmt.Fprintf(buf, "%s{", name)
	for i, key := range sortedKeys(labels) {
		if i > 0 {
			buf.WriteByte(',')
		}
		fmt.Fprintf(buf, "%s=\"%s\"", key, labels[key])
	}
	fmt.Fprintf(buf, "} %f %d\n", value, timestampMs)
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func escapeLabelValue(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "\n", "\\n")
	value = strings.ReplaceAll(value, "\"", "\\\"")
	return value
}
