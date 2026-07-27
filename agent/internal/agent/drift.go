package agent

import (
	"context"
	"fmt"
	"log"
	"sort"
	"sync"
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
	if !a.claimReconcileLane() {
		return
	}
	defer func() {
		if a.GetState() == StateIdle {
			a.releaseReconcileLane()
		}
	}()
	switch a.GetState() {
	case StateIdle:
		a.handleIdle()
	case StateProcessing:
		a.handleProcessing()
	}
}

func (a *Agent) claimReconcileLane() bool {
	a.workLaneMutex.Lock()
	defer a.workLaneMutex.Unlock()
	if a.internalReconcileLaneActive {
		return !a.exclusiveLaneActive && a.runtimeLaneActive
	}
	if a.reconcileWorkLaneActive {
		if a.exclusiveLaneActive || !a.runtimeLaneActive {
			return false
		}
		a.internalReconcileLaneActive = true
		return true
	}
	if a.exclusiveLaneActive || a.runtimeLaneActive {
		return false
	}
	a.runtimeLaneActive = true
	a.internalReconcileLaneActive = true
	return true
}

func (a *Agent) releaseReconcileLane() {
	a.workLaneMutex.Lock()
	if a.internalReconcileLaneActive {
		a.internalReconcileLaneActive = false
		if !a.reconcileWorkLaneActive {
			a.runtimeLaneActive = false
		}
	}
	a.workLaneMutex.Unlock()
	a.startPendingWorkItems()
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
	a.processingImages = nil
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

	images, err := a.resolveExpectedImages(expected)
	if err != nil {
		log.Printf("[idle] failed to resolve expected images: %v", err)
		return
	}
	actions := a.planReconcile(expected, actual, images)
	if len(actions) > 0 {
		log.Printf("[idle] drift detected, %d change(s) to apply:", len(actions))
		for _, action := range actions {
			log.Printf("  → %s", action.Description)
		}
		log.Printf("[idle] transitioning to PROCESSING")
		a.expectedState = expected
		a.processingImages = images
		a.processingStart = time.Now()
		a.lastAppliedActionKey = ""
		a.SetState(StateProcessing)
		a.signalContinueProcessing()
		return
	}
	if err := verifyExpectedContainerIdentities(expected, actual.Containers, images); err != nil {
		log.Printf("[idle] state is not safely converged: %v", err)
		return
	}
	a.expectedStateMutex.Lock()
	a.latestAppliedGeneration = expected.Generation
	a.expectedStateMutex.Unlock()
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

	images := a.processingImages
	actions := a.planReconcile(a.expectedState, actual, images)

	if len(actions) == 0 {
		log.Printf("[processing] state converged, transitioning to IDLE")
		a.transitionToIdle()
		return
	}

	if err := a.applyReconcilePhases(actions, images); err != nil {
		log.Printf("[processing] reconciliation failed: %v, transitioning to IDLE", err)
		a.RequestStatusReport("reconcile failed")
		a.transitionToIdle()
		return
	}

	a.RequestStatusReport("reconcile completed")
	a.signalContinueProcessing()
}

func isLifecycleAction(kind reconcileActionKind) bool {
	return kind == actionDeployMissingContainer || kind == actionRedeployContainer || kind == actionStartContainer
}
func isNetworkAction(kind reconcileActionKind) bool {
	return kind == actionUpdateDNS || kind == actionUpdateTraefik || kind == actionWriteChallengeRoute || kind == actionUpdateWireGuard || kind == actionStartWireGuard
}

func (a *Agent) applyReconcilePhases(actions []reconcileAction, images map[string]container.ResolvedImage) error {
	for _, action := range actions {
		if !isLifecycleAction(action.Kind) && !isNetworkAction(action.Kind) {
			if err := a.applyReconcileAction(action); err != nil {
				a.RecordDeploymentError(action.DeploymentID, err)
				return err
			}
		}
	}
	lifecycle := make([]reconcileAction, 0)
	for _, action := range actions {
		if isLifecycleAction(action.Kind) {
			lifecycle = append(lifecycle, action)
		}
	}
	if err := a.applyLifecycleActions(lifecycle, images); err != nil {
		return err
	}
	actual, err := a.getActualState()
	if err != nil {
		return err
	}
	for _, action := range a.planReconcile(a.expectedState, actual, images) {
		if isNetworkAction(action.Kind) {
			if err := a.applyReconcileAction(action); err != nil {
				return err
			}
		}
	}
	verified, err := a.getActualState()
	if err != nil {
		return err
	}
	if err := verifyExpectedContainerIdentities(a.expectedState, verified.Containers, images); err != nil {
		return err
	}
	a.expectedStateMutex.Lock()
	a.latestAppliedGeneration = a.expectedState.Generation
	a.expectedStateMutex.Unlock()
	return nil
}

