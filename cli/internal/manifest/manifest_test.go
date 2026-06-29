package manifest

import (
	"strings"
	"testing"
)

func TestParseValidManifestAppliesDefaults(t *testing.T) {
	raw := []byte(`apiVersion: v1
project: app
environment: production
service:
  name: web
  source:
    type: image
    image: nginx:1.27
`)
	parsed, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if parsed.Service.Replicas.Count != 1 {
		t.Fatalf("replicas default = %d, want 1", parsed.Service.Replicas.Count)
	}
	if parsed.Service.Ports == nil {
		t.Fatal("ports default should be an empty slice, not nil")
	}
}

func TestValidatePortDomainRules(t *testing.T) {
	base := validManifest()
	base.Service.Ports = []Port{{Port: 80, Public: true}}
	if err := Validate(base); err == nil || !strings.Contains(err.Error(), "domain is required") {
		t.Fatalf("Validate(public without domain) = %v", err)
	}

	base = validManifest()
	base.Service.Ports = []Port{{Port: 80, Public: false, Domain: "example.com"}}
	if err := Validate(base); err == nil || !strings.Contains(err.Error(), "domain cannot be set") {
		t.Fatalf("Validate(internal with domain) = %v", err)
	}
}

func TestValidateResourcesMustBePaired(t *testing.T) {
	cpu := 1.0
	base := validManifest()
	base.Service.Resources = &Resources{CPUCores: &cpu}
	if err := Validate(base); err == nil || !strings.Contains(err.Error(), "both cpuCores and memoryMb") {
		t.Fatalf("Validate(resources) = %v", err)
	}
}

func TestValidateBlankOptionalStrings(t *testing.T) {
	raw := []byte(`apiVersion: v1
project: app
environment: production
service:
  name: web
  source:
    type: image
    image: nginx:1.27
  hostname: "   "
`)
	if _, err := Parse(raw); err == nil || !strings.Contains(err.Error(), "hostname cannot be blank") {
		t.Fatalf("Parse(blank hostname) = %v", err)
	}

	raw = []byte(`apiVersion: v1
project: app
environment: production
service:
  name: web
  source:
    type: image
    image: nginx:1.27
  startCommand: "   "
`)
	if _, err := Parse(raw); err == nil || !strings.Contains(err.Error(), "startCommand cannot be blank") {
		t.Fatalf("Parse(blank startCommand) = %v", err)
	}
}

func TestMarshalRoundTrip(t *testing.T) {
	value := validManifest()
	value.Service.Ports = []Port{{Port: 443, Public: true, Domain: "app.example.com"}}
	raw, err := Marshal(value)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	parsed, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse(Marshal()) error = %v", err)
	}
	if parsed.Service.Ports[0].Domain != "app.example.com" {
		t.Fatalf("domain = %q", parsed.Service.Ports[0].Domain)
	}
}

func validManifest() Manifest {
	return Manifest{
		APIVersion:  "v1",
		Project:     "app",
		Environment: "production",
		Service: Service{
			Name:     "web",
			Source:   Source{Type: "image", Image: "nginx:1.27"},
			Replicas: Replicas{Count: 1},
			Ports:    []Port{},
		},
	}
}
