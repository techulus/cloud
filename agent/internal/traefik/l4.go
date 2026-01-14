package traefik

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

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

func UpdateHttpRoutesWithL4(httpRoutes []TraefikRoute, tcpRoutes []TraefikTCPRoute, udpRoutes []TraefikUDPRoute) error {
	if err := ValidateL4Routes(tcpRoutes, udpRoutes); err != nil {
		return fmt.Errorf("port validation failed: %w", err)
	}

	config := traefikFullConfig{
		HTTP: httpConfig{
			Routers:  make(map[string]router),
			Services: make(map[string]service),
		},
		TCP: tcpConfig{
			Routers:  make(map[string]tcpRouter),
			Services: make(map[string]tcpService),
		},
		UDP: udpConfig{
			Routers:  make(map[string]udpRouter),
			Services: make(map[string]udpService),
		},
	}

	for _, route := range httpRoutes {
		if len(route.Upstreams) == 0 {
			continue
		}

		config.HTTP.Routers[route.ServiceId] = router{
			Rule:        fmt.Sprintf("Host(`%s`)", route.Domain),
			EntryPoints: []string{"websecure"},
			Service:     route.ServiceId,
			TLS:         &tlsConfig{},
		}

		servers := make([]server, len(route.Upstreams))
		for i, upstream := range route.Upstreams {
			srv := server{URL: fmt.Sprintf("http://%s", upstream.URL)}
			if upstream.Weight > 0 {
				srv.Weight = &upstream.Weight
			}
			servers[i] = srv
		}

		config.HTTP.Services[route.ServiceId] = service{
			LoadBalancer: loadBalancer{
				Servers: servers,
			},
		}
	}

	for _, route := range tcpRoutes {
		if len(route.Upstreams) == 0 {
			continue
		}

		routerName := fmt.Sprintf("tcp_%s_%d", route.ServiceId, route.ExternalPort)
		entryPoint := fmt.Sprintf("tcp-%d", route.ExternalPort)

		tcpRtr := tcpRouter{
			Rule:        "HostSNI(`*`)",
			EntryPoints: []string{entryPoint},
			Service:     routerName,
		}

		if route.TLSPassthrough {
			tcpRtr.TLS = &tcpTLSConfig{Passthrough: true}
		}

		config.TCP.Routers[routerName] = tcpRtr

		servers := make([]tcpServer, len(route.Upstreams))
		for i, upstream := range route.Upstreams {
			servers[i] = tcpServer{Address: upstream}
		}

		config.TCP.Services[routerName] = tcpService{
			LoadBalancer: tcpLoadBalancer{
				Servers: servers,
			},
		}
	}

	for _, route := range udpRoutes {
		if len(route.Upstreams) == 0 {
			continue
		}

		routerName := fmt.Sprintf("udp_%s_%d", route.ServiceId, route.ExternalPort)
		entryPoint := fmt.Sprintf("udp-%d", route.ExternalPort)

		config.UDP.Routers[routerName] = udpRouter{
			EntryPoints: []string{entryPoint},
			Service:     routerName,
		}

		servers := make([]udpServer, len(route.Upstreams))
		for i, upstream := range route.Upstreams {
			servers[i] = udpServer{Address: upstream}
		}

		config.UDP.Services[routerName] = udpService{
			LoadBalancer: udpLoadBalancer{
				Servers: servers,
			},
		}
	}

	log.Printf("[traefik] updating routes: %d HTTP, %d TCP, %d UDP", len(httpRoutes), len(tcpRoutes), len(udpRoutes))

	data, err := yaml.Marshal(config)
	if err != nil {
		return fmt.Errorf("failed to marshal traefik config: %w", err)
	}

	if err := os.MkdirAll(traefikDynamicDir, 0755); err != nil {
		return fmt.Errorf("failed to create dynamic config dir: %w", err)
	}

	routesPath := filepath.Join(traefikDynamicDir, routesFileName)
	tmpPath := routesPath + ".tmp"

	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write temp config: %w", err)
	}

	if err := os.Rename(tmpPath, routesPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("failed to rename config file: %w", err)
	}

	log.Printf("[traefik] routes updated successfully")
	return nil
}

func HashTCPRoutes(routes []TraefikTCPRoute) string {
	sortedRoutes := make([]TraefikTCPRoute, len(routes))
	copy(sortedRoutes, routes)
	sort.Slice(sortedRoutes, func(i, j int) bool {
		return sortedRoutes[i].ServiceId < sortedRoutes[j].ServiceId
	})

	var sb strings.Builder
	for _, r := range sortedRoutes {
		sb.WriteString(r.ServiceId)
		sb.WriteString(":")
		sb.WriteString(fmt.Sprintf("%d", r.ExternalPort))
		sb.WriteString(":")
		sb.WriteString(fmt.Sprintf("%t", r.TLSPassthrough))
		sb.WriteString(":")
		sortedUpstreams := make([]string, len(r.Upstreams))
		copy(sortedUpstreams, r.Upstreams)
		sort.Strings(sortedUpstreams)
		for _, u := range sortedUpstreams {
			sb.WriteString(u)
			sb.WriteString(",")
		}
		sb.WriteString("|")
	}
	hash := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(hash[:])
}

