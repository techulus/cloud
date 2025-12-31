package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"techulus/cloud-agent/internal/api"
	"techulus/cloud-agent/internal/caddy"
	"techulus/cloud-agent/internal/crypto"
	"techulus/cloud-agent/internal/dns"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/logs"
	"techulus/cloud-agent/internal/podman"
	"techulus/cloud-agent/internal/reconcile"
	"techulus/cloud-agent/internal/retry"
	"techulus/cloud-agent/internal/wireguard"

	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
)

const (
	defaultDataDir       = "/var/lib/techulus-agent"
	tickInterval         = 10 * time.Second
	processingTimeout    = 5 * time.Minute
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
	ServerID      string `json:"serverId"`
	SubnetID      int    `json:"subnetId"`
	WireGuardIP   string `json:"wireguardIp"`
	EncryptionKey string `json:"encryptionKey"`
}

type ActualState struct {
	Containers      []podman.Container
	DnsConfigHash   string
	CaddyConfigHash string
	WireguardHash   string
}

type Agent struct {
	state           AgentState
	client          *agenthttp.Client
	reconciler      *reconcile.Reconciler
	config          *Config
	publicIP        string
	dataDir         string
	expectedState   *agenthttp.ExpectedState
	processingStart time.Time
	logCollector    *logs.Collector
}

func NewAgent(client *agenthttp.Client, reconciler *reconcile.Reconciler, config *Config, publicIP, dataDir string, logCollector *logs.Collector) *Agent {
	return &Agent{
		state:        StateIdle,
		client:       client,
		reconciler:   reconciler,
		config:       config,
		publicIP:     publicIP,
		dataDir:      dataDir,
		logCollector: logCollector,
	}
}

func (a *Agent) Run(ctx context.Context) {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	var logTickerC <-chan time.Time
	if a.logCollector != nil {
		a.logCollector.Start()
		logTicker := time.NewTicker(5 * time.Second)
		defer logTicker.Stop()
		logTickerC = logTicker.C
	}

	a.tick()

	for {
		select {
		case <-ctx.Done():
			if a.logCollector != nil {
				a.logCollector.Stop()
			}
			return
		case <-ticker.C:
			a.tick()
		case <-logTickerC:
			a.collectLogs()
		}
	}
}

func (a *Agent) collectLogs() {
	if a.logCollector == nil {
		return
	}

	containers, err := podman.ListContainers()
	if err != nil {
		return
	}

	var containerInfos []logs.ContainerInfo
	for _, c := range containers {
		if c.DeploymentID == "" || c.ServiceID == "" {
			continue
		}
		if c.State != "running" {
			continue
		}
		containerInfos = append(containerInfos, logs.ContainerInfo{
			DeploymentID: c.DeploymentID,
			ServiceID:    c.ServiceID,
			ContainerID:  c.ID,
		})
	}

	a.logCollector.UpdateContainers(containerInfos)
	a.logCollector.Collect()
}

func (a *Agent) tick() {
	switch a.state {
	case StateIdle:
		a.handleIdle()
	case StateProcessing:
		a.handleProcessing()
	}
}

func (a *Agent) handleIdle() {
	expected, err := a.client.GetExpectedState()
	if err != nil {
		log.Printf("[idle] failed to get expected state: %v", err)
		return
	}

	actual, err := a.getActualState()
	if err != nil {
		log.Printf("[idle] failed to get actual state: %v", err)
		return
	}

	changes := a.detectChanges(expected, actual)
	if len(changes) > 0 {
		log.Printf("[idle] drift detected, %d change(s) to apply:", len(changes))
		for _, change := range changes {
			log.Printf("  → %s", change)
		}
		log.Printf("[idle] transitioning to PROCESSING")
		a.expectedState = expected
		a.processingStart = time.Now()
		a.state = StateProcessing
		a.reportStatus(false)
		return
	}

	a.reportStatus(true)
}

