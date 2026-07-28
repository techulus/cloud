package traefik

import (
	"fmt"
	"log"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

func ValidateTCPPort(port int) error {
	if port < TCPPortStart || port > TCPPortEnd {
		return fmt.Errorf("TCP port %d outside allowed range %d-%d", port, TCPPortStart, TCPPortEnd)
	}
	return nil
}

func ValidateUDPPort(port int) error {
	if port < UDPPortStart || port > UDPPortEnd {
		return fmt.Errorf("UDP port %d outside allowed range %d-%d", port, UDPPortStart, UDPPortEnd)
	}
	return nil
}

func ValidateL4Routes(tcpRoutes []TraefikTCPRoute, udpRoutes []TraefikUDPRoute) error {
	for _, route := range tcpRoutes {
		if err := ValidateTCPPort(route.ExternalPort); err != nil {
			return fmt.Errorf("invalid TCP route %s: %w", route.ID, err)
		}
	}
	for _, route := range udpRoutes {
		if err := ValidateUDPPort(route.ExternalPort); err != nil {
			return fmt.Errorf("invalid UDP route %s: %w", route.ID, err)
		}
	}
	return nil
}

// CompileRoutes is the single pure compiler for the durable routes.yaml model.
func CompileRoutes(httpRoutes []TraefikRoute, tcpRoutes []TraefikTCPRoute, udpRoutes []TraefikUDPRoute, serverName string) (*RoutesConfig, error) {
	if err := ValidateL4Routes(tcpRoutes, udpRoutes); err != nil {
		return nil, fmt.Errorf("port validation failed: %w", err)
	}
	config := traefikFullConfigWithMiddlewares{
		HTTP: httpConfigWithMiddlewares{Routers: map[string]routerWithMiddleware{}, Services: map[string]service{}, Middlewares: map[string]middleware{}},
		TCP:  tcpConfig{Routers: map[string]tcpRouter{}, Services: map[string]tcpService{}},
		UDP:  udpConfig{Routers: map[string]udpRouter{}, Services: map[string]udpService{}},
	}
	var middlewareNames []string
	if serverName != "" {
		config.HTTP.Middlewares["forwarded_server"] = middleware{Headers: &headersMiddleware{CustomRequestHeaders: map[string]string{"X-Forwarded-Server": serverName}}}
		middlewareNames = []string{"forwarded_server@file"}
	}
	for _, route := range httpRoutes {
		if len(route.Upstreams) == 0 {
			continue
		}
		name := resourceName("http", route.ServiceId, route.ID)
		if _, exists := config.HTTP.Routers[name]; exists {
			return nil, duplicateResource("HTTP", name)
		}
		config.HTTP.Routers[name] = routerWithMiddleware{Rule: fmt.Sprintf("Host(`%s`)", route.Domain), EntryPoints: []string{"websecure"}, Service: name, TLS: &tlsConfig{}, Middlewares: middlewareNames}
		servers := make([]server, len(route.Upstreams))
		for i, upstream := range route.Upstreams {
			servers[i] = server{URL: fmt.Sprintf("http://%s", upstream.URL)}
			if upstream.Weight > 0 {
				servers[i].Weight = &route.Upstreams[i].Weight
			}
		}
		config.HTTP.Services[name] = service{LoadBalancer: loadBalancer{Servers: servers}}
	}
	for _, route := range tcpRoutes {
		if len(route.Upstreams) == 0 {
			continue
		}
		name := resourceName("tcp", route.ServiceId, route.ID)
		if _, exists := config.TCP.Routers[name]; exists {
			return nil, duplicateResource("TCP", name)
		}
		router := tcpRouter{Rule: "HostSNI(`*`)", EntryPoints: []string{fmt.Sprintf("tcp-%d", route.ExternalPort)}, Service: name}
		if route.TLSPassthrough {
			router.TLS = &tcpTLSConfig{Passthrough: true}
		}
		config.TCP.Routers[name] = router
		servers := make([]tcpServer, len(route.Upstreams))
		for i, upstream := range route.Upstreams {
			servers[i] = tcpServer{Address: upstream}
		}
		config.TCP.Services[name] = tcpService{LoadBalancer: tcpLoadBalancer{Servers: servers}}
	}
	for _, route := range udpRoutes {
		if len(route.Upstreams) == 0 {
			continue
		}
		name := resourceName("udp", route.ServiceId, route.ID)
		if _, exists := config.UDP.Routers[name]; exists {
			return nil, duplicateResource("UDP", name)
		}
		config.UDP.Routers[name] = udpRouter{EntryPoints: []string{fmt.Sprintf("udp-%d", route.ExternalPort)}, Service: name}
		servers := make([]udpServer, len(route.Upstreams))
		for i, upstream := range route.Upstreams {
			servers[i] = udpServer{Address: upstream}
		}
		config.UDP.Services[name] = udpService{LoadBalancer: udpLoadBalancer{Servers: servers}}
	}
	return &RoutesConfig{config: config}, nil
}

func WriteRoutesConfig(compiled *RoutesConfig) error {
	if compiled == nil {
		return fmt.Errorf("routes config is nil")
	}
	data, err := yaml.Marshal(compiled.config)
	if err != nil {
		return fmt.Errorf("failed to marshal traefik config: %w", err)
	}
	if err := os.MkdirAll(dynamicConfigDir, 0755); err != nil {
		return fmt.Errorf("failed to create dynamic config dir: %w", err)
	}
	routesPath := filepath.Join(dynamicConfigDir, routesFileName)
	tmp, err := os.CreateTemp(dynamicConfigDir, routesFileName+".tmp-")
	if err != nil {
		return fmt.Errorf("failed to create temp config: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0644); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("failed to write temp config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, routesPath); err != nil {
		return fmt.Errorf("failed to rename config file: %w", err)
	}
	log.Printf("[traefik] routes updated successfully")
	return nil
}

func readCurrentFullConfig() (*traefikFullConfigWithMiddlewares, error) {
	path := filepath.Join(dynamicConfigDir, routesFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		config := &traefikFullConfigWithMiddlewares{}
		normalizeFullConfig(config)
		return config, nil
	}
	var config traefikFullConfigWithMiddlewares
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	normalizeFullConfig(&config)
	return &config, nil
}
