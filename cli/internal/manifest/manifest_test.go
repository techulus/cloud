package manifest

import (
	"strings"
	"testing"
)

func base() Manifest {
	hostname := "web"
	return Manifest{APIVersion: "v1", Target: &Target{ServiceID: "s"}, Service: Service{Name: "web", Source: Source{Type: "image", Image: "nginx"}, Hostname: &hostname, Replicas: 1, Placement: &Placement{Mode: "automatic"}}}
}
func TestDefaultsAndRoundTrip(t *testing.T) {
	m := base()
	m.Service.Replicas = 0
	m.Service.Crons = []Cron{{Path: " /api/cron/digest ", Schedule: " 0 5 * * * "}}
	b, e := Marshal(m)
	if e != nil {
		t.Fatal(e)
	}
	got, e := Parse(b)
	if e != nil || got.Service.Replicas != 1 || got.Service.Ports == nil || got.Service.Crons[0] != (Cron{Path: "/api/cron/digest", Schedule: "0 5 * * *"}) {
		t.Fatalf("got=%#v err=%v", got, e)
	}
}

func TestCronValidation(t *testing.T) {
	invalidPaths := []string{"//host/job", "/job?x=1", "/job#part", `/job\\next`, "/a/../b", "/a/%2e%2e/b", "/%2fhost", "/bad%zz", "/line%0Abreak"}
	for _, path := range invalidPaths {
		m := base()
		m.Service.Crons = []Cron{{Path: path, Schedule: "0 5 * * *"}}
		if err := Validate(m); err == nil {
			t.Fatalf("invalid cron path %q accepted", path)
		}
	}
	m := base()
	m.Service.Crons = []Cron{{Path: "/jobs/nightly", Schedule: "0 5 * * *"}, {Path: "/jobs/nightly", Schedule: "0 6 * * *"}}
	if err := Validate(m); err == nil || !strings.Contains(err.Error(), "unique") {
		t.Fatalf("duplicate path error = %v", err)
	}
	m.Service.Crons = []Cron{{Path: "/jobs/nightly", Schedule: "0 5 * *"}}
	if err := Validate(m); err == nil || !strings.Contains(err.Error(), "five-field") {
		t.Fatalf("schedule error = %v", err)
	}
}

func TestHostnameValidationAndSlugify(t *testing.T) {
	for _, value := range []string{"", "Upper", "two words", "-leading", "trailing-", "two--hyphens", strings.Repeat("a", 64)} {
		m := base()
		m.Service.Hostname = &value
		if err := Validate(m); err == nil {
			t.Fatalf("invalid hostname %q accepted", value)
		}
	}

	if got := Slugify("  My API__Service  "); got != "my-api-service" {
		t.Fatalf("Slugify() = %q", got)
	}
	long := Slugify(strings.Repeat("long-name-", 10))
	if len(long) > 63 || strings.HasSuffix(long, "-") || !hostnamePattern.MatchString(long) {
		t.Fatalf("invalid truncated slug %q", long)
	}
}

func TestPlacementRoundTripAndValidation(t *testing.T) {
	m := base()
	m.Service.Replicas = 3
	m.Service.Placement = &Placement{Mode: " manual ", Servers: []PlacementServer{{ServerID: " server-a ", Count: 2}, {ServerID: "server-b", Count: 1}}}
	b, err := Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	if got.Service.Placement == nil || got.Service.Placement.Mode != "manual" || got.Service.Placement.Servers[0].ServerID != "server-a" {
		t.Fatalf("placement=%#v", got.Service.Placement)
	}

	tests := []struct {
		name      string
		placement *Placement
		replicas  int
	}{
		{"invalid mode", &Placement{Mode: "random"}, 1},
		{"automatic servers", &Placement{Mode: "automatic", Servers: []PlacementServer{}}, 1},
		{"blank server", &Placement{Mode: "manual", Servers: []PlacementServer{{ServerID: " ", Count: 1}}}, 1},
		{"duplicate server", &Placement{Mode: "manual", Servers: []PlacementServer{{ServerID: "a", Count: 1}, {ServerID: "a", Count: 1}}}, 2},
		{"nonpositive count", &Placement{Mode: "manual", Servers: []PlacementServer{{ServerID: "a", Count: 0}}}, 1},
		{"total exceeds limit", &Placement{Mode: "manual", Servers: []PlacementServer{{ServerID: "a", Count: 33}}}, 32},
		{"total differs from replicas", &Placement{Mode: "manual", Servers: []PlacementServer{{ServerID: "a", Count: 1}}}, 2},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := base()
			m.Service.Replicas = tc.replicas
			m.Service.Placement = tc.placement
			ApplyDefaults(&m)
			if err := Validate(m); err == nil {
				t.Fatal("invalid placement accepted")
			}
		})
	}
}

