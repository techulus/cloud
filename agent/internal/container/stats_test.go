package container

import "testing"

func TestParsePodmanStatsOutputArray(t *testing.T) {
	containers := []Container{
		{
			ID:           "abcdef1234567890",
			Name:         "api",
			State:        "running",
			ServiceID:    "svc_1",
			DeploymentID: "dep_1",
		},
	}

	stats, err := parsePodmanStatsOutput([]byte(`[
		{
			"ID": "abcdef123456",
			"Name": "api",
			"CPUPerc": "12.34%",
			"MemUsage": "64MiB / 512MiB",
			"MemPerc": "12.50%",
			"NetIO": "1.5MB / 2.5MB"
		}
	]`), containers)
	if err != nil {
		t.Fatalf("parse stats: %v", err)
	}
	if len(stats) != 1 {
		t.Fatalf("expected 1 stat, got %d", len(stats))
	}

	stat := stats[0]
	if stat.ContainerID != "abcdef1234567890" {
		t.Fatalf("container id = %q", stat.ContainerID)
	}
	if stat.ServiceID != "svc_1" || stat.DeploymentID != "dep_1" {
		t.Fatalf("unexpected service/deployment labels: %#v", stat)
	}
	if stat.CPUUsagePercent != 12.34 {
		t.Fatalf("cpu = %f", stat.CPUUsagePercent)
	}
	if stat.MemoryUsagePercent != 12.5 {
		t.Fatalf("memory percent = %f", stat.MemoryUsagePercent)
	}
	if stat.MemoryUsedBytes != 64*1024*1024 {
		t.Fatalf("memory bytes = %f", stat.MemoryUsedBytes)
	}
	if stat.NetworkReceiveBytes != 1.5*1000*1000 {
		t.Fatalf("rx bytes = %f", stat.NetworkReceiveBytes)
	}
	if stat.NetworkTransmitBytes != 2.5*1000*1000 {
		t.Fatalf("tx bytes = %f", stat.NetworkTransmitBytes)
	}
}

func TestParsePodmanStatsOutputJSONLines(t *testing.T) {
	containers := []Container{
		{ID: "1234567890abcdef", Name: "worker", State: "running", ServiceID: "svc_2", DeploymentID: "dep_2"},
	}

	stats, err := parsePodmanStatsOutput([]byte(`{"ContainerID":"1234567890","CPUPerc":"0%","MemUsage":"128MB / 1GB","MemPerc":"10%","NetIO":"0B / 32kB"}`), containers)
	if err != nil {
		t.Fatalf("parse stats: %v", err)
	}
	if len(stats) != 1 {
		t.Fatalf("expected 1 stat, got %d", len(stats))
	}
	if stats[0].MemoryUsedBytes != 128*1000*1000 {
		t.Fatalf("memory bytes = %f", stats[0].MemoryUsedBytes)
	}
	if stats[0].NetworkTransmitBytes != 32*1000 {
		t.Fatalf("tx bytes = %f", stats[0].NetworkTransmitBytes)
	}
}

func TestParsePodmanStatsOutputNameFallbackDoesNotUseIDPrefix(t *testing.T) {
	containers := []Container{
		{ID: "api1234567890", Name: "backend", State: "running", ServiceID: "wrong", DeploymentID: "wrong_dep"},
		{ID: "fedcba987654", Name: "api", State: "running", ServiceID: "svc_3", DeploymentID: "dep_3"},
	}

	stats, err := parsePodmanStatsOutput([]byte(`[
		{
			"Name": "api",
			"CPUPerc": "7%",
			"MemUsage": "1MiB / 128MiB",
			"MemPerc": "1%",
			"NetIO": "0B / 0B"
		}
	]`), containers)
	if err != nil {
		t.Fatalf("parse stats: %v", err)
	}
	if len(stats) != 1 {
		t.Fatalf("expected 1 stat, got %d", len(stats))
	}
	if stats[0].ServiceID != "svc_3" || stats[0].DeploymentID != "dep_3" {
		t.Fatalf("unexpected attribution: %#v", stats[0])
	}
}

func TestParseByteQuantity(t *testing.T) {
	tests := map[string]float64{
		"42B":    42,
		"1 kB":   1000,
		"1KiB":   1024,
		"1.5GB":  1.5 * 1000 * 1000 * 1000,
		"2 MiB":  2 * 1024 * 1024,
		"--":     0,
		"broken": 0,
	}

	for input, expected := range tests {
		if actual := parseByteQuantity(input); actual != expected {
			t.Fatalf("%q = %f, want %f", input, actual, expected)
		}
	}
}
