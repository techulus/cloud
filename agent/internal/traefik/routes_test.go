package traefik

import "testing"

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

	if err := UpdateHttpRoutesWithL4(routes, nil, nil, ""); err != nil {
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
		name := httpRouteName(route)
		router, exists := config.HTTP.Routers[name]
		if !exists {
			t.Fatalf("router %q was not generated", name)
		}
		if router.Service != name {
			t.Fatalf("router %q targets %q, want %q", name, router.Service, name)
		}
	}

	if got, want := GetCurrentConfigHash(), HashRoutesWithServerName(routes, ""); got != want {
		t.Fatalf("current config hash %q, want %q", got, want)
	}
	reversed := []TraefikRoute{routes[1], routes[0]}
	if HashRoutes(reversed) != HashRoutes(routes) {
		t.Fatal("HTTP route hash depends on input order")
	}
}