func verifyExpectedContainerIdentities(expected *agenthttp.ExpectedState, actual []container.Container, images map[string]container.ResolvedImage) error {
	byDeployment := make(map[string][]container.Container)
	for _, current := range actual {
		if current.DeploymentID != "" {
			byDeployment[current.DeploymentID] = append(byDeployment[current.DeploymentID], current)
		}
	}
	for _, wanted := range expected.Containers {
		if desiredContainerState(wanted) == "stopped" {
			continue
		}
		matches := byDeployment[wanted.DeploymentID]
		if len(matches) != 1 {
			return fmt.Errorf("deployment %s has %d containers; expected exactly one", wanted.DeploymentID, len(matches))
		}
		current := matches[0]
		if current.State != "running" {
			return fmt.Errorf("deployment %s container is %s, expected running", wanted.DeploymentID, current.State)
		}
		resolved := string(images[wanted.Image])
		if resolved == "" || current.ImageID == "" || current.ImageID != resolved {
			return fmt.Errorf("deployment %s image identity mismatch: expected=%q imageID=%q", wanted.DeploymentID, resolved, current.ImageID)
		}
	}
	return nil
}

func (a *Agent) resolveExpectedImages(expected *agenthttp.ExpectedState) (map[string]container.ResolvedImage, error) {
	images := make(map[string]container.ResolvedImage)
	for _, wanted := range expected.Containers {
		if desiredContainerState(wanted) == "stopped" {
			continue
		}
		if _, ok := images[wanted.Image]; ok {
			continue
		}
		resolved, err := a.Reconciler.PullImage(context.Background(), wanted.Image)
		if err != nil {
			return nil, err
		}
		images[wanted.Image] = resolved
	}
	return images, nil
}

func (a *Agent) applyLifecycleActions(actions []reconcileAction, images map[string]container.ResolvedImage) error {
	for _, action := range actions {
		if action.Expected == nil {
			return fmt.Errorf("missing expected container for %s", action.Kind)
		}
		if action.Kind != actionDeployMissingContainer && action.Actual == nil {
			return fmt.Errorf("missing actual container for %s", action.Kind)
		}
	}

	sem := make(chan struct{}, 2)
	var wg sync.WaitGroup
	var firstErr error
	var errMu sync.Mutex
	for _, current := range actions {
		action := current
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			err := a.withDeploymentOperationLock(action.DeploymentID, func() error {
				resolved := images[action.Expected.Image]
				if action.Kind == actionStartContainer {
					if action.Actual.ImageID == string(resolved) {
						if err := container.Start(action.Actual.ID); err == nil {
							a.monitorContainerHealth(action.Actual.ID, *action.Expected)
							return nil
						}
					}
					if err := container.Stop(action.Actual.ID); err != nil {
						log.Printf("[reconcile] warning: failed to stop old container: %v", err)
					}
				}
				if action.Kind == actionRedeployContainer && action.Actual != nil {
					if err := container.Stop(action.Actual.ID); err != nil {
						log.Printf("[reconcile] warning: failed to stop old container: %v", err)
					}
				}
				result, err := a.Reconciler.DeployResolved(context.Background(), *action.Expected, images[action.Expected.Image])
				if err == nil {
					a.monitorContainerHealth(result.ContainerID, *action.Expected)
				}
				return err
			})
			if err != nil {
				errMu.Lock()
				if firstErr == nil {
					firstErr = err
					a.RecordDeploymentError(action.DeploymentID, err)
				}
				errMu.Unlock()
			}
		}()
	}
	wg.Wait()
	return firstErr
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

func (a *Agent) planReconcile(expected *agenthttp.ExpectedState, actual *ActualState, images map[string]container.ResolvedImage) []reconcileAction {
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

			resolved := string(images[exp.Image])
			identityMismatch := resolved == "" || act.ImageID == "" || act.ImageID != resolved
			if identityMismatch {
				actions = append(actions, reconcileAction{
					Kind:         actionRedeployContainer,
					Description:  fmt.Sprintf("REDEPLOY %s (image identity: %s → %s)", exp.Name, act.ImageID, resolved),
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
	sort.SliceStable(actions, func(i, j int) bool { return reconcileActionKey(actions[i]) < reconcileActionKey(actions[j]) })

	return actions
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
		if err := a.withDeploymentOperationLock(action.DeploymentID, func() error { return container.Stop(action.Actual.ID) }); err != nil {
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
		if err := a.withDeploymentOperationLock(action.DeploymentID, func() error { return container.ForceRemove(action.Actual.ID) }); err != nil {
			return fmt.Errorf("failed to remove orphan container: %w", err)
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
