package metrics

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
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
