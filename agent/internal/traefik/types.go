package traefik

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

type Certificate struct {
	Domain         string
	Certificate    string
	CertificateKey string
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

type traefikConfig struct {
	HTTP httpConfig `yaml:"http"`
}

type httpConfig struct {
	Routers  map[string]router  `yaml:"routers,omitempty"`
	Services map[string]service `yaml:"services,omitempty"`
}

type router struct {
	Rule        string     `yaml:"rule"`
	EntryPoints []string   `yaml:"entryPoints"`
	Service     string     `yaml:"service"`
	TLS         *tlsConfig `yaml:"tls,omitempty"`
	Priority    int        `yaml:"priority,omitempty"`
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

type middleware struct {
	RedirectScheme   *redirectScheme   `yaml:"redirectScheme,omitempty"`
	StripPrefix      *stripPrefix      `yaml:"stripPrefix,omitempty"`
	ReplacePathRegex *replacePathRegex `yaml:"replacePathRegex,omitempty"`
	Headers          *headersMiddleware `yaml:"headers,omitempty"`
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

type staticConfig struct {
	EntryPoints map[string]entryPoint `yaml:"entryPoints"`
}

type entryPoint struct {
	Address string `yaml:"address"`
}
