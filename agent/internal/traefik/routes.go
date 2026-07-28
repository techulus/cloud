package traefik

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"sort"
	"strings"
)

func HashRoutes(routes []TraefikRoute) string {
	sortedRoutes := make([]TraefikRoute, len(routes))
	copy(sortedRoutes, routes)
	sort.Slice(sortedRoutes, func(i, j int) bool {
		if sortedRoutes[i].ServiceId != sortedRoutes[j].ServiceId {
			return sortedRoutes[i].ServiceId < sortedRoutes[j].ServiceId
		}
		if sortedRoutes[i].ID != sortedRoutes[j].ID {
			return sortedRoutes[i].ID < sortedRoutes[j].ID
		}
		return sortedRoutes[i].Domain < sortedRoutes[j].Domain
	})

	var sb strings.Builder
	for _, r := range sortedRoutes {
		sb.WriteString(r.ServiceId)
		sb.WriteString(":")
		sb.WriteString(r.ID)
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

func HashRoutesWithServerName(routes []TraefikRoute, serverName string) string {
	base := HashRoutes(routes)
	hash := sha256.Sum256([]byte(base + "|server:" + serverName))
	return hex.EncodeToString(hash[:])
}

func GetCurrentConfigHash() string {
	config, err := readCurrentFullConfig()
	if err != nil {
		log.Printf("[traefik:hash] failed to read config: %v", err)
		return ""
	}

	var routes []TraefikRoute
	for routerName, router := range config.HTTP.Routers {
		domain := extractDomainFromRule(router.Rule)
		serviceId, routeID := parseHTTPRouteName(routerName)

		var upstreams []Upstream
		if svc, exists := config.HTTP.Services[router.Service]; exists {
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
			ID:        routeID,
			Domain:    domain,
			Upstreams: upstreams,
			ServiceId: serviceId,
		})
	}

	serverName := extractForwardedServerName(config.HTTP.Middlewares)

	return HashRoutesWithServerName(routes, serverName)
}

func parseHTTPRouteName(name string) (string, string) {
	name = strings.SplitN(name, "@", 2)[0]
	parts := strings.SplitN(name, "--", 2)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return name, name
}

func extractForwardedServerName(middlewares map[string]middleware) string {
	if mw, exists := middlewares["forwarded_server"]; exists && mw.Headers != nil {
		if value, ok := mw.Headers.CustomRequestHeaders["X-Forwarded-Server"]; ok {
			return value
		}
	}
	return ""
}

func extractDomainFromRule(rule string) string {
	rule = strings.TrimPrefix(rule, "Host(`")
	rule = strings.TrimSuffix(rule, "`)")
	return rule
}