func (a *Agent) detectChanges(expected *agenthttp.ExpectedState, actual *ActualState) []string {
	var changes []string

	expectedMap := make(map[string]agenthttp.ExpectedContainer)
	for _, c := range expected.Containers {
		expectedMap[c.DeploymentID] = c
	}

	actualMap := make(map[string]podman.Container)
	for _, c := range actual.Containers {
		if c.DeploymentID != "" {
			actualMap[c.DeploymentID] = c
		}
	}

	for _, c := range actual.Containers {
		if c.DeploymentID == "" {
			changes = append(changes, fmt.Sprintf("STOP orphan container %s (no deployment ID)", c.Name))
		}
	}

	for id, act := range actualMap {
		if _, exists := expectedMap[id]; !exists {
			changes = append(changes, fmt.Sprintf("STOP orphan container %s (deployment %s not in expected state)", act.Name, id[:8]))
		}
	}

	for id, exp := range expectedMap {
		if _, exists := actualMap[id]; !exists {
			changes = append(changes, fmt.Sprintf("DEPLOY %s (%s)", exp.Name, exp.Image))
		}
	}

	for id, exp := range expectedMap {
		if act, exists := actualMap[id]; exists {
			if act.State == "created" || act.State == "exited" {
				changes = append(changes, fmt.Sprintf("START %s (state: %s)", exp.Name, act.State))
			} else if act.State != "running" {
				changes = append(changes, fmt.Sprintf("RESTART %s (state: %s)", exp.Name, act.State))
			} else if normalizeImage(exp.Image) != normalizeImage(act.Image) {
				changes = append(changes, fmt.Sprintf("REDEPLOY %s (image: %s → %s)", exp.Name, act.Image, exp.Image))
			}
		}
	}

	expectedDnsRecords := make([]dns.DnsRecord, len(expected.Dns.Records))
	for i, r := range expected.Dns.Records {
		expectedDnsRecords[i] = dns.DnsRecord{Name: r.Name, Ips: r.Ips}
	}
	expectedDnsHash := dns.HashRecords(expectedDnsRecords)
	log.Printf("[dns:hash] expected: %d records, hash=%s, current=%s", len(expectedDnsRecords), expectedDnsHash, actual.DnsConfigHash)
	if expectedDnsHash != actual.DnsConfigHash {
		changes = append(changes, fmt.Sprintf("UPDATE DNS (%d records)", len(expected.Dns.Records)))
	}

	expectedCaddyRoutes := make([]caddy.CaddyRoute, len(expected.Caddy.Routes))
	for i, r := range expected.Caddy.Routes {
		expectedCaddyRoutes[i] = caddy.CaddyRoute{ID: r.ID, Domain: r.Domain, Upstreams: r.Upstreams}
	}
	expectedCaddyHash := caddy.HashRoutes(expectedCaddyRoutes)
	log.Printf("[caddy:hash] expected: %d routes, hash=%s, current=%s", len(expectedCaddyRoutes), expectedCaddyHash, actual.CaddyConfigHash)
	if expectedCaddyHash != actual.CaddyConfigHash {
		changes = append(changes, fmt.Sprintf("UPDATE Caddy (%d routes)", len(expected.Caddy.Routes)))
	}

	expectedWgPeers := make([]wireguard.Peer, len(expected.Wireguard.Peers))
	for i, p := range expected.Wireguard.Peers {
		expectedWgPeers[i] = wireguard.Peer{
			PublicKey:  p.PublicKey,
			AllowedIPs: p.AllowedIPs,
			Endpoint:   p.Endpoint,
		}
	}
	expectedWgHash := wireguard.HashPeers(expectedWgPeers)
	log.Printf("[wg:hash] expected: %d peers, hash=%s, current=%s", len(expectedWgPeers), expectedWgHash, actual.WireguardHash)
	if expectedWgHash != actual.WireguardHash {
		changes = append(changes, fmt.Sprintf("UPDATE WireGuard (%d peers)", len(expected.Wireguard.Peers)))
	}

	return changes
}

func (a *Agent) handleProcessing() {
	if time.Since(a.processingStart) > processingTimeout {
		log.Printf("[processing] timeout after %v, forcing transition to IDLE", processingTimeout)
		a.reportStatus(false)
		a.state = StateIdle
		return
	}

	actual, err := a.getActualState()
	if err != nil {
		log.Printf("[processing] failed to get actual state: %v", err)
		a.reportStatus(false)
		a.state = StateIdle
		return
	}

	if !a.hasDrift(a.expectedState, actual) {
		log.Printf("[processing] state converged, transitioning to IDLE")
		a.reportStatus(false)
		a.state = StateIdle
		return
	}

	err = a.reconcileOne(actual)
	if err != nil {
		log.Printf("[processing] reconciliation failed: %v, transitioning to IDLE", err)
		a.reportStatus(false)
		a.state = StateIdle
		return
	}

	a.reportStatus(false)
}

