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
	"sync"
	"syscall"
	"time"

	"techulus/cloud-agent/internal/api"
	"techulus/cloud-agent/internal/build"
	"techulus/cloud-agent/internal/crypto"
	"techulus/cloud-agent/internal/traefik"
	"techulus/cloud-agent/internal/dns"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/logs"
	"techulus/cloud-agent/internal/paths"
	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/reconcile"
	"techulus/cloud-agent/internal/retry"
	"techulus/cloud-agent/internal/wireguard"

	"github.com/hashicorp/go-sockaddr"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
)

const (
	tickInterval         = 10 * time.Second
	processingTimeout    = 5 * time.Minute
	buildCleanupInterval = 1 * time.Hour
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

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

func convertToHttpRoutes(routes []agenthttp.TraefikRoute) []traefik.TraefikRoute {
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

func convertToTCPRoutes(routes []agenthttp.TraefikTCPRoute) []traefik.TraefikTCPRoute {
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

func convertToUDPRoutes(routes []agenthttp.TraefikUDPRoute) []traefik.TraefikUDPRoute {
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

type Config struct {
	ServerID      string `json:"serverId"`
	SubnetID      int    `json:"subnetId"`
	WireGuardIP   string `json:"wireguardIp"`
	EncryptionKey string `json:"encryptionKey"`
	IsProxy       bool   `json:"isProxy"`
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
	state              AgentState
	stateMutex         sync.RWMutex
	client             *agenthttp.Client
	reconciler         *reconcile.Reconciler
	config             *Config
	publicIP           string
	privateIP          string
	dataDir            string
	expectedState        *agenthttp.ExpectedState
	processingStart      time.Time
	logCollector         *logs.Collector
	traefikLogCollector  *logs.TraefikCollector
	builder              *build.Builder
	isBuilding         bool
	buildMutex         sync.Mutex
	currentBuildID     string
	isProxy            bool
}

func NewAgent(client *agenthttp.Client, reconciler *reconcile.Reconciler, config *Config, publicIP, privateIP, dataDir string, logCollector *logs.Collector, traefikLogCollector *logs.TraefikCollector, builder *build.Builder, isProxy bool) *Agent {
	return &Agent{
		state:               StateIdle,
		client:              client,
		reconciler:          reconciler,
		config:              config,
		publicIP:            publicIP,
		privateIP:           privateIP,
		dataDir:             dataDir,
		logCollector:        logCollector,
		traefikLogCollector: traefikLogCollector,
		builder:             builder,
		isProxy:             isProxy,
	}
}

func (a *Agent) getState() AgentState {
	a.stateMutex.RLock()
	defer a.stateMutex.RUnlock()
	return a.state
}

func (a *Agent) setState(state AgentState) {
	a.stateMutex.Lock()
	defer a.stateMutex.Unlock()
	a.state = state
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

	if a.isProxy && a.traefikLogCollector != nil {
		a.traefikLogCollector.Start()
	}

	var cleanupTickerC <-chan time.Time
	if a.builder != nil {
		cleanupTicker := time.NewTicker(buildCleanupInterval)
		defer cleanupTicker.Stop()
		cleanupTickerC = cleanupTicker.C
	}

	workQueueTicker := time.NewTicker(5 * time.Second)
	defer workQueueTicker.Stop()

	go a.heartbeatLoop(ctx)

	a.tick()

	for {
		select {
		case <-ctx.Done():
			if a.logCollector != nil {
				a.logCollector.Stop()
			}
			if a.isProxy && a.traefikLogCollector != nil {
				a.traefikLogCollector.Stop()
			}
			return
		case <-ticker.C:
			a.tick()
		case <-logTickerC:
			a.collectLogs()
		case <-cleanupTickerC:
			go a.runBuildCleanup()
		case <-workQueueTicker.C:
			a.processWorkQueue()
		}
	}
}

func (a *Agent) collectLogs() {
	if a.logCollector == nil {
		return
	}

	containers, err := container.List()
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
	switch a.getState() {
	case StateIdle:
		a.handleIdle()
	case StateProcessing:
		a.handleProcessing()
	}
}

func (a *Agent) handleIdle() {
	expected, fromCache, err := a.client.GetExpectedStateWithFallback()
	if err != nil {
		log.Printf("[idle] failed to get expected state: %v", err)
		return
	}

	if fromCache {
		log.Printf("[idle] using cached state (CP unreachable)")
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
		a.setState(StateProcessing)
		if !fromCache {
			a.reportStatus(false)
		}
		return
	}

	if !fromCache {
		a.reportStatus(true)
	}
}

func (a *Agent) detectChanges(expected *agenthttp.ExpectedState, actual *ActualState) []string {
	var changes []string

	expectedMap := make(map[string]agenthttp.ExpectedContainer)
	for _, c := range expected.Containers {
		expectedMap[c.DeploymentID] = c
	}

	actualMap := make(map[string]container.Container)
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
	if expectedDnsHash != actual.DnsConfigHash {
		changes = append(changes, fmt.Sprintf("UPDATE DNS (%d records)", len(expected.Dns.Records)))
	}

	if a.isProxy {
		expectedHttpRoutes := convertToHttpRoutes(expected.Traefik.HttpRoutes)
		expectedTraefikHash := traefik.HashRoutes(expectedHttpRoutes)
		if expectedTraefikHash != actual.TraefikConfigHash {
			changes = append(changes, fmt.Sprintf("UPDATE Traefik HTTP (%d routes)", len(expected.Traefik.HttpRoutes)))
		}

		tcpRoutes := convertToTCPRoutes(expected.Traefik.TCPRoutes)
		udpRoutes := convertToUDPRoutes(expected.Traefik.UDPRoutes)
		expectedL4Hash := traefik.HashTCPRoutes(tcpRoutes) + traefik.HashUDPRoutes(udpRoutes)
		if expectedL4Hash != actual.L4ConfigHash {
			changes = append(changes, fmt.Sprintf("UPDATE Traefik L4 (%d TCP, %d UDP routes)", len(tcpRoutes), len(udpRoutes)))
		}

		expectedCerts := make([]traefik.Certificate, len(expected.Traefik.Certificates))
		for i, c := range expected.Traefik.Certificates {
			expectedCerts[i] = traefik.Certificate{Domain: c.Domain, Certificate: c.Certificate, CertificateKey: c.CertificateKey}
		}
		expectedCertsHash := traefik.HashCertificates(expectedCerts)
		if expectedCertsHash != actual.CertificatesHash {
			changes = append(changes, fmt.Sprintf("UPDATE Certificates (%d certs)", len(expected.Traefik.Certificates)))
		}

		if expected.Traefik.ChallengeRoute != nil && !actual.ChallengeRouteWritten {
			changes = append(changes, "WRITE Challenge Route")
		}
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
	if expectedWgHash != actual.WireguardHash {
		changes = append(changes, fmt.Sprintf("UPDATE WireGuard (%d peers)", len(expected.Wireguard.Peers)))
	}

	return changes
}

func (a *Agent) handleProcessing() {
	if time.Since(a.processingStart) > processingTimeout {
		log.Printf("[processing] timeout after %v, forcing transition to IDLE", processingTimeout)
		a.reportStatus(false)
		a.setState(StateIdle)
		return
	}

	actual, err := a.getActualState()
	if err != nil {
		log.Printf("[processing] failed to get actual state: %v", err)
		a.reportStatus(false)
		a.setState(StateIdle)
		return
	}

	if !a.hasDrift(a.expectedState, actual) {
		log.Printf("[processing] state converged, transitioning to IDLE")
		a.reportStatus(false)
		a.setState(StateIdle)
		return
	}

	err = a.reconcileOne(actual)
	if err != nil {
		log.Printf("[processing] reconciliation failed: %v, transitioning to IDLE", err)
		a.reportStatus(false)
		a.setState(StateIdle)
		return
	}

	a.reportStatus(false)
}

func (a *Agent) getActualState() (*ActualState, error) {
	containers, err := container.List()
	if err != nil {
		return nil, fmt.Errorf("failed to list containers: %w", err)
	}
	state := &ActualState{
		Containers:    containers,
		DnsConfigHash: dns.GetCurrentConfigHash(),
		WireguardHash: wireguard.GetCurrentPeersHash(),
	}
	if a.isProxy {
		state.TraefikConfigHash = traefik.GetCurrentConfigHash()
		state.L4ConfigHash = traefik.GetCurrentL4ConfigHash()
		state.CertificatesHash = traefik.GetCurrentCertificatesHash()
		state.ChallengeRouteWritten = traefik.ChallengeRouteExists()
	}
	return state, nil
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

	if a.isProxy {
		expectedHttpRoutes := convertToHttpRoutes(expected.Traefik.HttpRoutes)
		if traefik.HashRoutes(expectedHttpRoutes) != actual.TraefikConfigHash {
			return true
		}

		tcpRoutes := convertToTCPRoutes(expected.Traefik.TCPRoutes)
		udpRoutes := convertToUDPRoutes(expected.Traefik.UDPRoutes)
		expectedL4Hash := traefik.HashTCPRoutes(tcpRoutes) + traefik.HashUDPRoutes(udpRoutes)
		if expectedL4Hash != actual.L4ConfigHash {
			return true
		}

		expectedCerts := make([]traefik.Certificate, len(expected.Traefik.Certificates))
		for i, c := range expected.Traefik.Certificates {
			expectedCerts[i] = traefik.Certificate{Domain: c.Domain, Certificate: c.Certificate, CertificateKey: c.CertificateKey}
		}
		if traefik.HashCertificates(expectedCerts) != actual.CertificatesHash {
			return true
		}

		if expected.Traefik.ChallengeRoute != nil && !actual.ChallengeRouteWritten {
			return true
		}
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

func (a *Agent) hasContainerDrift(expected []agenthttp.ExpectedContainer, actual []container.Container) bool {
	expectedMap := make(map[string]agenthttp.ExpectedContainer)
	for _, c := range expected {
		expectedMap[c.DeploymentID] = c
	}

	actualMap := make(map[string]container.Container)
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

	image = strings.TrimPrefix(image, "docker.io/library/")
	image = strings.TrimPrefix(image, "docker.io/")

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

	actualMap := make(map[string]container.Container)
	for _, c := range actual.Containers {
		if c.DeploymentID != "" {
			actualMap[c.DeploymentID] = c
		}
	}

	for _, act := range actual.Containers {
		if act.DeploymentID == "" {
			if act.State == "running" {
				log.Printf("[reconcile] stopping orphan container %s (no deployment ID)", act.ID)
				if err := container.Stop(act.ID); err != nil {
					return fmt.Errorf("failed to stop orphan container: %w", err)
				}
				return nil
			} else {
				log.Printf("[reconcile] removing orphan container %s (no deployment ID)", act.ID)
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				err := retry.WithBackoff(ctx, retry.ForceRemoveBackoff, func() (bool, error) {
					if err := container.ForceRemove(act.ID); err != nil {
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
				if err := container.Stop(act.ID); err != nil {
					return fmt.Errorf("failed to stop orphan container: %w", err)
				}
				return nil
			} else {
				log.Printf("[reconcile] removing orphan container %s (deployment %s not in expected state)", act.Name, id[:8])
				if err := container.ForceRemove(act.ID); err != nil {
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
				if err := container.Start(act.ID); err != nil {
					log.Printf("[reconcile] start failed, will redeploy: %v", err)
					if err := container.Stop(act.ID); err != nil {
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
				if err := container.Stop(act.ID); err != nil {
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

	if a.isProxy {
		expectedHttpRoutes := convertToHttpRoutes(a.expectedState.Traefik.HttpRoutes)
		tcpRoutes := convertToTCPRoutes(a.expectedState.Traefik.TCPRoutes)
		udpRoutes := convertToUDPRoutes(a.expectedState.Traefik.UDPRoutes)

		httpDrift := traefik.HashRoutes(expectedHttpRoutes) != actual.TraefikConfigHash
		expectedL4Hash := traefik.HashTCPRoutes(tcpRoutes) + traefik.HashUDPRoutes(udpRoutes)
		l4Drift := expectedL4Hash != actual.L4ConfigHash

		if httpDrift || l4Drift {
			var tcpPorts, udpPorts []int
			for _, r := range tcpRoutes {
				tcpPorts = append(tcpPorts, r.ExternalPort)
			}
			for _, r := range udpRoutes {
				udpPorts = append(udpPorts, r.ExternalPort)
			}

			needsRestart := false
			if len(tcpPorts) > 0 || len(udpPorts) > 0 {
				log.Printf("[reconcile] ensuring L4 entry points: %d TCP, %d UDP", len(tcpPorts), len(udpPorts))
				var err error
				needsRestart, err = traefik.EnsureEntryPoints(tcpPorts, udpPorts)
				if err != nil {
					return fmt.Errorf("failed to ensure entry points: %w", err)
				}
			}

			log.Printf("[reconcile] updating Traefik routes (HTTP: %d, TCP: %d, UDP: %d)", len(expectedHttpRoutes), len(tcpRoutes), len(udpRoutes))
			if err := traefik.UpdateHttpRoutesWithL4(expectedHttpRoutes, tcpRoutes, udpRoutes); err != nil {
				return fmt.Errorf("failed to update Traefik: %w", err)
			}

			if needsRestart {
				log.Printf("[reconcile] restarting Traefik to apply new entry points")
				if err := traefik.ReloadTraefik(); err != nil {
					return fmt.Errorf("failed to restart Traefik: %w", err)
				}
			}
			return nil
		}

		expectedCerts := make([]traefik.Certificate, len(a.expectedState.Traefik.Certificates))
		for i, c := range a.expectedState.Traefik.Certificates {
			expectedCerts[i] = traefik.Certificate{Domain: c.Domain, Certificate: c.Certificate, CertificateKey: c.CertificateKey}
		}
		if traefik.HashCertificates(expectedCerts) != actual.CertificatesHash {
			log.Printf("[reconcile] updating certificates")
			if err := traefik.UpdateCertificates(expectedCerts); err != nil {
				return fmt.Errorf("failed to update certificates: %w", err)
			}
			return nil
		}

		if a.expectedState.Traefik.ChallengeRoute != nil && !actual.ChallengeRouteWritten {
			log.Printf("[reconcile] writing challenge route")
			if err := traefik.WriteChallengeRoute(a.expectedState.Traefik.ChallengeRoute.ControlPlaneUrl); err != nil {
				return fmt.Errorf("failed to write challenge route: %w", err)
			}
			return nil
		}
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
		MTU:        1420,
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

func (a *Agent) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.reportStatus(false)
		}
	}
}

func (a *Agent) reportStatus(includeResources bool) {
	report := &agenthttp.StatusReport{
		PublicIP:   a.publicIP,
		PrivateIP:  a.privateIP,
		Containers: []agenthttp.ContainerStatus{},
	}

	if includeResources {
		report.Resources = getSystemStats()
		report.Meta = getSystemMeta()
	}

	containers, err := container.List()
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
				healthStatus = container.GetHealthStatus(c.ID)
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

func (a *Agent) processWorkQueue() {
	items, err := a.client.GetWorkQueue()
	if err != nil {
		log.Printf("[work-queue] failed to get work queue: %v", err)
		return
	}

	for _, item := range items {
		log.Printf("[work-queue] processing item %s (type=%s)", truncate(item.ID, 8), item.Type)

		var processErr error
		switch item.Type {
		case "restart":
			processErr = a.processRestart(item)
		case "stop":
			processErr = a.processStop(item)
		case "deploy":
			log.Printf("[work-queue] deploy handled via expected state reconciliation, marking complete")
		case "force_cleanup":
			processErr = a.processForceCleanup(item)
		case "cleanup_volumes":
			processErr = a.processCleanupVolumes(item)
		case "build":
			processErr = a.processBuild(item)
		default:
			log.Printf("[work-queue] unknown work item type: %s", item.Type)
			continue
		}

		if processErr != nil {
			log.Printf("[work-queue] item %s failed: %v", truncate(item.ID, 8), processErr)
			if err := a.client.CompleteWorkItem(item.ID, "failed", processErr.Error()); err != nil {
				log.Printf("[work-queue] failed to mark item as failed: %v", err)
			}
		} else {
			log.Printf("[work-queue] item %s completed", truncate(item.ID, 8))
			if err := a.client.CompleteWorkItem(item.ID, "completed", ""); err != nil {
				log.Printf("[work-queue] failed to mark item as completed: %v", err)
			}
		}
	}
}

func (a *Agent) processRestart(item agenthttp.WorkQueueItem) error {
	var payload struct {
		DeploymentID string `json:"deploymentId"`
		ContainerID  string `json:"containerId"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse restart payload: %w", err)
	}

	log.Printf("[restart] restarting container %s for deployment %s", truncate(payload.ContainerID, 12), truncate(payload.DeploymentID, 8))

	if err := container.Restart(payload.ContainerID); err != nil {
		return fmt.Errorf("failed to restart container: %w", err)
	}

	return nil
}

func (a *Agent) processStop(item agenthttp.WorkQueueItem) error {
	var payload struct {
		DeploymentID string `json:"deploymentId"`
		ContainerID  string `json:"containerId"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse stop payload: %w", err)
	}

	log.Printf("[stop] stopping container %s for deployment %s", truncate(payload.ContainerID, 12), truncate(payload.DeploymentID, 8))

	if err := container.Stop(payload.ContainerID); err != nil {
		return fmt.Errorf("failed to stop container: %w", err)
	}

	return nil
}

func (a *Agent) processForceCleanup(item agenthttp.WorkQueueItem) error {
	var payload struct {
		ServiceID    string   `json:"serviceId"`
		ContainerIDs []string `json:"containerIds"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse force_cleanup payload: %w", err)
	}

	log.Printf("[force_cleanup] cleaning up %d containers for service %s", len(payload.ContainerIDs), truncate(payload.ServiceID, 8))

	for _, containerID := range payload.ContainerIDs {
		if err := container.Stop(containerID); err != nil {
			log.Printf("[force_cleanup] failed to stop %s: %v", truncate(containerID, 12), err)
		}
		if err := container.ForceRemove(containerID); err != nil {
			log.Printf("[force_cleanup] failed to remove %s: %v", truncate(containerID, 12), err)
		}
	}

	return nil
}

func (a *Agent) processCleanupVolumes(item agenthttp.WorkQueueItem) error {
	var payload struct {
		ServiceID string `json:"serviceId"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse cleanup_volumes payload: %w", err)
	}

	volumePath := filepath.Join(a.dataDir, "volumes", payload.ServiceID)
	log.Printf("[cleanup_volumes] removing volumes at %s", volumePath)

	if err := os.RemoveAll(volumePath); err != nil {
		return fmt.Errorf("failed to remove volume directory: %w", err)
	}

	return nil
}

func (a *Agent) processBuild(item agenthttp.WorkQueueItem) error {
	if a.builder == nil {
		return fmt.Errorf("builder not configured")
	}

	var payload struct {
		BuildID string `json:"buildId"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse build payload: %w", err)
	}

	a.buildMutex.Lock()
	if a.isBuilding {
		a.buildMutex.Unlock()
		return fmt.Errorf("another build is in progress")
	}
	a.isBuilding = true
	a.currentBuildID = payload.BuildID
	a.buildMutex.Unlock()

	defer func() {
		a.buildMutex.Lock()
		a.isBuilding = false
		a.currentBuildID = ""
		a.buildMutex.Unlock()
	}()

	buildDetails, err := a.client.GetBuild(payload.BuildID)
	if err != nil {
		return fmt.Errorf("failed to get build details: %w", err)
	}

	timeoutMinutes := buildDetails.TimeoutMinutes
	if timeoutMinutes <= 0 {
		timeoutMinutes = 30
	}
	log.Printf("[build] starting build %s for commit %s (timeout: %d minutes)", truncate(payload.BuildID, 8), truncate(buildDetails.Build.CommitSha, 8), timeoutMinutes)

	if err := a.client.UpdateBuildStatus(payload.BuildID, "cloning", ""); err != nil {
		log.Printf("[build] failed to update status to cloning: %v", err)
	}

	checkCancelled := func() bool {
		status, err := a.client.GetBuildStatus(payload.BuildID)
		if err != nil {
			return false
		}
		return status == "cancelled"
	}

	decryptedSecrets := make(map[string]string)
	for key, encryptedValue := range buildDetails.Secrets {
		decrypted, err := crypto.DecryptSecret(encryptedValue, a.config.EncryptionKey)
		if err != nil {
			log.Printf("[build] failed to decrypt secret %s: %v", key, err)
			continue
		}
		decryptedSecrets[key] = decrypted
	}

	buildConfig := &build.Config{
		BuildID:         payload.BuildID,
		CloneURL:        buildDetails.CloneURL,
		CommitSha:       buildDetails.Build.CommitSha,
		Branch:          buildDetails.Build.Branch,
		ImageURI:        buildDetails.ImageURI,
		ServiceID:       buildDetails.Build.ServiceID,
		ProjectID:       buildDetails.Build.ProjectID,
		RootDir:         buildDetails.RootDir,
		Secrets:         decryptedSecrets,
		TargetPlatforms: buildDetails.TargetPlatforms,
	}

	onStatusChange := func(status string) {
		if err := a.client.UpdateBuildStatus(payload.BuildID, status, ""); err != nil {
			log.Printf("[build] failed to update status to %s: %v", status, err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMinutes)*time.Minute)
	defer cancel()
	err = a.builder.Build(ctx, buildConfig, checkCancelled, onStatusChange)
	if err != nil {
		log.Printf("[build] build %s failed: %v", truncate(payload.BuildID, 8), err)
		if updateErr := a.client.UpdateBuildStatus(payload.BuildID, "failed", err.Error()); updateErr != nil {
			log.Printf("[build] failed to update status to failed: %v", updateErr)
		}
		return err
	}

	log.Printf("[build] build %s completed successfully", truncate(payload.BuildID, 8))
	if err := a.client.UpdateBuildStatus(payload.BuildID, "completed", ""); err != nil {
		log.Printf("[build] failed to update status to completed: %v", err)
	}

	return nil
}

func (a *Agent) runBuildCleanup() {
	if a.builder == nil {
		return
	}

	log.Printf("[build:cleanup] running periodic cleanup")
	if err := a.builder.Cleanup(); err != nil {
		log.Printf("[build:cleanup] cleanup failed: %v", err)
	}
}

var httpClient *api.Client
var dataDir string

func main() {
	var (
		controlPlaneURL string
		token           string
		logsEndpoint    string
		isProxy         bool
	)

	flag.StringVar(&controlPlaneURL, "url", "", "Control plane URL (required)")
	flag.StringVar(&token, "token", "", "Registration token (required for first run)")
	flag.StringVar(&dataDir, "data-dir", paths.DataDir, "Data directory for agent state")
	flag.StringVar(&logsEndpoint, "logs-endpoint", "", "VictoriaLogs endpoint URL (enables logging)")
	flag.BoolVar(&isProxy, "proxy", false, "Run as proxy node (handles TLS and public traffic)")
	flag.Parse()

	if controlPlaneURL == "" {
		log.Fatal("--url is required")
	}

	if isProxy && runtime.GOOS != "linux" {
		log.Fatal("--proxy flag is only supported on Linux")
	}

	if err := wireguard.CheckPrerequisites(); err != nil {
		log.Fatalf("WireGuard prerequisites check failed: %v", err)
	}

	if err := container.CheckPrerequisites(); err != nil {
		log.Fatalf("Container runtime prerequisites check failed: %v", err)
	}

	if isProxy {
		if err := traefik.CheckPrerequisites(); err != nil {
			log.Fatalf("Traefik prerequisites check failed: %v", err)
		}
		log.Println("Running as proxy node - Traefik will handle public traffic")
	} else {
		log.Println("Running as worker node - Traefik disabled")
	}

	if err := build.CheckPrerequisites(); err != nil {
		log.Fatalf("Build prerequisites check failed: %v", err)
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

		if err := dns.SetupLocalDNS(config.SubnetID); err != nil {
			log.Printf("Warning: Failed to setup local DNS: %v", err)
		}

		if err := container.EnsureNetwork(config.SubnetID); err != nil {
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
		privateIP := getPrivateIP()
		resp, err := httpClient.Register(token, wgPublicKey, signingKeyPair.PublicKeyBase64(), publicIP, privateIP, isProxy)
		if err != nil {
			log.Fatalf("Failed to register: %v", err)
		}

		config = &Config{
			ServerID:      resp.ServerID,
			SubnetID:      resp.SubnetID,
			WireGuardIP:   resp.WireGuardIP,
			EncryptionKey: resp.EncryptionKey,
			IsProxy:       isProxy,
		}

		if err := saveConfig(configPath, config); err != nil {
			log.Fatalf("Failed to save config: %v", err)
		}

		log.Printf("Registration successful! serverID=%s, subnetId=%d, wireguardIP=%s", config.ServerID, config.SubnetID, config.WireGuardIP)

		wgConfig := &wireguard.Config{
			PrivateKey: wgPrivateKey,
			Address:    config.WireGuardIP,
			ListenPort: wireguard.DefaultPort,
			MTU:        1420,
			Peers:      []wireguard.Peer{},
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

		log.Println("Setting up local DNS...")
		if err := dns.SetupLocalDNS(config.SubnetID); err != nil {
			log.Printf("Warning: Failed to setup local DNS: %v", err)
		} else {
			log.Println("Local DNS configured successfully")
		}

		log.Println("Ensuring container network exists...")
		if err := container.EnsureNetwork(config.SubnetID); err != nil {
			log.Printf("Warning: Failed to create container network: %v", err)
		} else {
			log.Println("Container network ready")
		}
	}

	reconciler := reconcile.NewReconciler(config.EncryptionKey, dataDir)
	client := agenthttp.NewClient(controlPlaneURL, config.ServerID, signingKeyPair, dataDir)

	var logCollector *logs.Collector
	var traefikLogCollector *logs.TraefikCollector
	var logsSender *logs.VictoriaLogsSender
	var agentLogWriter *logs.AgentLogWriter
	if logsEndpoint != "" {
		log.Println("[logs] log collection enabled, endpoint:", logsEndpoint)
		logsSender = logs.NewVictoriaLogsSender(logsEndpoint, config.ServerID)
		logCollector = logs.NewCollector(logsSender, dataDir)
		if isProxy {
			traefikLogCollector = logs.NewTraefikCollector(logsSender)
			log.Println("[traefik-logs] Traefik HTTP log collection enabled")
		}
		agentLogWriter = logs.NewAgentLogWriter(config.ServerID, logsSender)
		log.SetOutput(agentLogWriter)
		log.Println("[agent-logs] Agent log collection enabled")
	}

	var builder *build.Builder
	if logsSender != nil {
		builder = build.NewBuilder(dataDir, logsSender)
		log.Println("[build] build system enabled")
	} else {
		builder = build.NewBuilder(dataDir, nil)
		log.Println("[build] build system enabled (no log streaming)")
	}

	ctx, cancel := context.WithCancel(context.Background())

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-stop
		log.Println("Shutting down...")
		cancel()
	}()

	var agentLogFlusherDone <-chan struct{}
	if agentLogWriter != nil {
		agentLogFlusherDone = agentLogWriter.StartFlusher(ctx)
	}

	publicIP := getPublicIP()
	privateIP := getPrivateIP()
	log.Printf("Agent started. Public IP: %s, Private IP: %s. Tick interval: %v", publicIP, privateIP, tickInterval)

	agent := NewAgent(client, reconciler, config, publicIP, privateIP, dataDir, logCollector, traefikLogCollector, builder, config.IsProxy)
	agent.Run(ctx)

	if agentLogFlusherDone != nil {
		<-agentLogFlusherDone
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := dns.StopDNSServer(shutdownCtx); err != nil {
		log.Printf("[dns] shutdown error: %v", err)
	}

	log.Println("Agent stopped")
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

func getSystemMeta() map[string]string {
	meta := map[string]string{
		"arch": runtime.GOARCH,
		"os":   runtime.GOOS,
	}

	if hostname, err := os.Hostname(); err == nil {
		meta["hostname"] = hostname
	}

	return meta
}

func getPublicIP() string {
	ip, err := sockaddr.GetPublicIP()
	if err == nil && ip != "" {
		return ip
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("https://api.ipify.org")
	if err != nil {
		log.Printf("Failed to get public IP from ipify: %v", err)
		return ""
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("Failed to read ipify response: %v", err)
		return ""
	}

	return strings.TrimSpace(string(body))
}

func getPrivateIP() string {
	ips, err := sockaddr.GetPrivateIPs()
	if err != nil {
		log.Printf("Failed to get private IPs: %v", err)
		return ""
	}

	// Filter out our internal subnets (WireGuard mesh and container networks)
	// to find the actual server private IP for VPC/private network detection
	for _, ip := range strings.Split(ips, " ") {
		if ip == "" {
			continue
		}
		if strings.HasPrefix(ip, "10.100.") || strings.HasPrefix(ip, "10.200.") {
			continue
		}
		return ip
	}

	return ""
}
