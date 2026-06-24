package agent

import (
	"sync"
	"time"

	"techulus/cloud-agent/internal/build"
	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/health"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/logs"
	"techulus/cloud-agent/internal/reconcile"
)

const (
	TickInterval         = 15 * time.Second
	ProcessingTimeout    = 5 * time.Minute
	BuildCleanupInterval = 1 * time.Hour
)

type AgentState int

const (
	StateIdle AgentState = iota
	StateProcessing
)

type Config struct {
	ServerID         string `json:"serverId"`
	SubnetID         int    `json:"subnetId"`
	WireGuardIP      string `json:"wireguardIp"`
	EncryptionKey    string `json:"encryptionKey"`
	IsProxy          bool   `json:"isProxy"`
	LoggingEndpoint  string `json:"loggingEndpoint,omitempty"`
	MetricsEndpoint  string `json:"metricsEndpoint,omitempty"`
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
	state                       AgentState
	stateMutex                  sync.RWMutex
	reconcileRequested          chan struct{}
	statusReportRequested       chan string
	refreshMutex                sync.Mutex
	pendingExpectedStateRefresh bool
	workMutex                   sync.Mutex
	activeWorkItem              *agenthttp.WorkQueueItem
	pendingWorkResults          []agenthttp.CompletedWorkItem
	Client                      *agenthttp.Client
	Reconciler                  *reconcile.Reconciler
	Config                      *Config
	PublicIP                    string
	PrivateIP                   string
	DataDir                     string
	expectedState               *agenthttp.ExpectedState
	processingStart             time.Time
	LogCollector                *logs.Collector
	TraefikLogCollector         *logs.TraefikCollector
	MetricsSender               MetricsSender
	Builder                     *build.Builder
	isBuilding                  bool
	buildMutex                  sync.Mutex
	currentBuildID              string
	IsProxy                     bool
	dnsInSync                   bool
	DisableDNS                  bool
}

func NewAgent(
	client *agenthttp.Client,
	reconciler *reconcile.Reconciler,
	config *Config,
	publicIP, privateIP, dataDir string,
	logCollector *logs.Collector,
	traefikLogCollector *logs.TraefikCollector,
	metricsSender MetricsSender,
	builder *build.Builder,
	isProxy bool,
	disableDNS bool,
) *Agent {
	return &Agent{
		state:                 StateIdle,
		reconcileRequested:    make(chan struct{}, 1),
		statusReportRequested: make(chan string, 1),
		Client:                client,
		Reconciler:            reconciler,
		Config:                config,
		PublicIP:              publicIP,
		PrivateIP:             privateIP,
		DataDir:               dataDir,
		LogCollector:          logCollector,
		TraefikLogCollector:   traefikLogCollector,
		MetricsSender:         metricsSender,
		Builder:               builder,
		IsProxy:               isProxy,
		DisableDNS:            disableDNS,
	}
}

type MetricsSender interface {
	SendSystemStats(stats *health.SystemStats, collectedAt time.Time) error
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