func (a *Agent) getActualState() (*ActualState, error) {
	containers, err := podman.ListContainers()
	if err != nil {
		return nil, fmt.Errorf("failed to list containers: %w", err)
	}
	return &ActualState{
		Containers:      containers,
		DnsConfigHash:   dns.GetCurrentConfigHash(),
		CaddyConfigHash: caddy.GetCurrentConfigHash(),
		WireguardHash:   wireguard.GetCurrentPeersHash(),
	}, nil
}

func (a *Agent) hasDrift(expected *agenthttp.ExpectedState, actual *ActualState) bool {
	if a.hasContainerDrift(expected.Containers, actual.Containers) {
		return true
	}

	expectedDnsRecords := make([]dns.DnsRecord, len(expected.Dns.Records))
	for i, r := range expected.Dns.Records {
		expectedDnsRecords[i] = dns.DnsRecord{Name: r.Name, Ips: r.Ips}
	}
	if dns.HashRecords(expectedDnsRecords) != actual.DnsConfigHash {
		return true
	}

	expectedCaddyRoutes := make([]caddy.CaddyRoute, len(expected.Caddy.Routes))
	for i, r := range expected.Caddy.Routes {
		expectedCaddyRoutes[i] = caddy.CaddyRoute{ID: r.ID, Domain: r.Domain, Upstreams: r.Upstreams}
	}
	if caddy.HashRoutes(expectedCaddyRoutes) != actual.CaddyConfigHash {
		return true
	}

	expectedWgPeers := make([]wireguard.Peer, len(expected.Wireguard.Peers))
	for i, p := range expected.Wireguard.Peers {
		expectedWgPeers[i] = wireguard.Peer{
			PublicKey:  p.PublicKey,
			AllowedIPs: p.AllowedIPs,
			Endpoint:   p.Endpoint,
		}
	}
	if wireguard.HashPeers(expectedWgPeers) != actual.WireguardHash {
		return true
	}

	return false
}

func (a *Agent) hasContainerDrift(expected []agenthttp.ExpectedContainer, actual []podman.Container) bool {
	expectedMap := make(map[string]agenthttp.ExpectedContainer)
	for _, c := range expected {
		expectedMap[c.DeploymentID] = c
	}

	actualMap := make(map[string]podman.Container)
	for _, c := range actual {
		if c.DeploymentID != "" {
			actualMap[c.DeploymentID] = c
		}
	}

	for _, c := range actual {
		if c.DeploymentID == "" {
			return true
		}
	}

	for id := range expectedMap {
		if _, exists := actualMap[id]; !exists {
			return true
		}
	}

	for id := range actualMap {
		if _, exists := expectedMap[id]; !exists {
			return true
		}
	}

	for id, exp := range expectedMap {
		if act, exists := actualMap[id]; exists {
			if act.State != "running" || normalizeImage(exp.Image) != normalizeImage(act.Image) {
				return true
			}
		}
	}

	return false
}

func normalizeImage(image string) string {
	parts := strings.Split(image, "@")
	image = parts[0]

	if !strings.Contains(image, ":") {
		image = image + ":latest"
	}
	return image
}

