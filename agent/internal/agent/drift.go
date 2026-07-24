package agent

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/dns"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/retry"
	"techulus/cloud-agent/internal/traefik"
	"techulus/cloud-agent/internal/wireguard"
)

type reconcileActionKind string

const (
	actionStopOrphanNoDeploymentID   reconcileActionKind = "stop_orphan_no_deployment_id"
	actionRemoveOrphanNoDeploymentID reconcileActionKind = "remove_orphan_no_deployment_id"
	actionStopUnexpectedContainer    reconcileActionKind = "stop_unexpected_container"
	actionRemoveUnexpectedContainer  reconcileActionKind = "remove_unexpected_container"
	actionDeployMissingContainer     reconcileActionKind = "deploy_missing_container"
	actionStopExpectedContainer      reconcileActionKind = "stop_expected_container"
	actionStartContainer             reconcileActionKind = "start_container"
	actionRedeployContainer          reconcileActionKind = "redeploy_container"
	actionUpdateDNS                  reconcileActionKind = "update_dns"
	actionUpdateTraefik              reconcileActionKind = "update_traefik"
	actionWriteChallengeRoute        reconcileActionKind = "write_challenge_route"
	actionUpdateWireGuard            reconcileActionKind = "update_wireguard"
	actionStartWireGuard             reconcileActionKind = "start_wireguard"
)

type reconcileAction struct {
	Kind         reconcileActionKind
	Description  string
	DeploymentID string
	Expected     *agenthttp.ExpectedContainer
	Actual       *container.Container
}

func reconcileActionKey(action reconcileAction) string {
	target := action.DeploymentID
	if target == "" && action.Actual != nil {
		target = action.Actual.ID
		if target == "" {
			target = action.Actual.Name
		}
	}
	if target == "" && action.Expected != nil {
		target = action.Expected.Name
	}
	return string(action.Kind) + "\x00" + target
}

func (a *Agent) Tick() {
	switch a.GetState() {
	case StateIdle:
		a.handleIdle()
	case StateProcessing:
		a.handleProcessing()
	}
}

func (a *Agent) RequestReconcile(reason string) {
	if a.GetState() == StateProcessing {
		a.requestExpectedStateRefresh()
		log.Printf("[reconcile] refresh requested during processing: %s", reason)
	} else {
		log.Printf("[reconcile] immediate reconcile requested: %s", reason)
	}

	select {
	case a.reconcileRequested <- struct{}{}:
	default:
	}
}

func (a *Agent) signalContinueProcessing() {
	select {
	case a.continueProcessing <- struct{}{}:
	default:
	}
}

func (a *Agent) requestExpectedStateRefresh() {
	a.refreshMutex.Lock()
	defer a.refreshMutex.Unlock()
	a.pendingExpectedStateRefresh = true
}

func (a *Agent) consumeExpectedStateRefresh() bool {
	a.refreshMutex.Lock()
	defer a.refreshMutex.Unlock()

	if !a.pendingExpectedStateRefresh {
		return false
	}

	a.pendingExpectedStateRefresh = false
	return true
}

func (a *Agent) transitionToIdle() {
	select {
	case <-a.continueProcessing:
	default:
	}
	a.SetState(StateIdle)
	if a.consumeExpectedStateRefresh() {
		log.Printf("[processing] fetching latest expected state after pending refresh")
		// A reconcile wake can arrive while processing a previous snapshot. Run one
		// immediate idle pass after processing to pick up the latest expected state.
		a.handleIdle()
	}
}

func (a *Agent) handleIdle() {
	expected, fromCache, err := a.Client.GetExpectedStateWithFallback()
	if err != nil {
		log.Printf("[idle] failed to get expected state: %v", err)
		return
	}

	if fromCache {
		log.Printf("[idle] using cached state (CP unreachable)")
	}
	a.SetLatestExpectedState(expected)
	a.ReconcilePendingServerlessTransitionsWithExpected(expected, fromCache)

	actual, err := a.getActualState()
	if err != nil {
		log.Printf("[idle] failed to get actual state: %v", err)
		return
	}

	actions := a.planReconcile(expected, actual)
	if len(actions) > 0 {
		log.Printf("[idle] drift detected, %d change(s) to apply:", len(actions))
		for _, action := range actions {
			log.Printf("  → %s", action.Description)
		}
		log.Printf("[idle] transitioning to PROCESSING")
		a.expectedState = expected
		a.processingStart = time.Now()
		a.lastAppliedActionKey = ""
		a.SetState(StateProcessing)
		a.signalContinueProcessing()
		return
	}
}

