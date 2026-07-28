package metrics

import (
	"strings"
	"testing"

	"techulus/cloud-agent/internal/routeowners"
)

func TestEnrichTraefik(t *testing.T) {
	owners := routeowners.NewRegistry()
	owners.Merge(map[string]string{"http-opaque": "service-42"})
	input := `# TYPE requests_total counter
requests_total{service="http-opaque@file",service_id="forged",path="a\\\"b"} 2 123
requests_total{service="unknown",service_id="forged"} 3
requests_total{service_id="forged"} 4
# TYPE latency histogram
latency_bucket{service="http-opaque",le="1"} 1
latency_sum{service="http-opaque"} 0.5
latency_count{service="http-opaque"} 1
`
	got, err := EnrichTraefik([]byte(input), owners)
	if err != nil {
		t.Fatal(err)
	}
	text := string(got)
	if strings.Count(text, `service_id="service-42"`) != 5 {
		t.Fatalf("unexpected enrichment:\n%s", text)
	}
	if strings.Contains(text, `service_id="forged"`) {
		t.Fatalf("untrusted service ID was forwarded:\n%s", text)
	}
	if !strings.Contains(text, `requests_total{service="unknown"} 3`) {
		t.Fatalf("unknown service enriched:\n%s", text)
	}
	if !strings.Contains(text, `requests_total 4`) {
		t.Fatalf("metric without a service label was altered incorrectly:\n%s", text)
	}
}