func (a *Agent) reconcileOne(actual *ActualState) error {
	expectedMap := make(map[string]agenthttp.ExpectedContainer)
	for _, c := range a.expectedState.Containers {
		expectedMap[c.DeploymentID] = c
	}

	actualMap := make(map[string]podman.Container)
	for _, c := range actual.Containers {
		if c.DeploymentID != "" {
			actualMap[c.DeploymentID] = c
		}
	}

	for _, act := range actual.Containers {
		if act.DeploymentID == "" {
			if act.State == "running" {
				log.Printf("[reconcile] stopping orphan container %s (no deployment ID)", act.ID)
				if err := podman.Stop(act.ID); err != nil {
					return fmt.Errorf("failed to stop orphan container: %w", err)
				}
				return nil
			} else {
				log.Printf("[reconcile] removing orphan container %s (no deployment ID)", act.ID)
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				err := retry.WithBackoff(ctx, retry.ForceRemoveBackoff, func() (bool, error) {
					if err := podman.ForceRemove(act.ID); err != nil {
						log.Printf("[reconcile] remove attempt failed: %v, retrying...", err)
						return false, err
					}
					return true, nil
				})
				cancel()
				if err != nil {
					log.Printf("[reconcile] warning: failed to remove orphan container after retries: %v", err)
				}
				return nil
			}
		}
	}

	for id, act := range actualMap {
		if _, exists := expectedMap[id]; !exists {
			if act.State == "running" {
				log.Printf("[reconcile] stopping orphan container %s (deployment %s not in expected state)", act.Name, id[:8])
				if err := podman.Stop(act.ID); err != nil {
					return fmt.Errorf("failed to stop orphan container: %w", err)
				}
				return nil
			} else {
				log.Printf("[reconcile] removing orphan container %s (deployment %s not in expected state)", act.Name, id[:8])
				if err := podman.ForceRemove(act.ID); err != nil {
					log.Printf("[reconcile] warning: failed to remove orphan: %v", err)
				}
				return nil
			}
		}
	}

	for id, exp := range expectedMap {
		if _, exists := actualMap[id]; !exists {
			log.Printf("[reconcile] deploying missing container for deployment %s", id)
			if err := a.reconciler.Deploy(exp); err != nil {
				return fmt.Errorf("failed to deploy container: %w", err)
			}
			return nil
		}
	}

	for id, exp := range expectedMap {
		if act, exists := actualMap[id]; exists {
			if act.State == "created" || act.State == "exited" {
				log.Printf("[reconcile] starting %s container %s for deployment %s", act.State, act.ID, id)
				if err := podman.Start(act.ID); err != nil {
					log.Printf("[reconcile] start failed, will redeploy: %v", err)
					if err := podman.Stop(act.ID); err != nil {
						log.Printf("[reconcile] warning: failed to stop old container: %v", err)
					}
					if err := a.reconciler.Deploy(exp); err != nil {
						return fmt.Errorf("failed to redeploy container: %w", err)
					}
				}
				return nil
			}
			if act.State != "running" || normalizeImage(exp.Image) != normalizeImage(act.Image) {
				log.Printf("[reconcile] redeploying container for deployment %s (state=%s)", id, act.State)
				if err := podman.Stop(act.ID); err != nil {
					log.Printf("[reconcile] warning: failed to stop old container: %v", err)
				}
				if err := a.reconciler.Deploy(exp); err != nil {
					return fmt.Errorf("failed to redeploy container: %w", err)
				}
				return nil
			}
		}
	}

	expectedDnsRecords := make([]dns.DnsRecord, len(a.expectedState.Dns.Records))
	for i, r := range a.expectedState.Dns.Records {
		expectedDnsRecords[i] = dns.DnsRecord{Name: r.Name, Ips: r.Ips}
	}
	if dns.HashRecords(expectedDnsRecords) != actual.DnsConfigHash {
		log.Printf("[reconcile] updating DNS records")
		if err := dns.UpdateDnsRecords(expectedDnsRecords); err != nil {
			return fmt.Errorf("failed to update DNS: %w", err)
		}
		return nil
	}

	expectedCaddyRoutes := make([]caddy.CaddyRoute, len(a.expectedState.Caddy.Routes))
	for i, r := range a.expectedState.Caddy.Routes {
		expectedCaddyRoutes[i] = caddy.CaddyRoute{ID: r.ID, Domain: r.Domain, Upstreams: r.Upstreams}
	}
	if caddy.HashRoutes(expectedCaddyRoutes) != actual.CaddyConfigHash {
		log.Printf("[reconcile] updating Caddy routes")
		if err := caddy.UpdateCaddyRoutes(expectedCaddyRoutes); err != nil {
			return fmt.Errorf("failed to update Caddy: %w", err)
		}
		return nil
	}

	expectedWgPeers := make([]wireguard.Peer, len(a.expectedState.Wireguard.Peers))
	for i, p := range a.expectedState.Wireguard.Peers {
		expectedWgPeers[i] = wireguard.Peer{
			PublicKey:  p.PublicKey,
			AllowedIPs: p.AllowedIPs,
			Endpoint:   p.Endpoint,
		}
	}
	if wireguard.HashPeers(expectedWgPeers) != actual.WireguardHash {
		log.Printf("[reconcile] updating WireGuard peers")
		if err := a.reconcileWireguard(expectedWgPeers); err != nil {
			return fmt.Errorf("failed to update WireGuard: %w", err)
		}
		return nil
	}

	return nil
}

