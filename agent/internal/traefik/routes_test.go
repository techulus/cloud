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

func TestRoutesConfigRoundTripProducesConvergentHash(t *testing.T) {
	originalDir := dynamicConfigDir
	t.Cleanup(func() { dynamicConfigDir = originalDir })
	dynamicConfigDir = t.TempDir()

	routes := []TraefikRoute{
		{
			ID:        "app.example.com",
			Domain:    "app.example.com",
			ServiceId: "service-42",
			Upstreams: []Upstream{
				{URL: "10.0.0.2:3000", Weight: 2},
				{URL: "10.0.0.1:3000", Weight: 1},
			},
		},
		{
			ID:        "www.example.com",
			Domain:    "www.example.com",
			ServiceId: "service-42",
			Upstreams: []Upstream{{URL: "10.0.0.1:3000", Weight: 5}},
		},
	}
	tcpRoutes := []TraefikTCPRoute{{
		ID:             "tcp-route",
		ServiceId:      "service-tcp",
		Upstreams:      []string{"10.0.0.2:5432", "10.0.0.1:5432"},
		ExternalPort:   TCPPortStart,
		TLSPassthrough: true,
	}}
	udpRoutes := []TraefikUDPRoute{{
		ID:           "udp-route",
		ServiceId:    "service-udp",
		Upstreams:    []string{"10.0.0.2:8125", "10.0.0.1:8125"},
		ExternalPort: UDPPortStart,
	}}

	compiled, err := CompileRoutes(routes, tcpRoutes, udpRoutes, "proxy-1")
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
	if got := len(config.TCP.Routers); got != 1 {
		t.Fatalf("generated %d TCP routers, want 1", got)
	}
	if got := len(config.UDP.Routers); got != 1 {
		t.Fatalf("generated %d UDP routers, want 1", got)
	}
	forwardedServer := config.HTTP.Middlewares["forwarded_server"]
	if forwardedServer.Headers == nil || forwardedServer.Headers.CustomRequestHeaders["X-Forwarded-Server"] != "proxy-1" {
		t.Fatalf("forwarded server middleware was not preserved: %#v", forwardedServer)
	}
	tcpRouter := config.TCP.Routers[resourceName("tcp", "service-tcp", "tcp-route")]
	if tcpRouter.TLS == nil || !tcpRouter.TLS.Passthrough {
		t.Fatalf("TCP TLS passthrough was not preserved: %#v", tcpRouter)
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
	reversedHTTP := []TraefikRoute{routes[1], routes[0]}
	reversedHTTP[1].Upstreams = []Upstream{routes[0].Upstreams[1], routes[0].Upstreams[0]}
	reversedTCP := append([]TraefikTCPRoute(nil), tcpRoutes...)
	reversedTCP[0].Upstreams = []string{tcpRoutes[0].Upstreams[1], tcpRoutes[0].Upstreams[0]}
	reversedUDP := append([]TraefikUDPRoute(nil), udpRoutes...)
	reversedUDP[0].Upstreams = []string{udpRoutes[0].Upstreams[1], udpRoutes[0].Upstreams[0]}
	reversed, err := CompileRoutes(reversedHTTP, reversedTCP, reversedUDP, "proxy-1")
	if err != nil {
		t.Fatal(err)
	}
	if HashRoutesConfig(reversed) != HashRoutesConfig(compiled) {
		t.Fatal("routes config hash depends on route or upstream order")
	}
}

func TestHashRoutesConfigDoesNotMutateInput(t *testing.T) {
	config := &RoutesConfig{config: traefikFullConfigWithMiddlewares{
		HTTP: httpConfigWithMiddlewares{Services: map[string]service{
			"service": {LoadBalancer: loadBalancer{Servers: []server{
				{URL: "http://10.0.0.2:3000"},
				{URL: "http://10.0.0.1:3000"},
			}}},
		}},
	}}

	HashRoutesConfig(config)
	servers := config.config.HTTP.Services["service"].LoadBalancer.Servers
	if servers[0].URL != "http://10.0.0.2:3000" || servers[1].URL != "http://10.0.0.1:3000" {
		t.Fatalf("hashing reordered its input: %#v", servers)
	}
}