func (a *Agent) handleProcessing() {
	if time.Since(a.processingStart) > ProcessingTimeout {
		log.Printf("[processing] timeout after %v, forcing transition to IDLE", ProcessingTimeout)
		a.transitionToIdle()
		return
	}

	actual, err := a.getActualState()
	if err != nil {
		log.Printf("[processing] failed to get actual state: %v", err)
		a.transitionToIdle()
		return
	}

	actions := a.planReconcile(a.expectedState, actual)

	if len(actions) == 0 {
		log.Printf("[processing] state converged, transitioning to IDLE")
		a.transitionToIdle()
		return
	}

	action := actions[0]
	actionKey := reconcileActionKey(action)
	if actionKey == a.lastAppliedActionKey {
		log.Printf("[processing] action made no observable progress, waiting for the next scheduled tick: %s", action.Description)
		a.lastAppliedActionKey = ""
		return
	}
	if err := a.applyReconcileAction(action); err != nil {
		log.Printf("[processing] reconciliation failed: %v, transitioning to IDLE", err)
		a.RecordDeploymentError(action.DeploymentID, err)
		a.RequestStatusReport("reconcile failed")
		a.transitionToIdle()
		return
	}

	a.lastAppliedActionKey = actionKey
	a.RequestStatusReport("reconcile completed")
	a.signalContinueProcessing()
}

func (a *Agent) getActualState() (*ActualState, error) {
	containers, err := container.List()
	if err != nil {
		return nil, fmt.Errorf("failed to list containers: %w", err)
	}
	state := &ActualState{
		Containers:    containers,
		WireguardHash: wireguard.GetCurrentPeersHash(),
	}
	if !a.DisableDNS {
		state.DnsConfigHash = dns.GetCurrentConfigHash()
	}
	if a.IsProxy {
		state.TraefikConfigHash = traefik.GetCurrentConfigHash()
		state.L4ConfigHash = traefik.GetCurrentL4ConfigHash()
		state.CertificatesHash = traefik.GetCurrentCertificatesHash()
		state.TraefikReloaded, err = traefik.DynamicConfigReloaded(a.DataDir)
		if err != nil {
			log.Printf("[traefik] failed to determine dynamic config reload state: %v", err)
		}
		state.ChallengeRouteWritten = traefik.ChallengeRouteExists()
	}
	return state, nil
}

