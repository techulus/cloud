package agent

import (
	"sync"
	"time"

	"techulus/cloud-agent/internal/build"
	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/logs"
	"techulus/cloud-agent/internal/reconcile"
)

const (
	TickInterval         = 60 * time.Second
	ProcessingTimeout    = 5 * time.Minute
	BuildCleanupInterval = 1 * time.Hour
)

type AgentState int

const (
	StateIdle AgentState = iota
	StateProcessing
)

func (s AgentState) String() string {
	switch s {
	case StateIdle:
		return "IDLE"
	case StateProcessing:
		return "PROCESSING"
	default:
		return "UNKNOWN"
	}
}

type Config struct {
	ServerID         string `json:"serverId"`
	SubnetID         int    `json:"subnetId"`
	WireGuardIP      string `json:"wireguardIp"`
	EncryptionKey    string `json:"encryptionKey"`
	IsProxy          bool   `json:"isProxy"`
	LoggingEndpoint  string `json:"loggingEndpoint,omitempty"`
	RegistryURL      string `json:"registryUrl,omitempty"`
	RegistryUsername string `json:"registryUsername,omitempty"`
	RegistryPassword string `json:"registryPassword,omitempty"`
	RegistryInsecure bool   `json:"registryInsecure"`
}

type ActualState struct {
	Containers            []container.Container
	DnsConfigHash         string
	TraefikConfigHash     string
	L4ConfigHash          string
	CertificatesHash      string
	ChallengeRouteWritten bool
	WireguardHash         string
}

type Agent struct {
	state               AgentState
	stateMutex          sync.RWMutex
	Client              *agenthttp.Client
	Reconciler          *reconcile.Reconciler
	Config              *Config
	PublicIP            string
	PrivateIP           string
	DataDir             string
	expectedState       *agenthttp.ExpectedState
	processingStart     time.Time
	LogCollector        *logs.Collector
	TraefikLogCollector *logs.TraefikCollector
	Builder             *build.Builder
	isBuilding          bool
	buildMutex          sync.Mutex
	currentBuildID      string
	IsProxy             bool
	dnsInSync           bool
	DisableDNS          bool
}

func NewAgent(
	client *agenthttp.Client,
	reconciler *reconcile.Reconciler,
	config *Config,
	publicIP, privateIP, dataDir string,
	logCollector *logs.Collector,
	traefikLogCollector *logs.TraefikCollector,
	builder *build.Builder,
	isProxy bool,
	disableDNS bool,
) *Agent {
	return &Agent{
		state:               StateIdle,
		Client:              client,
		Reconciler:          reconciler,
		Config:              config,
		PublicIP:            publicIP,
		PrivateIP:           privateIP,
		DataDir:             dataDir,
		LogCollector:        logCollector,
		TraefikLogCollector: traefikLogCollector,
		Builder:             builder,
		IsProxy:             isProxy,
		DisableDNS:          disableDNS,
	}
}

func (a *Agent) GetState() AgentState {
	a.stateMutex.RLock()
	defer a.stateMutex.RUnlock()
	return a.state
}

func (a *Agent) SetState(state AgentState) {
	a.stateMutex.Lock()
	defer a.stateMutex.Unlock()
	a.state = state
}