func (a *Agent) reconcileWireguard(peers []wireguard.Peer) error {
	wgPrivateKey, err := wireguard.LoadPrivateKey(a.dataDir)
	if err != nil {
		return fmt.Errorf("failed to load wireguard private key: %w", err)
	}

	wgConfig := &wireguard.Config{
		PrivateKey: wgPrivateKey,
		Address:    a.config.WireGuardIP,
		ListenPort: wireguard.DefaultPort,
		Peers:      peers,
	}

	if err := wireguard.WriteConfig(wireguard.DefaultInterface, wgConfig); err != nil {
		return fmt.Errorf("failed to write wireguard config: %w", err)
	}

	if err := wireguard.Reload(wireguard.DefaultInterface); err != nil {
		return fmt.Errorf("failed to reload wireguard: %w", err)
	}

	log.Printf("[wireguard] config updated successfully")
	return nil
}

func (a *Agent) reportStatus(includeResources bool) {
	report := &agenthttp.StatusReport{
		PublicIP:   a.publicIP,
		Containers: []agenthttp.ContainerStatus{},
	}

	if includeResources {
		report.Resources = getSystemStats()
	}

	containers, err := podman.ListContainers()
	if err == nil {
		for _, c := range containers {
			if c.DeploymentID == "" {
				continue
			}

			status := "stopped"
			if c.State == "running" {
				status = "running"
			} else if c.State == "exited" {
				status = "stopped"
			}

			healthStatus := "none"
			if c.State == "running" {
				healthStatus = podman.GetHealthStatus(c.ID)
			}

			report.Containers = append(report.Containers, agenthttp.ContainerStatus{
				DeploymentID: c.DeploymentID,
				ContainerID:  c.ID,
				Status:       status,
				HealthStatus: healthStatus,
			})
		}
	}

	if err := a.client.ReportStatus(report); err != nil {
		log.Printf("[status] failed to report status: %v", err)
	}
}

var httpClient *api.Client
var dataDir string

