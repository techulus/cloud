package container

import "testing"

func TestParseContainerListReadsStatusHealth(t *testing.T) {
	output := []byte(`[
		{
			"Id": "abc123",
			"Names": ["svc-web"],
			"Image": "registry.example.com/web:latest",
			"State": "running",
			"Status": "healthy",
			"Created": 1710000000,
			"Labels": {
				"techulus.deployment.id": "dep_123",
				"techulus.service.id": "svc_123"
			}
		}
	]`)

	containers, err := parseContainerList(output)
	if err != nil {
		t.Fatalf("parseContainerList returned error: %v", err)
	}
	if len(containers) != 1 {
		t.Fatalf("expected 1 container, got %d", len(containers))
	}

	got := containers[0]
	if got.Name != "svc-web" {
		t.Fatalf("expected name svc-web, got %q", got.Name)
	}
	if got.HealthStatus != "healthy" {
		t.Fatalf("expected health healthy, got %q", got.HealthStatus)
	}
	if got.DeploymentID != "dep_123" {
		t.Fatalf("expected deployment dep_123, got %q", got.DeploymentID)
	}
	if got.ServiceID != "svc_123" {
		t.Fatalf("expected service svc_123, got %q", got.ServiceID)
	}
}

func TestParseContainerListLeavesMissingStatusEmpty(t *testing.T) {
	output := []byte(`[
		{
			"Id": "ghi789",
			"Names": ["svc-legacy"],
			"Image": "registry.example.com/legacy:latest",
			"State": "running",
			"Created": 1710000002,
			"Labels": {
				"techulus.deployment.id": "dep_789",
				"techulus.service.id": "svc_789"
			}
		}
	]`)

	containers, err := parseContainerList(output)
	if err != nil {
		t.Fatalf("parseContainerList returned error: %v", err)
	}
	if len(containers) != 1 {
		t.Fatalf("expected 1 container, got %d", len(containers))
	}
	if containers[0].HealthStatus != "" {
		t.Fatalf("expected missing status to stay empty for inspect fallback, got %q", containers[0].HealthStatus)
	}
}

func TestParseContainerListNormalizesEmptyStatusToNone(t *testing.T) {
	output := []byte(`[
		{
			"Id": "jkl012",
			"Names": ["svc-no-healthcheck"],
			"Image": "registry.example.com/no-healthcheck:latest",
			"State": "running",
			"Status": "",
			"Created": 1710000003,
			"Labels": {
				"techulus.deployment.id": "dep_012",
				"techulus.service.id": "svc_012"
			}
		}
	]`)

	containers, err := parseContainerList(output)
	if err != nil {
		t.Fatalf("parseContainerList returned error: %v", err)
	}
	if len(containers) != 1 {
		t.Fatalf("expected 1 container, got %d", len(containers))
	}
	if containers[0].HealthStatus != "none" {
		t.Fatalf("expected empty status to normalize to none, got %q", containers[0].HealthStatus)
	}
}

func TestNormalizeHealthStatus(t *testing.T) {
	tests := []struct {
		name string
		raw  *string
		want string
	}{
		{
			name: "missing status stays empty for inspect fallback",
			raw:  nil,
			want: "",
		},
		{
			name: "empty status means no healthcheck",
			raw:  stringPtr(""),
			want: "none",
		},
		{
			name: "starting string is preserved",
			raw:  stringPtr("starting"),
			want: "starting",
		},
		{
			name: "case and whitespace are normalized",
			raw:  stringPtr(" Healthy "),
			want: "healthy",
		},
		{
			name: "unknown string stays empty for inspect fallback",
			raw:  stringPtr("degraded"),
			want: "",
		},
		{
			name: "template no-value sentinel is treated as no healthcheck",
			raw:  stringPtr("<no value>"),
			want: "none",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeHealthStatus(tt.raw)
			if got != tt.want {
				t.Fatalf("expected %q, got %q", tt.want, got)
			}
		})
	}
}

func stringPtr(value string) *string {
	return &value
}
