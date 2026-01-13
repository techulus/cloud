package traefik

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	traefikStaticConfigPath = "/etc/traefik/traefik.yaml"
	traefikDynamicDir       = "/etc/traefik/dynamic"
	traefikCertsDir         = "/etc/traefik/certs"
	routesFileName          = "routes.yaml"
	tlsFileName             = "tls.yaml"
	challengesFileName      = "challenges.yaml"

	TCPPortStart = 10000
	TCPPortEnd   = 10999
	UDPPortStart = 11000
	UDPPortEnd   = 11999
)

func CheckPrerequisites() error {
	if _, err := exec.LookPath("traefik"); err != nil {
		return fmt.Errorf("traefik command not found: %w", err)
	}
	return nil
}

type Upstream struct {
	URL    string
	Weight int
}

type TraefikRoute struct {
	ID        string
	Domain    string
	Upstreams []Upstream
	ServiceId string
}

type traefikConfig struct {
	HTTP httpConfig `yaml:"http"`
}

type httpConfig struct {
	Routers  map[string]router  `yaml:"routers,omitempty"`
	Services map[string]service `yaml:"services,omitempty"`
}

type router struct {
	Rule        string      `yaml:"rule"`
	EntryPoints []string    `yaml:"entryPoints"`
	Service     string      `yaml:"service"`
	TLS         *tlsConfig  `yaml:"tls,omitempty"`
	Priority    int         `yaml:"priority,omitempty"`
}

type tlsConfig struct{}

type tlsFileConfig struct {
	TLS tlsSection `yaml:"tls"`
}

type tlsSection struct {
	Certificates []certEntry `yaml:"certificates"`
}

type certEntry struct {
	CertFile string `yaml:"certFile"`
	KeyFile  string `yaml:"keyFile"`
}

type Certificate struct {
	Domain         string
	Certificate    string
	CertificateKey string
}

type service struct {
	LoadBalancer loadBalancer `yaml:"loadBalancer"`
}

type loadBalancer struct {
	Servers []server `yaml:"servers"`
}

type server struct {
	URL    string `yaml:"url"`
	Weight *int   `yaml:"weight,omitempty"`
}

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
		// Sort upstreams by URL for consistent hashing
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
				weight := 1 // default weight
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

func UpdateCertificates(certs []Certificate) error {
	if err := os.MkdirAll(traefikCertsDir, 0700); err != nil {
		return fmt.Errorf("failed to create certs dir: %w", err)
	}

	for _, cert := range certs {
		certPath := filepath.Join(traefikCertsDir, cert.Domain+".crt")
		keyPath := filepath.Join(traefikCertsDir, cert.Domain+".key")

		if err := atomicWrite(certPath, []byte(cert.Certificate), 0600); err != nil {
			return fmt.Errorf("failed to write cert for %s: %w", cert.Domain, err)
		}
		if err := atomicWrite(keyPath, []byte(cert.CertificateKey), 0600); err != nil {
			return fmt.Errorf("failed to write key for %s: %w", cert.Domain, err)
		}
	}

	return writeTLSConfig(certs)
}

func writeTLSConfig(certs []Certificate) error {
	config := tlsFileConfig{
		TLS: tlsSection{
			Certificates: make([]certEntry, len(certs)),
		},
	}

	for i, cert := range certs {
		config.TLS.Certificates[i] = certEntry{
			CertFile: filepath.Join(traefikCertsDir, cert.Domain+".crt"),
			KeyFile:  filepath.Join(traefikCertsDir, cert.Domain+".key"),
		}
	}

	data, err := yaml.Marshal(config)
	if err != nil {
		return fmt.Errorf("failed to marshal TLS config: %w", err)
	}

	if err := os.MkdirAll(traefikDynamicDir, 0755); err != nil {
		return fmt.Errorf("failed to create dynamic config dir: %w", err)
	}

	tlsPath := filepath.Join(traefikDynamicDir, tlsFileName)
	if err := atomicWrite(tlsPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write TLS config: %w", err)
	}

	log.Printf("[traefik] TLS config updated with %d certificates", len(certs))
	return nil
}