func (a *Agent) planReconcile(expected *agenthttp.ExpectedState, actual *ActualState) []reconcileAction {
	var actions []reconcileAction

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

	for i := range actual.Containers {
		act := &actual.Containers[i]
		if act.DeploymentID == "" {
			if act.State == "running" {
				actions = append(actions, reconcileAction{
					Kind:        actionStopOrphanNoDeploymentID,
					Description: fmt.Sprintf("STOP orphan container %s (no deployment ID)", act.Name),
					Actual:      act,
				})
			} else {
				actions = append(actions, reconcileAction{
					Kind:        actionRemoveOrphanNoDeploymentID,
					Description: fmt.Sprintf("REMOVE orphan container %s (no deployment ID)", act.Name),
					Actual:      act,
				})
			}
		}
	}

	for id, act := range actualMap {
		if _, exists := expectedMap[id]; !exists {
			actualContainer := act
			if act.State == "running" {
				actions = append(actions, reconcileAction{
					Kind:         actionStopUnexpectedContainer,
					Description:  fmt.Sprintf("STOP orphan container %s (deployment %s not in expected state)", act.Name, id[:8]),
					DeploymentID: id,
					Actual:       &actualContainer,
				})
			} else {
				actions = append(actions, reconcileAction{
					Kind:         actionRemoveUnexpectedContainer,
					Description:  fmt.Sprintf("REMOVE orphan container %s (deployment %s not in expected state)", act.Name, id[:8]),
					DeploymentID: id,
					Actual:       &actualContainer,
				})
			}
		}
	}

	for id, exp := range expectedMap {
		if _, exists := actualMap[id]; !exists {
			if desiredContainerState(exp) == "stopped" || a.HasPendingServerlessSleep(id) || a.HasPendingServerlessWake(id) {
				continue
			}
			expectedContainer := exp
			actions = append(actions, reconcileAction{
				Kind:         actionDeployMissingContainer,
				Description:  fmt.Sprintf("DEPLOY %s (%s)", exp.Name, exp.Image),
				DeploymentID: id,
				Expected:     &expectedContainer,
			})
		}
	}

	for id, exp := range expectedMap {
		if act, exists := actualMap[id]; exists {
			expectedContainer := exp
			actualContainer := act

			if a.HasPendingServerlessWake(id) {
				continue
			}
			if desiredContainerState(exp) == "stopped" || a.HasPendingServerlessSleep(id) {
				if shouldStopDesiredStoppedContainer(act.State) {
					actions = append(actions, reconcileAction{
						Kind:         actionStopExpectedContainer,
						Description:  fmt.Sprintf("STOP %s (desired state: stopped)", exp.Name),
						DeploymentID: id,
						Expected:     &expectedContainer,
						Actual:       &actualContainer,
					})
				}
				continue
			}

			if normalizeImage(exp.Image) != normalizeImage(act.Image) {
				actions = append(actions, reconcileAction{
					Kind:         actionRedeployContainer,
					Description:  fmt.Sprintf("REDEPLOY %s (image: %s → %s)", exp.Name, act.Image, exp.Image),
					DeploymentID: id,
					Expected:     &expectedContainer,
					Actual:       &actualContainer,
				})
			} else if act.State == "created" || act.State == "exited" {
				actions = append(actions, reconcileAction{
					Kind:         actionStartContainer,
					Description:  fmt.Sprintf("START %s (state: %s)", exp.Name, act.State),
					DeploymentID: id,
					Expected:     &expectedContainer,
					Actual:       &actualContainer,
				})
			} else if act.State != "running" {
				actions = append(actions, reconcileAction{
					Kind:         actionRedeployContainer,
					Description:  fmt.Sprintf("REDEPLOY %s (state: %s)", exp.Name, act.State),
					DeploymentID: id,
					Expected:     &expectedContainer,
					Actual:       &actualContainer,
				})
			}
		}
	}

	if !a.DisableDNS {
		expectedDnsRecords := make([]dns.DnsRecord, len(expected.Dns.Records))
		for i, r := range expected.Dns.Records {
			expectedDnsRecords[i] = dns.DnsRecord{Name: r.Name, Ips: r.Ips}
		}
		expectedDnsHash := dns.HashRecords(expectedDnsRecords)
		if expectedDnsHash != actual.DnsConfigHash {
			actions = append(actions, reconcileAction{
				Kind:        actionUpdateDNS,
				Description: fmt.Sprintf("UPDATE DNS (%d records)", len(expected.Dns.Records)),
			})
		}
	}

	if a.IsProxy {
		compiled := a.compiledTraefikState(expected)
		if compiled.HTTPHash != actual.TraefikConfigHash ||
			compiled.L4Hash != actual.L4ConfigHash ||
			compiled.CertHash != actual.CertificatesHash ||
			!actual.TraefikReloaded {
			actions = append(actions, reconcileAction{
				Kind: actionUpdateTraefik,
				Description: fmt.Sprintf(
					"UPDATE Traefik (%d HTTP, %d TCP, %d UDP routes; %d certificates)",
					len(compiled.HTTP),
					len(compiled.TCP),
					len(compiled.UDP),
					len(compiled.Certificates),
				),
			})
		}

		if expected.Traefik.ChallengeRoute != nil && !actual.ChallengeRouteWritten {
			actions = append(actions, reconcileAction{
				Kind:        actionWriteChallengeRoute,
				Description: "WRITE Challenge Route",
			})
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
		actions = append(actions, reconcileAction{
			Kind:        actionUpdateWireGuard,
			Description: fmt.Sprintf("UPDATE WireGuard (%d peers)", len(expected.Wireguard.Peers)),
		})
	}

	if !wireguard.IsUp(wireguard.DefaultInterface) {
		actions = append(actions, reconcileAction{
			Kind:        actionStartWireGuard,
			Description: "START WireGuard",
		})
	}

	return actions
}

func normalizeImage(image string) string {
	digest := ""
	if digestIndex := strings.Index(image, "@"); digestIndex != -1 {
		digest = image[digestIndex:]
		image = image[:digestIndex]
	}

	image = strings.TrimPrefix(image, "docker.io/library/")
	image = strings.TrimPrefix(image, "docker.io/")

	lastSlash := strings.LastIndex(image, "/")
	lastColon := strings.LastIndex(image, ":")
	if digest == "" && lastColon <= lastSlash {
		image = image + ":latest"
	}
	return image + digest
}

func desiredContainerState(container agenthttp.ExpectedContainer) string {
	if container.DesiredState == "stopped" {
		return "stopped"
	}
	return "running"
}

func shouldStopDesiredStoppedContainer(state string) bool {
	switch state {
	case "created", "exited", "stopped":
		return false
	default:
		return true
	}
}

func (a *Agent) applyReconcileAction(action reconcileAction) error {
	log.Printf("[reconcile] %s", action.Description)

	switch action.Kind {
	case actionStopOrphanNoDeploymentID, actionStopUnexpectedContainer, actionStopExpectedContainer:
		if action.Actual == nil {
			return fmt.Errorf("missing actual container for %s", action.Kind)
		}
		if err := container.Stop(action.Actual.ID); err != nil {
			return fmt.Errorf("failed to stop container: %w", err)
		}
		return nil

	case actionRemoveOrphanNoDeploymentID:
		if action.Actual == nil {
			return fmt.Errorf("missing actual container for %s", action.Kind)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		err := retry.WithBackoff(ctx, retry.ForceRemoveBackoff, func() (bool, error) {
			if err := container.ForceRemove(action.Actual.ID); err != nil {
				log.Printf("[reconcile] remove attempt failed: %v, retrying...", err)
				return false, err
			}
			return true, nil
		})
		cancel()
		if err != nil {
			return fmt.Errorf("failed to remove orphan container after retries: %w", err)
		}
		return nil

	case actionRemoveUnexpectedContainer:
		if action.Actual == nil {
			return fmt.Errorf("missing actual container for %s", action.Kind)
		}
		if err := container.ForceRemove(action.Actual.ID); err != nil {
			return fmt.Errorf("failed to remove orphan container: %w", err)
		}
		return nil

	case actionDeployMissingContainer:
		if action.Expected == nil {
			return fmt.Errorf("missing expected container for %s", action.Kind)
		}
		if err := a.DeployExpectedContainer(*action.Expected); err != nil {
			return fmt.Errorf("failed to deploy container: %w", err)
		}
		return nil

	case actionStartContainer:
		if action.Actual == nil || action.Expected == nil {
			return fmt.Errorf("missing container state for %s", action.Kind)
		}
		if err := container.Start(action.Actual.ID); err != nil {
			log.Printf("[reconcile] start failed, will redeploy: %v", err)
			if err := container.Stop(action.Actual.ID); err != nil {
				log.Printf("[reconcile] warning: failed to stop old container: %v", err)
			}
			if err := a.DeployExpectedContainer(*action.Expected); err != nil {
				return fmt.Errorf("failed to redeploy container: %w", err)
			}
		}
		return nil

	case actionRedeployContainer:
		if action.Actual == nil || action.Expected == nil {
			return fmt.Errorf("missing container state for %s", action.Kind)
		}
		if err := container.Stop(action.Actual.ID); err != nil {
			log.Printf("[reconcile] warning: failed to stop old container: %v", err)
		}
		if err := a.DeployExpectedContainer(*action.Expected); err != nil {
			return fmt.Errorf("failed to redeploy container: %w", err)
		}
		return nil

	case actionUpdateDNS:
		expectedDnsRecords := make([]dns.DnsRecord, len(a.expectedState.Dns.Records))
		for i, r := range a.expectedState.Dns.Records {
			expectedDnsRecords[i] = dns.DnsRecord{Name: r.Name, Ips: r.Ips}
		}
		if err := dns.UpdateDnsRecords(expectedDnsRecords); err != nil {
			return fmt.Errorf("failed to update DNS: %w", err)
		}
		return nil

	case actionUpdateTraefik:
		return a.updateTraefik()

	case actionWriteChallengeRoute:
		if a.expectedState.Traefik.ChallengeRoute == nil {
			return nil
		}
		if err := traefik.WriteChallengeRoute(a.expectedState.Traefik.ChallengeRoute.ControlPlaneUrl); err != nil {
			return fmt.Errorf("failed to write challenge route: %w", err)
		}
		return nil

	case actionUpdateWireGuard:
		expectedWgPeers := make([]wireguard.Peer, len(a.expectedState.Wireguard.Peers))
		for i, p := range a.expectedState.Wireguard.Peers {
			expectedWgPeers[i] = wireguard.Peer{
				PublicKey:  p.PublicKey,
				AllowedIPs: p.AllowedIPs,
				Endpoint:   p.Endpoint,
			}
		}
		if err := a.reconcileWireguard(expectedWgPeers); err != nil {
			return fmt.Errorf("failed to update WireGuard: %w", err)
		}
		return nil

	case actionStartWireGuard:
		if err := wireguard.Up(wireguard.DefaultInterface); err != nil {
			return fmt.Errorf("failed to bring up WireGuard: %w", err)
		}
		return nil

	default:
		return fmt.Errorf("unknown reconcile action: %s", action.Kind)
	}
}

func (a *Agent) updateTraefik() error {
	compiled := a.compiledTraefikState(a.expectedState)

	needsRestart := false
	metricsRestart, err := traefik.EnsureMetricsConfig()
	if err != nil {
		return fmt.Errorf("failed to ensure Traefik metrics config: %w", err)
	}
	needsRestart = metricsRestart

	if len(compiled.TCPPorts) > 0 || len(compiled.UDPPorts) > 0 {
		log.Printf("[reconcile] ensuring L4 entry points: %d TCP, %d UDP", len(compiled.TCPPorts), len(compiled.UDPPorts))
		entryPointsRestart, err := traefik.EnsureEntryPoints(compiled.TCPPorts, compiled.UDPPorts)
		if err != nil {
			return fmt.Errorf("failed to ensure entry points: %w", err)
		}
		needsRestart = needsRestart || entryPointsRestart
	}
	if needsRestart {
		log.Printf("[reconcile] restarting Traefik to apply static configuration")
		if err := traefik.ReloadTraefik(); err != nil {
			return fmt.Errorf("failed to restart Traefik: %w", err)
		}
	}

	routesChanged := compiled.HTTPHash != traefik.GetCurrentConfigHash() ||
		compiled.L4Hash != traefik.GetCurrentL4ConfigHash()
	certificatesChanged := compiled.CertHash != traefik.GetCurrentCertificatesHash()
	if !routesChanged && !certificatesChanged {
		if err := traefik.EnsureDynamicConfigReloaded(a.DataDir, 15*time.Second); err != nil {
			return fmt.Errorf("failed to recover Traefik config reload: %w", err)
		}
		return nil
	}

	baselineReload, err := traefik.LastSuccessfulReload()
	if err != nil {
		return fmt.Errorf("failed to capture Traefik reload baseline: %w", err)
	}
	if err := traefik.MarkDynamicConfigReloadPending(a.DataDir, baselineReload); err != nil {
		return fmt.Errorf("failed to mark Traefik config reload pending: %w", err)
	}

	if certificatesChanged {
		if err := traefik.UpdateCertificates(compiled.Certificates); err != nil {
			return fmt.Errorf("failed to update Traefik certificates: %w", err)
		}
	}
	if routesChanged {
		log.Printf("[reconcile] updating Traefik routes (HTTP: %d, TCP: %d, UDP: %d)", len(compiled.HTTP), len(compiled.TCP), len(compiled.UDP))
		if err := traefik.UpdateHttpRoutesWithL4(compiled.HTTP, compiled.TCP, compiled.UDP, a.expectedState.ServerName); err != nil {
			return fmt.Errorf("failed to update Traefik: %w", err)
		}
	}

	if err := traefik.WaitForSuccessfulReloadAfter(a.DataDir, baselineReload, 15*time.Second); err != nil {
		return fmt.Errorf("failed to confirm Traefik config reload: %w", err)
	}

	return nil
}

func (a *Agent) reconcileWireguard(peers []wireguard.Peer) error {
	wgPrivateKey, err := wireguard.LoadPrivateKey(a.DataDir)
	if err != nil {
		return fmt.Errorf("failed to load wireguard private key: %w", err)
	}

	wgConfig := &wireguard.Config{
		PrivateKey: wgPrivateKey,
		Address:    a.Config.WireGuardIP,
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
