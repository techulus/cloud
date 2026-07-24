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

// CompiledTraefikState is the routing data of one expected-state snapshot
// converted and hashed exactly once. Reconciliation planning, Traefik
// application, and routing-sync reporting all consume the same compiled
// snapshot so they can never disagree on convergence.
type CompiledTraefikState struct {
	HTTP         []traefik.TraefikRoute
	TCP          []traefik.TraefikTCPRoute
	UDP          []traefik.TraefikUDPRoute
	Certificates []traefik.Certificate
	TCPPorts     []int
	UDPPorts     []int

	HTTPHash string
	L4Hash   string
	CertHash string
}

func CompileTraefikState(expected *agenthttp.ExpectedState) *CompiledTraefikState {
	httpRoutes := ConvertToHttpRoutes(expected.Traefik.HttpRoutes)
	tcpRoutes := ConvertToTCPRoutes(expected.Traefik.TCPRoutes)
	udpRoutes := ConvertToUDPRoutes(expected.Traefik.UDPRoutes)

	certificates := make([]traefik.Certificate, len(expected.Traefik.Certificates))
	for i, c := range expected.Traefik.Certificates {
		certificates[i] = traefik.Certificate{
			Domain:         c.Domain,
			Certificate:    c.Certificate,
			CertificateKey: c.CertificateKey,
		}
	}

	var tcpPorts, udpPorts []int
	for _, r := range tcpRoutes {
		tcpPorts = append(tcpPorts, r.ExternalPort)
	}
	for _, r := range udpRoutes {
		udpPorts = append(udpPorts, r.ExternalPort)
	}

	return &CompiledTraefikState{
		HTTP:         httpRoutes,
		TCP:          tcpRoutes,
		UDP:          udpRoutes,
		Certificates: certificates,
		TCPPorts:     tcpPorts,
		UDPPorts:     udpPorts,
		HTTPHash:     traefik.HashRoutesWithServerName(httpRoutes, expected.ServerName),
		L4Hash:       traefik.HashTCPRoutes(tcpRoutes) + traefik.HashUDPRoutes(udpRoutes),
		CertHash:     traefik.HashCertificates(certificates),
	}
}

// compiledTraefikState memoizes CompileTraefikState per expected-state
// snapshot. Snapshots are immutable once received, so identity of the
// pointer is enough to key the cache.
func (a *Agent) compiledTraefikState(expected *agenthttp.ExpectedState) *CompiledTraefikState {
	a.compiledTraefikMutex.Lock()
	defer a.compiledTraefikMutex.Unlock()

	if a.compiledTraefikFor != expected || a.compiledTraefik == nil {
		a.compiledTraefik = CompileTraefikState(expected)
		a.compiledTraefikFor = expected
	}
	return a.compiledTraefik
}