type middleware struct {
	RedirectScheme    *redirectScheme    `yaml:"redirectScheme,omitempty"`
	StripPrefix       *stripPrefix       `yaml:"stripPrefix,omitempty"`
	ReplacePathRegex  *replacePathRegex  `yaml:"replacePathRegex,omitempty"`
	Headers           *headersMiddleware `yaml:"headers,omitempty"`
}

type headersMiddleware struct {
	CustomRequestHeaders map[string]string `yaml:"customRequestHeaders,omitempty"`
}

type replacePathRegex struct {
	Regex       string `yaml:"regex"`
	Replacement string `yaml:"replacement"`
}

type redirectScheme struct {
	Scheme    string `yaml:"scheme"`
	Permanent bool   `yaml:"permanent"`
}

type stripPrefix struct {
	Prefixes []string `yaml:"prefixes"`
}

type addPrefix struct {
	Prefix string `yaml:"prefix"`
}

type httpConfigWithMiddlewares struct {
	Routers     map[string]routerWithMiddleware `yaml:"routers,omitempty"`
	Services    map[string]service              `yaml:"services,omitempty"`
	Middlewares map[string]middleware           `yaml:"middlewares,omitempty"`
}

type routerWithMiddleware struct {
	Rule        string   `yaml:"rule"`
	EntryPoints []string `yaml:"entryPoints"`
	Service     string   `yaml:"service,omitempty"`
	Priority    int      `yaml:"priority,omitempty"`
	Middlewares []string `yaml:"middlewares,omitempty"`
}

type challengeConfig struct {
	HTTP httpConfigWithMiddlewares `yaml:"http"`
}

func controlPlaneHost(controlPlaneUrl string) string {
	// Extract hostname from URL (e.g., "https://techulus.cloud" -> "techulus.cloud")
	if strings.HasPrefix(controlPlaneUrl, "https://") {
		return strings.TrimPrefix(controlPlaneUrl, "https://")
	}
	if strings.HasPrefix(controlPlaneUrl, "http://") {
		return strings.TrimPrefix(controlPlaneUrl, "http://")
	}
	return controlPlaneUrl
}

func WriteChallengeRoute(controlPlaneUrl string) error {
	config := challengeConfig{
		HTTP: httpConfigWithMiddlewares{
			Routers: map[string]routerWithMiddleware{
				"acme_challenge": {
					Rule:        "PathPrefix(`/.well-known/acme-challenge/`)",
					EntryPoints: []string{"web"},
					Service:     "acme_challenge_svc",
					Middlewares: []string{"acme_rewrite@file", "acme_headers@file"},
					Priority:    9999,
				},
				"http_to_https": {
					Rule:        "HostRegexp(`.*`)",
					EntryPoints: []string{"web"},
					Middlewares: []string{"redirect_https@file"},
					Service:     "noop@internal",
					Priority:    1,
				},
			},
			Services: map[string]service{
				"acme_challenge_svc": {
					LoadBalancer: loadBalancer{
						Servers: []server{
							{URL: controlPlaneUrl},
						},
					},
				},
			},
			Middlewares: map[string]middleware{
				"acme_rewrite": {
					ReplacePathRegex: &replacePathRegex{
						Regex:       "^/.well-known/acme-challenge/(.*)",
						Replacement: "/api/v1/acme/challenge/$1",
					},
				},
				"acme_headers": {
					Headers: &headersMiddleware{
						CustomRequestHeaders: map[string]string{
							"Host": controlPlaneHost(controlPlaneUrl),
						},
					},
				},
				"redirect_https": {
					RedirectScheme: &redirectScheme{
						Scheme:    "https",
						Permanent: true,
					},
				},
			},
		},
	}

	data, err := yaml.Marshal(config)
	if err != nil {
		return fmt.Errorf("failed to marshal challenge route config: %w", err)
	}

	if err := os.MkdirAll(traefikDynamicDir, 0755); err != nil {
		return fmt.Errorf("failed to create dynamic config dir: %w", err)
	}

	challengePath := filepath.Join(traefikDynamicDir, challengesFileName)
	if err := atomicWrite(challengePath, data, 0644); err != nil {
		return fmt.Errorf("failed to write challenge route config: %w", err)
	}

	log.Printf("[traefik] challenge route written pointing to %s", controlPlaneUrl)
	return nil
}

func atomicWrite(path string, data []byte, perm os.FileMode) error {
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, perm); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}

