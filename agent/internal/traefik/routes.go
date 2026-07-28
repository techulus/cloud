package traefik

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sort"
)

type RoutesConfig struct {
	config traefikFullConfigWithMiddlewares
}

func resourceName(kind, serviceID, routeID string) string {
	canonical, _ := json.Marshal(struct {
		ServiceID string `json:"serviceId"`
		RouteID   string `json:"routeId"`
	}{serviceID, routeID})
	hash := sha256.Sum256(canonical)
	return kind + "-" + hex.EncodeToString(hash[:])
}

func HTTPRouteOwners(routes []TraefikRoute) map[string]string {
	owners := make(map[string]string)
	for _, route := range routes {
		if len(route.Upstreams) != 0 {
			owners[resourceName("http", route.ServiceId, route.ID)] = route.ServiceId
		}
	}
	return owners
}

func HashRoutesConfig(config *RoutesConfig) string {
	if config == nil {
		return ""
	}
	data, err := json.Marshal(config.config)
	if err != nil {
		return ""
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func GetCurrentConfigHash() string {
	config, err := readCurrentFullConfig()
	if err != nil {
		log.Printf("[traefik:hash] failed to read config: %v", err)
		return ""
	}
	return HashRoutesConfig(&RoutesConfig{config: *config})
}

func normalizeFullConfig(config *traefikFullConfigWithMiddlewares) {
	if config.HTTP.Routers == nil {
		config.HTTP.Routers = map[string]routerWithMiddleware{}
	}
	if config.HTTP.Services == nil {
		config.HTTP.Services = map[string]service{}
	}
	if config.HTTP.Middlewares == nil {
		config.HTTP.Middlewares = map[string]middleware{}
	}
	if config.TCP.Routers == nil {
		config.TCP.Routers = map[string]tcpRouter{}
	}
	if config.TCP.Services == nil {
		config.TCP.Services = map[string]tcpService{}
	}
	if config.UDP.Routers == nil {
		config.UDP.Routers = map[string]udpRouter{}
	}
	if config.UDP.Services == nil {
		config.UDP.Services = map[string]udpService{}
	}
	for key, router := range config.HTTP.Routers {
		if router.EntryPoints == nil {
			router.EntryPoints = []string{}
		}
		if router.Middlewares == nil {
			router.Middlewares = []string{}
		}
		sort.Strings(router.EntryPoints)
		sort.Strings(router.Middlewares)
		config.HTTP.Routers[key] = router
	}
	for key, svc := range config.HTTP.Services {
		if svc.LoadBalancer.Servers == nil {
			svc.LoadBalancer.Servers = []server{}
		}
		sort.Slice(svc.LoadBalancer.Servers, func(i, j int) bool {
			if svc.LoadBalancer.Servers[i].URL != svc.LoadBalancer.Servers[j].URL {
				return svc.LoadBalancer.Servers[i].URL < svc.LoadBalancer.Servers[j].URL
			}
			return weight(svc.LoadBalancer.Servers[i]) < weight(svc.LoadBalancer.Servers[j])
		})
		config.HTTP.Services[key] = svc
	}
	for key, router := range config.TCP.Routers {
		if router.EntryPoints == nil {
			router.EntryPoints = []string{}
		}
		sort.Strings(router.EntryPoints)
		config.TCP.Routers[key] = router
	}
	for key, svc := range config.TCP.Services {
		if svc.LoadBalancer.Servers == nil {
			svc.LoadBalancer.Servers = []tcpServer{}
		}
		sort.Slice(svc.LoadBalancer.Servers, func(i, j int) bool { return svc.LoadBalancer.Servers[i].Address < svc.LoadBalancer.Servers[j].Address })
		config.TCP.Services[key] = svc
	}
	for key, router := range config.UDP.Routers {
		if router.EntryPoints == nil {
			router.EntryPoints = []string{}
		}
		sort.Strings(router.EntryPoints)
		config.UDP.Routers[key] = router
	}
	for key, svc := range config.UDP.Services {
		if svc.LoadBalancer.Servers == nil {
			svc.LoadBalancer.Servers = []udpServer{}
		}
		sort.Slice(svc.LoadBalancer.Servers, func(i, j int) bool { return svc.LoadBalancer.Servers[i].Address < svc.LoadBalancer.Servers[j].Address })
		config.UDP.Services[key] = svc
	}
}

func weight(server server) int {
	if server.Weight == nil {
		return 0
	}
	return *server.Weight
}

func duplicateResource(kind, name string) error {
	return fmt.Errorf("duplicate %s route %s", kind, name)
}