func main() {
	var (
		controlPlaneURL string
		token           string
		logsEndpoint    string
	)

	flag.StringVar(&controlPlaneURL, "url", "", "Control plane URL (required)")
	flag.StringVar(&token, "token", "", "Registration token (required for first run)")
	flag.StringVar(&dataDir, "data-dir", defaultDataDir, "Data directory for agent state")
	flag.StringVar(&logsEndpoint, "logs-endpoint", "", "VictoriaLogs endpoint URL (enables logging)")
	flag.Parse()

	if controlPlaneURL == "" {
		log.Fatal("--url is required")
	}

	if err := wireguard.CheckPrerequisites(); err != nil {
		log.Fatalf("WireGuard prerequisites check failed: %v", err)
	}

	if err := podman.CheckPrerequisites(); err != nil {
		log.Fatalf("Podman prerequisites check failed: %v", err)
	}

	if err := caddy.CheckPrerequisites(); err != nil {
		log.Fatalf("Caddy prerequisites check failed: %v", err)
	}

	if err := os.MkdirAll(dataDir, 0700); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	keyDir := filepath.Join(dataDir, "keys")
	configPath := filepath.Join(dataDir, "config.json")

	httpClient = api.NewClient(controlPlaneURL)

	var signingKeyPair *crypto.KeyPair
	var config *Config
	var err error

	if crypto.KeyPairExists(keyDir) {
		log.Println("Loading existing signing key pair...")
		signingKeyPair, err = crypto.LoadKeyPair(keyDir)
		if err != nil {
			log.Fatalf("Failed to load signing key pair: %v", err)
		}

		config, err = loadConfig(configPath)
		if err != nil {
			log.Fatalf("Failed to load config: %v", err)
		}

		log.Printf("Loaded config: serverID=%s, subnetId=%d, wireguardIP=%s", config.ServerID, config.SubnetID, config.WireGuardIP)

		if err := dns.SetupLocalDNS(config.WireGuardIP); err != nil {
			log.Printf("Warning: Failed to setup local DNS: %v", err)
		}

		if err := podman.EnsureNetwork(config.SubnetID); err != nil {
			log.Printf("Warning: Failed to ensure container network: %v", err)
		}
	} else {
		if token == "" {
			log.Fatal("--token is required for first-time registration")
		}

		log.Println("Generating signing key pair (Ed25519)...")
		signingKeyPair, err = crypto.GenerateKeyPair()
		if err != nil {
			log.Fatalf("Failed to generate signing key pair: %v", err)
		}

		if err := signingKeyPair.SaveToFile(keyDir); err != nil {
			log.Fatalf("Failed to save signing key pair: %v", err)
		}

		log.Println("Generating WireGuard key pair (Curve25519)...")
		wgPrivateKey, wgPublicKey, err := wireguard.GenerateKeyPair()
		if err != nil {
			log.Fatalf("Failed to generate WireGuard key pair: %v", err)
		}

		if err := wireguard.SavePrivateKey(dataDir, wgPrivateKey); err != nil {
			log.Fatalf("Failed to save WireGuard private key: %v", err)
		}

		log.Println("Registering with control plane...")
		publicIP := getPublicIP()
		resp, err := httpClient.Register(token, wgPublicKey, signingKeyPair.PublicKeyBase64(), publicIP)
		if err != nil {
			log.Fatalf("Failed to register: %v", err)
		}

		config = &Config{
			ServerID:      resp.ServerID,
			SubnetID:      resp.SubnetID,
			WireGuardIP:   resp.WireGuardIP,
			EncryptionKey: resp.EncryptionKey,
		}

		if err := saveConfig(configPath, config); err != nil {
			log.Fatalf("Failed to save config: %v", err)
		}

		log.Printf("Registration successful! serverID=%s, subnetId=%d, wireguardIP=%s", config.ServerID, config.SubnetID, config.WireGuardIP)
		log.Printf("Received %d peers", len(resp.Peers))

		wgConfig := &wireguard.Config{
			PrivateKey: wgPrivateKey,
			Address:    config.WireGuardIP,
			ListenPort: wireguard.DefaultPort,
			Peers:      convertPeers(resp.Peers),
		}

		log.Println("Writing WireGuard config...")
		if err := wireguard.WriteConfig(wireguard.DefaultInterface, wgConfig); err != nil {
			log.Fatalf("Failed to write WireGuard config: %v", err)
		}

		log.Println("Bringing up WireGuard interface...")
		if err := wireguard.Up(wireguard.DefaultInterface); err != nil {
			log.Fatalf("Failed to bring up WireGuard: %v", err)
		}

		log.Println("WireGuard interface is up!")

		log.Println("Setting up local DNS (dnsmasq)...")
		if err := dns.SetupLocalDNS(config.WireGuardIP); err != nil {
			log.Printf("Warning: Failed to setup local DNS: %v", err)
		} else {
			log.Println("Local DNS configured successfully")
		}

		log.Println("Ensuring container network exists...")
		if err := podman.EnsureNetwork(config.SubnetID); err != nil {
			log.Printf("Warning: Failed to create container network: %v", err)
		} else {
			log.Println("Container network ready")
		}
	}

	reconciler := reconcile.NewReconciler(config.EncryptionKey)
	client := agenthttp.NewClient(controlPlaneURL, config.ServerID, signingKeyPair)

	var logCollector *logs.Collector
	if logsEndpoint != "" {
		log.Println("[logs] log collection enabled, endpoint:", logsEndpoint)
		logCollector = logs.NewCollector(logs.NewVictoriaLogsSender(logsEndpoint), dataDir)
	}

	ctx, cancel := context.WithCancel(context.Background())

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-stop
		log.Println("Shutting down...")
		cancel()
	}()

	publicIP := getPublicIP()
	log.Printf("Agent started. Public IP: %s. Tick interval: %v", publicIP, tickInterval)

	agent := NewAgent(client, reconciler, config, publicIP, dataDir, logCollector)
	agent.Run(ctx)

	log.Println("Agent stopped")
}

func convertPeers(apiPeers []api.Peer) []wireguard.Peer {
	peers := make([]wireguard.Peer, len(apiPeers))
	for i, p := range apiPeers {
		peers[i] = wireguard.Peer{
			PublicKey:  p.PublicKey,
			AllowedIPs: p.AllowedIPs,
			Endpoint:   p.Endpoint,
		}
	}
	return peers
}

func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	return &config, nil
}

func saveConfig(path string, config *Config) error {
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

func getSystemStats() *agenthttp.Resources {
	resources := &agenthttp.Resources{}

	resources.CpuCores = runtime.NumCPU()

	memInfo, err := mem.VirtualMemory()
	if err == nil {
		resources.MemoryMb = int(memInfo.Total / 1024 / 1024)
	}

	diskInfo, err := disk.Usage("/")
	if err == nil {
		resources.DiskGb = int(diskInfo.Total / 1024 / 1024 / 1024)
	}

	return resources
}

func getPublicIP() string {
	resp, err := http.Get("https://api.ipify.org")
	if err != nil {
		log.Printf("Failed to get public IP: %v", err)
		return ""
	}
	defer resp.Body.Close()

	ip, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("Failed to read public IP response: %v", err)
		return ""
	}

	return string(ip)
}