func HashCertificates(certs []Certificate) string {
	sortedCerts := make([]Certificate, len(certs))
	copy(sortedCerts, certs)
	sort.Slice(sortedCerts, func(i, j int) bool {
		return sortedCerts[i].Domain < sortedCerts[j].Domain
	})

	var sb strings.Builder
	for _, c := range sortedCerts {
		sb.WriteString(c.Domain)
		sb.WriteString(":")
		h := sha256.Sum256([]byte(c.Certificate + "|" + c.CertificateKey))
		sb.WriteString(hex.EncodeToString(h[:8]))
		sb.WriteString("|")
	}
	hash := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(hash[:])
}

func GetCurrentCertificatesHash() string {
	certs, err := readCurrentCertificates()
	if err != nil {
		log.Printf("[traefik:hash] failed to read certs: %v", err)
		return ""
	}
	return HashCertificates(certs)
}

func readCurrentCertificates() ([]Certificate, error) {
	tlsPath := filepath.Join(traefikDynamicDir, tlsFileName)
	data, err := os.ReadFile(tlsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var config tlsFileConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	var certs []Certificate
	for _, entry := range config.TLS.Certificates {
		domain := strings.TrimSuffix(filepath.Base(entry.CertFile), ".crt")
		certData, err := os.ReadFile(entry.CertFile)
		if err != nil {
			log.Printf("[traefik] warning: failed to read cert file %s: %v", entry.CertFile, err)
			continue
		}
		keyData, err := os.ReadFile(entry.KeyFile)
		if err != nil {
			log.Printf("[traefik] warning: failed to read key file %s: %v", entry.KeyFile, err)
			continue
		}
		certs = append(certs, Certificate{
			Domain:         domain,
			Certificate:    string(certData),
			CertificateKey: string(keyData),
		})
	}

	return certs, nil
}

func ChallengeRouteExists() bool {
	challengePath := filepath.Join(traefikDynamicDir, challengesFileName)
	_, err := os.Stat(challengePath)
	return err == nil
}

type TraefikTCPRoute struct {
	ID             string
	ServiceId      string
	Upstreams      []string
	ExternalPort   int
	TLSPassthrough bool
}

type TraefikUDPRoute struct {
	ID           string
	ServiceId    string
	Upstreams    []string
	ExternalPort int
}

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

type tcpConfig struct {
	Routers  map[string]tcpRouter  `yaml:"routers,omitempty"`
	Services map[string]tcpService `yaml:"services,omitempty"`
}

type tcpRouter struct {
	Rule        string        `yaml:"rule"`
	EntryPoints []string      `yaml:"entryPoints"`
	Service     string        `yaml:"service"`
	TLS         *tcpTLSConfig `yaml:"tls,omitempty"`
}

type tcpTLSConfig struct {
	Passthrough bool `yaml:"passthrough"`
}

type tcpService struct {
	LoadBalancer tcpLoadBalancer `yaml:"loadBalancer"`
}

type tcpLoadBalancer struct {
	Servers []tcpServer `yaml:"servers"`
}

type tcpServer struct {
	Address string `yaml:"address"`
}

type udpConfig struct {
	Routers  map[string]udpRouter  `yaml:"routers,omitempty"`
	Services map[string]udpService `yaml:"services,omitempty"`
}

type udpRouter struct {
	EntryPoints []string `yaml:"entryPoints"`
	Service     string   `yaml:"service"`
}

type udpService struct {
	LoadBalancer udpLoadBalancer `yaml:"loadBalancer"`
}

type udpLoadBalancer struct {
	Servers []udpServer `yaml:"servers"`
}

type udpServer struct {
	Address string `yaml:"address"`
}

type traefikFullConfig struct {
	HTTP httpConfig `yaml:"http,omitempty"`
	TCP  tcpConfig  `yaml:"tcp,omitempty"`
	UDP  udpConfig  `yaml:"udp,omitempty"`
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

		tcpRouter := tcpRouter{
			Rule:        "HostSNI(`*`)",
			EntryPoints: []string{entryPoint},
			Service:     routerName,
		}

		if route.TLSPassthrough {
			tcpRouter.TLS = &tcpTLSConfig{Passthrough: true}
		}

		config.TCP.Routers[routerName] = tcpRouter

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
	for routerName, router := range config.TCP.Routers {
		var externalPort int
		var serviceId string
		fmt.Sscanf(routerName, "tcp_%s_%d", &serviceId, &externalPort)

		for _, ep := range router.EntryPoints {
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
		if router.TLS != nil {
			tlsPassthrough = router.TLS.Passthrough
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
	for routerName, router := range config.UDP.Routers {
		var externalPort int
		var serviceId string

		for _, ep := range router.EntryPoints {
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

type staticConfig struct {
	EntryPoints map[string]entryPoint `yaml:"entryPoints"`
}

type entryPoint struct {
	Address string `yaml:"address"`
}

func validateStaticConfig(data []byte) error {
	var config map[string]interface{}
	if err := yaml.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("invalid YAML syntax: %w", err)
	}

	if ep, ok := config["entryPoints"]; ok {
		entryPoints, ok := ep.(map[string]interface{})
		if !ok {
			return fmt.Errorf("entryPoints must be a map")
		}
		for name, epConfig := range entryPoints {
			epMap, ok := epConfig.(map[string]interface{})
			if !ok {
				return fmt.Errorf("entry point %q must be a map", name)
			}
			addr, ok := epMap["address"]
			if !ok {
				return fmt.Errorf("entry point %q missing required field 'address'", name)
			}
			if _, ok := addr.(string); !ok {
				return fmt.Errorf("entry point %q address must be a string", name)
			}
		}
	}

	return nil
}

func EnsureEntryPoints(tcpPorts []int, udpPorts []int) error {
	for _, port := range tcpPorts {
		if err := ValidateTCPPort(port); err != nil {
			return fmt.Errorf("invalid entry point: %w", err)
		}
	}
	for _, port := range udpPorts {
		if err := ValidateUDPPort(port); err != nil {
			return fmt.Errorf("invalid entry point: %w", err)
		}
	}

	originalData, err := os.ReadFile(traefikStaticConfigPath)
	if err != nil {
		return fmt.Errorf("failed to read static config: %w", err)
	}

	var config map[string]interface{}
	if err := yaml.Unmarshal(originalData, &config); err != nil {
		return fmt.Errorf("failed to parse static config: %w", err)
	}

	entryPoints, ok := config["entryPoints"].(map[string]interface{})
	if !ok {
		entryPoints = make(map[string]interface{})
		config["entryPoints"] = entryPoints
	}

	modified := false

	for _, port := range tcpPorts {
		name := fmt.Sprintf("tcp-%d", port)
		if _, exists := entryPoints[name]; !exists {
			entryPoints[name] = map[string]interface{}{
				"address": fmt.Sprintf(":%d", port),
			}
			modified = true
			log.Printf("[traefik] adding TCP entry point: %s", name)
		}
	}

	for _, port := range udpPorts {
		name := fmt.Sprintf("udp-%d", port)
		if _, exists := entryPoints[name]; !exists {
			entryPoints[name] = map[string]interface{}{
				"address": fmt.Sprintf(":%d/udp", port),
			}
			modified = true
			log.Printf("[traefik] adding UDP entry point: %s", name)
		}
	}

	if !modified {
		return nil
	}

	newData, err := yaml.Marshal(config)
	if err != nil {
		return fmt.Errorf("failed to marshal static config: %w", err)
	}

	if err := validateStaticConfig(newData); err != nil {
		return fmt.Errorf("config validation failed: %w", err)
	}

	if err := atomicWrite(traefikStaticConfigPath, newData, 0644); err != nil {
		return fmt.Errorf("failed to write static config: %w", err)
	}

	if err := ReloadTraefik(); err != nil {
		log.Printf("[traefik] reload failed, restoring original config")
		if restoreErr := atomicWrite(traefikStaticConfigPath, originalData, 0644); restoreErr != nil {
			return fmt.Errorf("reload failed and restore failed: reload=%w, restore=%v", err, restoreErr)
		}
		return fmt.Errorf("reload failed, original config restored: %w", err)
	}

	return nil
}

func ReloadTraefik() error {
	cmd := exec.Command("systemctl", "restart", "traefik")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to restart traefik: %w", err)
	}
	log.Printf("[traefik] restarted traefik to apply static config changes")
	return nil
}
