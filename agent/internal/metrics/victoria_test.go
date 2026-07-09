package metrics

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/health"
)

func TestSendPrometheusMetricsAddsExtraLabels(t *testing.T) {
	var gotPath string
	var gotQuery string
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	sender := NewVictoriaMetricsSender(server.URL, "server-1")
	err := sender.SendPrometheusMetrics([]byte("sample_metric 1\n"), map[string]string{
		"server_id": "server-1",
		"job":       "traefik",
	})
	if err != nil {
		t.Fatalf("send prometheus metrics: %v", err)
	}

	if gotPath != "/api/v1/import/prometheus" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotQuery != "extra_label=job%3Dtraefik&extra_label=server_id%3Dserver-1" {
		t.Fatalf("query = %q", gotQuery)
	}
	if gotBody != "sample_metric 1\n" {
		t.Fatalf("body = %q", gotBody)
	}
}

func TestSendAgentStatsWritesStableServerLabels(t *testing.T) {
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	sender := NewVictoriaMetricsSender(server.URL, "server-1")
	err := sender.SendAgentStats(&health.AgentProcessStats{
		CPUUsagePercent:    1.25,
		MemoryUsagePercent: 0.5,
		MemoryUsedBytes:    64 * 1024 * 1024,
	}, time.UnixMilli(1_700_000_000_000))
	if err != nil {
		t.Fatalf("send agent stats: %v", err)
	}

	if !strings.Contains(gotBody, `techulus_agent_cpu_usage_percent{server_id="server-1"} 1.250000 1700000000000`) {
		t.Fatalf("missing agent CPU metric:\n%s", gotBody)
	}
	if !strings.Contains(gotBody, `techulus_agent_memory_usage_percent{server_id="server-1"} 0.500000 1700000000000`) {
		t.Fatalf("missing agent memory percent metric:\n%s", gotBody)
	}
	if !strings.Contains(gotBody, `techulus_agent_memory_used_bytes{server_id="server-1"} 67108864.000000 1700000000000`) {
		t.Fatalf("missing agent memory bytes metric:\n%s", gotBody)
	}
}

func TestSendContainerStatsAggregatesStableServiceLabels(t *testing.T) {
	var gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	sender := NewVictoriaMetricsSender(server.URL, "server-1")
	err := sender.SendContainerStats([]container.ResourceStats{
		{
			ContainerID:          "container-a",
			ServiceID:            "svc-a",
			DeploymentID:         "dep-a",
			CPUUsagePercent:      10,
			MemoryUsagePercent:   1.5,
			MemoryUsedBytes:      1024,
			NetworkReceiveBytes:  100,
			NetworkTransmitBytes: 200,
		},
		{
			ContainerID:          "container-b",
			ServiceID:            "svc-a",
			DeploymentID:         "dep-b",
			CPUUsagePercent:      20,
			MemoryUsagePercent:   2.5,
			MemoryUsedBytes:      2048,
			NetworkReceiveBytes:  300,
			NetworkTransmitBytes: 400,
		},
	}, time.UnixMilli(1_700_000_000_000))
	if err != nil {
		t.Fatalf("send container stats: %v", err)
	}

	if strings.Contains(gotBody, "container_id") || strings.Contains(gotBody, "deployment_id") {
		t.Fatalf("unexpected churn labels in body:\n%s", gotBody)
	}
	if !strings.Contains(gotBody, `techulus_service_cpu_usage_percent{server_id="server-1",service_id="svc-a"} 30.000000 1700000000000`) {
		t.Fatalf("missing aggregated CPU metric:\n%s", gotBody)
	}
	if !strings.Contains(gotBody, `techulus_service_memory_usage_percent{server_id="server-1",service_id="svc-a"} 4.000000 1700000000000`) {
		t.Fatalf("missing aggregated memory percent metric:\n%s", gotBody)
	}
	if !strings.Contains(gotBody, `techulus_service_memory_used_bytes{server_id="server-1",service_id="svc-a"} 3072.000000 1700000000000`) {
		t.Fatalf("missing aggregated memory bytes metric:\n%s", gotBody)
	}
}