func HashUDPRoutes(routes []TraefikUDPRoute) string {
	sortedRoutes := make([]TraefikUDPRoute, len(routes))
	copy(sortedRoutes, routes)
	sort.Slice(sortedRoutes, func(i, j int) bool {
		return sortedRoutes[i].ServiceId < sortedRoutes[j].ServiceId
	})

	var sb strings.Builder
	for _, r := range sortedRoutes {
		sb.WriteString(r.ServiceId)
		sb.WriteString(":")
		sb.WriteString(fmt.Sprintf("%d", r.ExternalPort))
		sb.WriteString(":")
		sortedUpstreams := make([]string, len(r.Upstreams))
		copy(sortedUpstreams, r.Upstreams)
		sort.Strings(sortedUpstreams)
		for _, u := range sortedUpstreams {
			sb.WriteString(u)
			sb.WriteString(",")
		}
		sb.WriteString("|")
	}
	hash := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(hash[:])
}

func GetCurrentL4ConfigHash() string {
	config, err := readCurrentFullConfig()
	if err != nil {
		log.Printf("[traefik:hash] failed to read config: %v", err)
		return ""
	}

	var tcpRoutes []TraefikTCPRoute
	for routerName, rtr := range config.TCP.Routers {
		var externalPort int
		var serviceId string
		fmt.Sscanf(routerName, "tcp_%s_%d", &serviceId, &externalPort)

		for _, ep := range rtr.EntryPoints {
			fmt.Sscanf(ep, "tcp-%d", &externalPort)
		}

		parts := strings.Split(routerName, "_")
		if len(parts) >= 2 {
			serviceId = parts[1]
		}

		var upstreams []string
		if svc, exists := config.TCP.Services[routerName]; exists {
			for _, s := range svc.LoadBalancer.Servers {
				upstreams = append(upstreams, s.Address)
			}
		}

		tlsPassthrough := false
		if rtr.TLS != nil {
			tlsPassthrough = rtr.TLS.Passthrough
		}

		tcpRoutes = append(tcpRoutes, TraefikTCPRoute{
			ID:             routerName,
			ServiceId:      serviceId,
			Upstreams:      upstreams,
			ExternalPort:   externalPort,
			TLSPassthrough: tlsPassthrough,
		})
	}

	var udpRoutes []TraefikUDPRoute
	for routerName, rtr := range config.UDP.Routers {
		var externalPort int
		var serviceId string

		for _, ep := range rtr.EntryPoints {
			fmt.Sscanf(ep, "udp-%d", &externalPort)
		}

		parts := strings.Split(routerName, "_")
		if len(parts) >= 2 {
			serviceId = parts[1]
		}

		var upstreams []string
		if svc, exists := config.UDP.Services[routerName]; exists {
			for _, s := range svc.LoadBalancer.Servers {
				upstreams = append(upstreams, s.Address)
			}
		}

		udpRoutes = append(udpRoutes, TraefikUDPRoute{
			ID:           routerName,
			ServiceId:    serviceId,
			Upstreams:    upstreams,
			ExternalPort: externalPort,
		})
	}

	return HashTCPRoutes(tcpRoutes) + HashUDPRoutes(udpRoutes)
}

func readCurrentFullConfig() (*traefikFullConfig, error) {
	routesPath := filepath.Join(traefikDynamicDir, routesFileName)
	data, err := os.ReadFile(routesPath)
	if err != nil {
		if os.IsNotExist(err) {
			return &traefikFullConfig{
				HTTP: httpConfig{
					Routers:  make(map[string]router),
					Services: make(map[string]service),
				},
				TCP: tcpConfig{
					Routers:  make(map[string]tcpRouter),
					Services: make(map[string]tcpService),
				},
				UDP: udpConfig{
					Routers:  make(map[string]udpRouter),
					Services: make(map[string]udpService),
				},
			}, nil
		}
		return nil, err
	}

	var config traefikFullConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	if config.HTTP.Routers == nil {
		config.HTTP.Routers = make(map[string]router)
	}
	if config.HTTP.Services == nil {
		config.HTTP.Services = make(map[string]service)
	}
	if config.TCP.Routers == nil {
		config.TCP.Routers = make(map[string]tcpRouter)
	}
	if config.TCP.Services == nil {
		config.TCP.Services = make(map[string]tcpService)
	}
	if config.UDP.Routers == nil {
		config.UDP.Routers = make(map[string]udpRouter)
	}
	if config.UDP.Services == nil {
		config.UDP.Services = make(map[string]udpService)
	}

	return &config, nil
}
