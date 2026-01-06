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
	"techulus/cloud-agent/internal/caddy"
	"techulus/cloud-agent/internal/crypto"
	"techulus/cloud-agent/internal/dns"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/logs"
	"techulus/cloud-agent/internal/paths"
	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/reconcile"
	"techulus/cloud-agent/internal/retry"
	"techulus/cloud-agent/internal/wireguard"

	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
)

const (
	tickInterval         = 10 * time.Second
	processingTimeout    = 5 * time.Minute
	buildCheckInterval   = 30 * time.Second
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

type Config struct {
	ServerID      string `json:"serverId"`
	SubnetID      int    `json:"subnetId"`
	WireGuardIP   string `json:"wireguardIp"`
	EncryptionKey string `json:"encryptionKey"`
	IsProxy       bool   `json:"isProxy"`
}

type ActualState struct {
	Containers      []container.Container
	DnsConfigHash   string
	CaddyConfigHash string
	WireguardHash   string
}

type Agent struct {
	state              AgentState
	stateMutex         sync.RWMutex
	client             *agenthttp.Client
	reconciler         *reconcile.Reconciler
	config             *Config
	publicIP           string
	dataDir            string
	expectedState      *agenthttp.ExpectedState
	processingStart    time.Time
	logCollector       *logs.Collector
	caddyLogCollector  *logs.CaddyCollector
	builder            *build.Builder
	isBuilding         bool
	buildMutex         sync.Mutex
	currentBuildID     string
	isProxy            bool
}

func NewAgent(client *agenthttp.Client, reconciler *reconcile.Reconciler, config *Config, publicIP, dataDir string, logCollector *logs.Collector, caddyLogCollector *logs.CaddyCollector, builder *build.Builder, isProxy bool) *Agent {
	return &Agent{
		state:             StateIdle,
		client:            client,
		reconciler:        reconciler,
		config:            config,
		publicIP:          publicIP,
		dataDir:           dataDir,
		logCollector:      logCollector,
		caddyLogCollector: caddyLogCollector,
		builder:           builder,
		isProxy:           isProxy,
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

	if a.isProxy && a.caddyLogCollector != nil {
		a.caddyLogCollector.Start()
	}

	var buildTickerC <-chan time.Time
	var cleanupTickerC <-chan time.Time
	if a.builder != nil {
		buildTicker := time.NewTicker(buildCheckInterval)
		defer buildTicker.Stop()
		buildTickerC = buildTicker.C

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
			if a.isProxy && a.caddyLogCollector != nil {
				a.caddyLogCollector.Stop()
			}
			return
		case <-ticker.C:
			a.tick()
		case <-logTickerC:
			a.collectLogs()
		case <-buildTickerC:
			go a.checkForBuilds(ctx)
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
		expectedCaddyRoutes := make([]caddy.CaddyRoute, len(expected.Caddy.Routes))
		for i, r := range expected.Caddy.Routes {
			expectedCaddyRoutes[i] = caddy.CaddyRoute{ID: r.ID, Domain: r.Domain, Upstreams: r.Upstreams, ServiceId: r.ServiceId}
		}
		expectedCaddyHash := caddy.HashRoutes(expectedCaddyRoutes)
		if expectedCaddyHash != actual.CaddyConfigHash {
			changes = append(changes, fmt.Sprintf("UPDATE Caddy (%d routes)", len(expected.Caddy.Routes)))
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
		state.CaddyConfigHash = caddy.GetCurrentConfigHash()
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
		expectedCaddyRoutes := make([]caddy.CaddyRoute, len(expected.Caddy.Routes))
		for i, r := range expected.Caddy.Routes {
			expectedCaddyRoutes[i] = caddy.CaddyRoute{ID: r.ID, Domain: r.Domain, Upstreams: r.Upstreams, ServiceId: r.ServiceId}
		}
		if caddy.HashRoutes(expectedCaddyRoutes) != actual.CaddyConfigHash {
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
		expectedCaddyRoutes := make([]caddy.CaddyRoute, len(a.expectedState.Caddy.Routes))
		for i, r := range a.expectedState.Caddy.Routes {
			expectedCaddyRoutes[i] = caddy.CaddyRoute{ID: r.ID, Domain: r.Domain, Upstreams: r.Upstreams, ServiceId: r.ServiceId}
		}
		if caddy.HashRoutes(expectedCaddyRoutes) != actual.CaddyConfigHash {
			log.Printf("[reconcile] updating Caddy routes")
			if err := caddy.UpdateCaddyRoutes(expectedCaddyRoutes); err != nil {
				return fmt.Errorf("failed to update Caddy: %w", err)
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
			if a.getState() == StateProcessing {
				log.Printf("[heartbeat] sending heartbeat during processing")
				a.reportStatus(false)
			}
		}
	}
}

func (a *Agent) reportStatus(includeResources bool) {
	report := &agenthttp.StatusReport{
		PublicIP:   a.publicIP,
		Containers: []agenthttp.ContainerStatus{},
	}

	if includeResources {
		report.Resources = getSystemStats()
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

func (a *Agent) checkForBuilds(ctx context.Context) {
	if a.builder == nil {
		return
	}

	a.buildMutex.Lock()
	if a.isBuilding {
		a.buildMutex.Unlock()
		return
	}
	a.buildMutex.Unlock()

	pending, err := a.client.GetPendingBuild()
	if err != nil {
		log.Printf("[build] failed to check for pending builds: %v", err)
		return
	}

	if pending == nil {
		return
	}

	log.Printf("[build] found pending build %s for commit %s", truncate(pending.ID, 8), truncate(pending.CommitSha, 8))

	claimed, err := a.client.ClaimBuild(pending.ID)
	if err != nil {
		log.Printf("[build] failed to claim build %s: %v", truncate(pending.ID, 8), err)
		return
	}

	a.buildMutex.Lock()
	a.isBuilding = true
	a.currentBuildID = pending.ID
	a.buildMutex.Unlock()

	defer func() {
		a.buildMutex.Lock()
		a.isBuilding = false
		a.currentBuildID = ""
		a.buildMutex.Unlock()
	}()

	log.Printf("[build] starting build %s", truncate(pending.ID, 8))

	if err := a.client.UpdateBuildStatus(pending.ID, "cloning", ""); err != nil {
		log.Printf("[build] failed to update status to cloning: %v", err)
	}

	checkCancelled := func() bool {
		status, err := a.client.GetBuildStatus(pending.ID)
		if err != nil {
			return false
		}
		return status == "cancelled"
	}

	decryptedSecrets := make(map[string]string)
	for key, encryptedValue := range claimed.Secrets {
		decrypted, err := crypto.DecryptSecret(encryptedValue, a.config.EncryptionKey)
		if err != nil {
			log.Printf("[build] failed to decrypt secret %s: %v", key, err)
			continue
		}
		decryptedSecrets[key] = decrypted
	}

	buildConfig := &build.Config{
		BuildID:   pending.ID,
		CloneURL:  claimed.CloneURL,
		CommitSha: claimed.Build.CommitSha,
		Branch:    claimed.Build.Branch,
		ImageURI:  claimed.ImageURI,
		ServiceID: claimed.Build.ServiceID,
		ProjectID: claimed.Build.ProjectID,
		Secrets:   decryptedSecrets,
	}

	onStatusChange := func(status string) {
		if err := a.client.UpdateBuildStatus(pending.ID, status, ""); err != nil {
			log.Printf("[build] failed to update status to %s: %v", status, err)
		}
	}

	err = a.builder.Build(ctx, buildConfig, checkCancelled, onStatusChange)
	if err != nil {
		log.Printf("[build] build %s failed: %v", truncate(pending.ID, 8), err)
		if err := a.client.UpdateBuildStatus(pending.ID, "failed", err.Error()); err != nil {
			log.Printf("[build] failed to update status to failed: %v", err)
		}
		return
	}

	log.Printf("[build] build %s completed successfully", truncate(pending.ID, 8))
	if err := a.client.UpdateBuildStatus(pending.ID, "completed", ""); err != nil {
		log.Printf("[build] failed to update status to completed: %v", err)
	}
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
		if err := caddy.CheckPrerequisites(); err != nil {
			log.Fatalf("Caddy prerequisites check failed: %v", err)
		}
		log.Println("Running as proxy node - Caddy will handle public traffic")
	} else {
		log.Println("Running as worker node - Caddy disabled")
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

		if err := dns.SetupLocalDNS(config.WireGuardIP); err != nil {
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
		resp, err := httpClient.Register(token, wgPublicKey, signingKeyPair.PublicKeyBase64(), publicIP, isProxy)
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
		if err := container.EnsureNetwork(config.SubnetID); err != nil {
			log.Printf("Warning: Failed to create container network: %v", err)
		} else {
			log.Println("Container network ready")
		}
	}

	reconciler := reconcile.NewReconciler(config.EncryptionKey)
	client := agenthttp.NewClient(controlPlaneURL, config.ServerID, signingKeyPair, dataDir)

	var logCollector *logs.Collector
	var caddyLogCollector *logs.CaddyCollector
	var logsSender *logs.VictoriaLogsSender
	var agentLogWriter *logs.AgentLogWriter
	if logsEndpoint != "" {
		log.Println("[logs] log collection enabled, endpoint:", logsEndpoint)
		logsSender = logs.NewVictoriaLogsSender(logsEndpoint)
		logCollector = logs.NewCollector(logsSender, dataDir)
		if isProxy {
			caddyLogCollector = logs.NewCaddyCollector(logsSender)
			log.Println("[caddy-logs] Caddy HTTP log collection enabled")
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
	log.Printf("Agent started. Public IP: %s. Tick interval: %v", publicIP, tickInterval)

	agent := NewAgent(client, reconciler, config, publicIP, dataDir, logCollector, caddyLogCollector, builder, config.IsProxy)
	agent.Run(ctx)

	if agentLogFlusherDone != nil {
		<-agentLogFlusherDone
	}

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
