package manifest

import (
	"strings"
	"testing"
)

func base() Manifest {
	return Manifest{APIVersion: "v1", Project: Project{ID: "p", Slug: "app"}, Environment: Environment{ID: "e", Name: "prod"}, Service: Service{ID: "s", Name: "web", Source: Source{Type: "image", Image: "nginx"}, Replicas: 1}}
}
func TestDefaultsAndRoundTrip(t *testing.T) {
	m := base()
	m.Service.Replicas = 0
	b, e := Marshal(m)
	if e != nil {
		t.Fatal(e)
	}
	got, e := Parse(b)
	if e != nil || got.Service.Replicas != 1 || got.Service.Ports == nil {
		t.Fatalf("got=%#v err=%v", got, e)
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
	if err := Validate(m); err == nil || !strings.Contains(err.Error(), "must be unique") {
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