func TestReplicaLimit(t *testing.T) {
	for _, placement := range []*Placement{
		{Mode: "automatic"},
		{Mode: "manual", Servers: []PlacementServer{{ServerID: "a", Count: 32}}},
	} {
		m := base()
		m.Service.Replicas = 32
		m.Service.Placement = placement
		if err := Validate(m); err != nil {
			t.Fatalf("32 replicas rejected: %v", err)
		}
	}

	m := base()
	m.Service.Replicas = 33
	if err := Validate(m); err == nil {
		t.Fatal("33 replicas accepted")
	}
}

func TestPlacementIsRequired(t *testing.T) {
	_, err := Parse([]byte(`apiVersion: v1
service:
  name: web
  source: {type: image, image: nginx}
  hostname: web
  replicas: 2
`))
	if err == nil || !strings.Contains(err.Error(), "service.placement is required") {
		t.Fatalf("error = %v", err)
	}
}
func TestGitHubCanonical(t *testing.T) {
	m := base()
	root := `packages\web`
	m.Service.Source = Source{Type: "github", Repository: "https://github.com/acme/repo.git/", Branch: " main ", RootDir: &root}
	b, e := Marshal(m)
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(b), "https://github.com/acme/repo") {
		t.Fatal(string(b))
	}
	if !strings.Contains(string(b), "packages/web") {
		t.Fatalf("rootDir was not normalized: %s", b)
	}
}
func TestRejectMixedAndRootEscape(t *testing.T) {
	m := base()
	m.Service.Source = Source{Type: "github", Image: "x", Repository: "https://github.com/a/b", Branch: "main"}
	if Validate(m) == nil {
		t.Fatal("mixed source accepted")
	}
	root := "../x"
	m.Service.Source.Image = ""
	m.Service.Source.RootDir = &root
	if Validate(m) == nil {
		t.Fatal("escaping root accepted")
	}
}
func TestRejectGitHubURL(t *testing.T) {
	for _, v := range []string{"http://github.com/a/b", "https://user@github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a/b?q=1"} {
		if _, e := CanonicalGitHubRepository(v); e == nil {
			t.Fatalf("accepted %s", v)
		}
	}
}

func TestRejectWindowsAbsoluteRootDir(t *testing.T) {
	for _, root := range []string{`C:\app`, `D:/service`, `\\server\share`} {
		m := base()
		m.Service.Source = Source{Type: "github", Repository: "https://github.com/a/b", Branch: "main", RootDir: &root}
		if err := Validate(m); err == nil || !strings.Contains(err.Error(), "must be relative") {
			t.Fatalf("rootDir %q error = %v", root, err)
		}
	}
}

func TestRejectDuplicatePorts(t *testing.T) {
	m := base()
	m.Service.Ports = []Port{{ContainerPort: 8080}, {ContainerPort: 8080}}
	if err := Validate(m); err == nil || !strings.Contains(err.Error(), "can only be repeated") {
		t.Fatalf("error = %v", err)
	}
}

func TestAllowsMultipleDomainsOnOnePort(t *testing.T) {
	m := base()
	first := "app.example.com"
	second := "www.example.com"
	m.Service.Ports = []Port{
		{ContainerPort: 8080, Public: true, Domain: &first},
		{ContainerPort: 8080, Public: true, Domain: &second},
	}
	if err := Validate(m); err != nil {
		t.Fatalf("valid port aliases rejected: %v", err)
	}
}

func TestRejectsDuplicatePortDomains(t *testing.T) {
	m := base()
	domain := "app.example.com"
	m.Service.Ports = []Port{
		{ContainerPort: 8080, Public: true, Domain: &domain},
		{ContainerPort: 8080, Public: true, Domain: &domain},
	}
	if err := Validate(m); err == nil || !strings.Contains(err.Error(), "domain must be unique") {
		t.Fatalf("error = %v", err)
	}
}

func TestPublicAndInternalPortDomainRules(t *testing.T) {
	domain := "app.example.com"
	for _, tc := range []struct {
		name string
		port Port
	}{
		{"public requires domain", Port{ContainerPort: 80, Public: true}},
		{"internal rejects domain", Port{ContainerPort: 80, Domain: &domain}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := base()
			m.Service.Ports = []Port{tc.port}
			if err := Validate(m); err == nil {
				t.Fatal("invalid external-port configuration accepted")
			}
		})
	}
	m := base()
	m.Service.Ports = []Port{{ContainerPort: 80, Public: true, Domain: &domain}, {ContainerPort: 5432}}
	if err := Validate(m); err != nil {
		t.Fatalf("valid public/internal ports rejected: %v", err)
	}
}
