package traefik

import "testing"

func TestEnsurePrometheusMetricsConfigAddsPrivateMetricsEndpoint(t *testing.T) {
	config := map[string]interface{}{
		"entryPoints": map[string]interface{}{
			"web": map[string]interface{}{"address": ":80"},
		},
	}

	if !ensurePrometheusMetricsConfig(config) {
		t.Fatal("expected config to be modified")
	}

	entryPoints := config["entryPoints"].(map[string]interface{})
	metricsEntryPoint := entryPoints["metrics"].(map[string]interface{})
	if metricsEntryPoint["address"] != "127.0.0.1:9100" {
		t.Fatalf("metrics address = %#v", metricsEntryPoint["address"])
	}

	metricsConfig := config["metrics"].(map[string]interface{})
	prometheusConfig := metricsConfig["prometheus"].(map[string]interface{})
	if prometheusConfig["entryPoint"] != "metrics" {
		t.Fatalf("entryPoint = %#v", prometheusConfig["entryPoint"])
	}
	if prometheusConfig["addServicesLabels"] != true {
		t.Fatalf("addServicesLabels = %#v", prometheusConfig["addServicesLabels"])
	}
	if prometheusConfig["addRoutersLabels"] != false {
		t.Fatalf("addRoutersLabels = %#v", prometheusConfig["addRoutersLabels"])
	}
	if prometheusConfig["addEntryPointsLabels"] != false {
		t.Fatalf("addEntryPointsLabels = %#v", prometheusConfig["addEntryPointsLabels"])
	}
	if len(prometheusConfig["buckets"].([]interface{})) == 0 {
		t.Fatal("expected latency buckets")
	}
}

func TestEnsurePrometheusMetricsConfigIsStable(t *testing.T) {
	config := map[string]interface{}{}

	if !ensurePrometheusMetricsConfig(config) {
		t.Fatal("expected first call to modify config")
	}
	if ensurePrometheusMetricsConfig(config) {
		t.Fatal("expected second call to be stable")
	}
}
