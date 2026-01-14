package agent

import (
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/traefik"
)

func Truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

func ConvertToHttpRoutes(routes []agenthttp.TraefikRoute) []traefik.TraefikRoute {
	httpRoutes := make([]traefik.TraefikRoute, len(routes))
	for i, r := range routes {
		upstreams := make([]traefik.Upstream, len(r.Upstreams))
		for j, u := range r.Upstreams {
			upstreams[j] = traefik.Upstream{URL: u.Url, Weight: u.Weight}
		}
		httpRoutes[i] = traefik.TraefikRoute{ID: r.ID, Domain: r.Domain, Upstreams: upstreams, ServiceId: r.ServiceId}
	}
	return httpRoutes
}

func ConvertToTCPRoutes(routes []agenthttp.TraefikTCPRoute) []traefik.TraefikTCPRoute {
	tcpRoutes := make([]traefik.TraefikTCPRoute, len(routes))
	for i, r := range routes {
		tcpRoutes[i] = traefik.TraefikTCPRoute{
			ID:             r.ID,
			ServiceId:      r.ServiceId,
			Upstreams:      r.Upstreams,
			ExternalPort:   r.ExternalPort,
			TLSPassthrough: r.TLSPassthrough,
		}
	}
	return tcpRoutes
}

func ConvertToUDPRoutes(routes []agenthttp.TraefikUDPRoute) []traefik.TraefikUDPRoute {
	udpRoutes := make([]traefik.TraefikUDPRoute, len(routes))
	for i, r := range routes {
		udpRoutes[i] = traefik.TraefikUDPRoute{
			ID:           r.ID,
			ServiceId:    r.ServiceId,
			Upstreams:    r.Upstreams,
			ExternalPort: r.ExternalPort,
		}
	}
	return udpRoutes
}
