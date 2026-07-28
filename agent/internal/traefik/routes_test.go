package traefik

import (
	"strings"
	"testing"
)

func TestHTTPResourceNameIsOpaqueAndOwnerScoped(t *testing.T) {
	name := resourceName("http", "service-42", "my--app.example.com")
	if !strings.HasPrefix(name, "http-") {
		t.Fatalf("resource name %q is missing its type prefix", name)
	}
	if strings.Contains(name, "service-42") || strings.Contains(name, "my--app.example.com") {
		t.Fatalf("resource name %q exposes semantic identity", name)
	}
	if got := resourceName("http", "service-42", "my--app.example.com"); got != name {
		t.Fatalf("resource name is not deterministic: %q != %q", got, name)
	}
	if got := resourceName("http", "service-43", "my--app.example.com"); got == name {
		t.Fatal("same route ID under different owners produced the same resource name")
	}
}

func TestHTTPAliasesGenerateDistinctRoutesAndConvergentHash(t *testing.T) {
	originalDir := dynamicConfigDir
	t.Cleanup(func() { dynamicConfigDir = originalDir })
	dynamicConfigDir = t.TempDir()

	routes := []TraefikRoute{
		{
			ID:        "app.example.com",
			Domain:    "app.example.com",
			ServiceId: "service-42",
			Upstreams: []Upstream{{URL: "10.0.0.1:3000", Weight: 5}},
		},
		{
			ID:        "www.example.com",
			Domain:    "www.example.com",
			ServiceId: "service-42",
			Upstreams: []Upstream{{URL: "10.0.0.1:3000", Weight: 5}},
		},
	}

	compiled, err := CompileRoutes(routes, nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteRoutesConfig(compiled); err != nil {
		t.Fatal(err)
	}
	config, err := readCurrentFullConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got := len(config.HTTP.Routers); got != 2 {
		t.Fatalf("generated %d HTTP routers, want 2", got)
	}
	if got := len(config.HTTP.Services); got != 2 {
		t.Fatalf("generated %d HTTP services, want 2", got)
	}
	for _, route := range routes {
		name := resourceName("http", route.ServiceId, route.ID)
		router, exists := config.HTTP.Routers[name]
		if !exists {
			t.Fatalf("router %q was not generated", name)
		}
		if router.Service != name {
			t.Fatalf("router %q targets %q, want %q", name, router.Service, name)
		}
	}

	if got, want := GetCurrentConfigHash(), HashRoutesConfig(compiled); got != want {
		t.Fatalf("current config hash %q, want %q", got, want)
	}
	reversed, err := CompileRoutes([]TraefikRoute{routes[1], routes[0]}, nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if HashRoutesConfig(reversed) != HashRoutesConfig(compiled) {
		t.Fatal("HTTP route hash depends on input order")
	}
}
