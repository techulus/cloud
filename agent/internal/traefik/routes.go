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

func UpdateHttpRoutes(routes []TraefikRoute) error {
	config := traefikConfig{
		HTTP: httpConfig{
			Routers:  make(map[string]router),
			Services: make(map[string]service),
		},
	}

	for _, route := range routes {
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

	log.Printf("[traefik] updating %d routes", len(routes))

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

func VerifyRouteExists(routeID string, expectedDomain string) (bool, error) {
	config, err := readCurrentConfig()
	if err != nil {
		return false, err
	}

	router, exists := config.HTTP.Routers[routeID]
	if !exists {
		return false, nil
	}

	expectedRule := fmt.Sprintf("Host(`%s`)", expectedDomain)
	return router.Rule == expectedRule, nil
}

func readCurrentConfig() (*traefikConfig, error) {
	routesPath := filepath.Join(traefikDynamicDir, routesFileName)
	data, err := os.ReadFile(routesPath)
	if err != nil {
		if os.IsNotExist(err) {
			return &traefikConfig{
				HTTP: httpConfig{
					Routers:  make(map[string]router),
					Services: make(map[string]service),
				},
			}, nil
		}
		return nil, err
	}

	var config traefikConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	if config.HTTP.Routers == nil {
		config.HTTP.Routers = make(map[string]router)
	}
	if config.HTTP.Services == nil {
		config.HTTP.Services = make(map[string]service)
	}

	return &config, nil
}

func HashRoutes(routes []TraefikRoute) string {
	sortedRoutes := make([]TraefikRoute, len(routes))
	copy(sortedRoutes, routes)
	sort.Slice(sortedRoutes, func(i, j int) bool {
		return sortedRoutes[i].ServiceId < sortedRoutes[j].ServiceId
	})

	var sb strings.Builder
	for _, r := range sortedRoutes {
		sb.WriteString(r.ServiceId)
		sb.WriteString(":")
		sb.WriteString(r.Domain)
		sb.WriteString(":")
		sortedUpstreams := make([]Upstream, len(r.Upstreams))
		copy(sortedUpstreams, r.Upstreams)
		sort.Slice(sortedUpstreams, func(i, j int) bool {
			return sortedUpstreams[i].URL < sortedUpstreams[j].URL
		})
		for _, u := range sortedUpstreams {
			sb.WriteString(u.URL)
			sb.WriteString("@")
			sb.WriteString(fmt.Sprintf("%d", u.Weight))
			sb.WriteString(",")
		}
		sb.WriteString("|")
	}
	hash := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(hash[:])
}

func GetCurrentConfigHash() string {
	config, err := readCurrentConfig()
	if err != nil {
		log.Printf("[traefik:hash] failed to read config: %v", err)
		return ""
	}

	var routes []TraefikRoute
	for serviceId, router := range config.HTTP.Routers {
		domain := extractDomainFromRule(router.Rule)

		var upstreams []Upstream
		if svc, exists := config.HTTP.Services[serviceId]; exists {
			for _, server := range svc.LoadBalancer.Servers {
				url := strings.TrimPrefix(server.URL, "http://")
				weight := 1
				if server.Weight != nil {
					weight = *server.Weight
				}
				upstreams = append(upstreams, Upstream{
					URL:    url,
					Weight: weight,
				})
			}
		}

		routes = append(routes, TraefikRoute{
			ID:        serviceId,
			Domain:    domain,
			Upstreams: upstreams,
			ServiceId: serviceId,
		})
	}

	return HashRoutes(routes)
}

func extractDomainFromRule(rule string) string {
	rule = strings.TrimPrefix(rule, "Host(`")
	rule = strings.TrimSuffix(rule, "`)")
	return rule
}
