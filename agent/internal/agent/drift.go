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
	actionWaitLegacyCutover          reconcileActionKind = "wait_legacy_cutover"
	actionUpdateDNS                  reconcileActionKind = "update_dns"
	actionUpdateTraefik              reconcileActionKind = "update_traefik"
	actionUpdateCertificates         reconcileActionKind = "update_certificates"
	actionWriteChallengeRoute        reconcileActionKind = "write_challenge_route"
	actionUpdateWireGuard            reconcileActionKind = "update_wireguard"
	actionStartWireGuard             reconcileActionKind = "start_wireguard"
	legacyCutoverStabilizationDelay                      = 30 * time.Second
	legacyCutoverMaxWait                                 = 5 * time.Minute
)

type reconcileAction struct {
	Kind         reconcileActionKind
	Description  string
	DeploymentID string
	Expected     *agenthttp.ExpectedContainer
	Actual       *container.Container
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

	a.updateDnsInSync(expected, actual)

	actions := a.planReconcile(expected, actual)
	if len(actions) > 0 {
		log.Printf("[idle] drift detected, %d change(s) to apply:", len(actions))
		for _, action := range actions {
			log.Printf("  → %s", action.Description)
		}
		log.Printf("[idle] transitioning to PROCESSING")
		a.expectedState = expected
		a.processingStart = time.Now()
		a.SetState(StateProcessing)
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

	a.updateDnsInSync(a.expectedState, actual)
	actions := a.planReconcile(a.expectedState, actual)
	actions, waitingForCutoverHealth := a.gateLegacyCutoverRecreations(
		actions,
		actual,
	)

	if len(actions) == 0 {
		if waitingForCutoverHealth {
			return
		}
		a.clearReconcileFailures()
		log.Printf("[processing] state converged, transitioning to IDLE")
		a.transitionToIdle()
		return
	}

	action, eligible, nextRetryAt := a.nextEligibleReconcileAction(actions, time.Now())
	if !eligible {
		log.Printf("[processing] all %d pending actions are backed off; next retry at %s", len(actions), nextRetryAt.Format(time.RFC3339))
		return
	}
	if err := a.applyReconcileAction(action); err != nil {
		failure := a.recordReconcileFailure(action, err, time.Now())
		log.Printf("[processing] reconciliation action failed (attempt %d); continuing with remaining actions, retry at %s: %v", failure.Attempts, failure.NextRetryAt.Format(time.RFC3339), err)
		a.RecordDeploymentError(action.DeploymentID, err)
		a.RequestStatusReport("reconcile failed")
		return
	}

	a.clearReconcileFailure(action)
	if a.legacyCutoverHealthWait == action.DeploymentID &&
		(action.Kind == actionDeployMissingContainer ||
			action.Kind == actionStartContainer ||
			action.Kind == actionRedeployContainer) {
		a.legacyCutoverHealthWaitSince = time.Now()
	}
	if isLegacyCutoverRecreation(action) {
		a.legacyCutoverHealthWait = action.DeploymentID
		a.legacyCutoverHealthWaitSince = time.Now()
		log.Printf("[processing] waiting for deployment %s to stabilize before recreating another legacy container", action.DeploymentID)
	}
	a.RequestStatusReport("reconcile completed")
}

func isLegacyCutoverRecreation(action reconcileAction) bool {
	return action.Kind == actionRedeployContainer &&
		action.Actual != nil &&
		action.Actual.SpecHash == "" &&
		action.Expected != nil &&
		action.Expected.ContainerSpecHash != ""
}

func (a *Agent) gateLegacyCutoverRecreations(
	actions []reconcileAction,
	actual *ActualState,
) ([]reconcileAction, bool) {
	if a.legacyCutoverHealthWait == "" {
		return actions, false
	}
	var waitingExpected *agenthttp.ExpectedContainer
	for _, expectedContainer := range a.expectedState.Containers {
		if expectedContainer.DeploymentID == a.legacyCutoverHealthWait {
			copy := expectedContainer
			waitingExpected = &copy
			break
		}
	}
	if waitingExpected == nil {
		a.legacyCutoverHealthWait = ""
		a.legacyCutoverHealthWaitSince = time.Time{}
		return actions, false
	}

	var waitingContainer *container.Container
	for i := range actual.Containers {
		if actual.Containers[i].DeploymentID == a.legacyCutoverHealthWait {
			waitingContainer = &actual.Containers[i]
			break
		}
	}
	ready := false
	if waitingContainer != nil && waitingContainer.State == "running" {
		if waitingExpected.HealthCheck != nil {
			ready = container.GetHealthStatus(waitingContainer.ID) == "healthy"
		} else {
			ready = time.Since(a.legacyCutoverHealthWaitSince) >= legacyCutoverStabilizationDelay
		}
	}
	if ready {
		log.Printf("[processing] deployment %s is stable; legacy recreation may continue", a.legacyCutoverHealthWait)
		a.legacyCutoverHealthWait = ""
		a.legacyCutoverHealthWaitSince = time.Time{}
		return actions, false
	}

	if time.Since(a.legacyCutoverHealthWaitSince) >= legacyCutoverMaxWait {
		deploymentID := a.legacyCutoverHealthWait
		log.Printf("[processing] deployment %s did not stabilize; releasing legacy recreation gate", deploymentID)
		a.legacyCutoverHealthWait = ""
		a.legacyCutoverHealthWaitSince = time.Time{}
		return []reconcileAction{{
			Kind:         actionWaitLegacyCutover,
			DeploymentID: deploymentID,
			Description:  fmt.Sprintf("WAIT for legacy deployment %s to stabilize", deploymentID),
			Expected:     waitingExpected,
			Actual:       waitingContainer,
		}}, false
	}

	filtered := make([]reconcileAction, 0, len(actions))
	for _, action := range actions {
		if isLegacyCutoverRecreation(action) {
			continue
		}
		filtered = append(filtered, action)
	}
	return filtered, true
}

func (a *Agent) updateDnsInSync(expected *agenthttp.ExpectedState, actual *ActualState) {
	if a.DisableDNS {
		a.dnsInSync = true
		return
	}
	expectedDnsRecords := make([]dns.DnsRecord, len(expected.Dns.Records))
	for i, r := range expected.Dns.Records {
		expectedDnsRecords[i] = dns.DnsRecord{Name: r.Name, Ips: r.Ips}
	}
	a.dnsInSync = dns.HashRecords(expectedDnsRecords) == actual.DnsConfigHash
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

			if exp.ContainerSpecHash == "" || act.SpecHash != exp.ContainerSpecHash {
				reason := "container specification changed"
				if act.SpecHash == "" {
					reason = "legacy container is missing revision labels"
				}
				actions = append(actions, reconcileAction{
					Kind:         actionRedeployContainer,
					Description:  fmt.Sprintf("REDEPLOY %s (%s)", exp.Name, reason),
					DeploymentID: id,
					Expected:     &expectedContainer,
					Actual:       &actualContainer,
				})
			} else if normalizeImage(exp.Image) != normalizeImage(act.Image) {
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
		expectedHttpRoutes := ConvertToHttpRoutes(expected.Traefik.HttpRoutes)
		expectedTraefikHash := traefik.HashRoutesWithServerName(expectedHttpRoutes, expected.ServerName)
		if expectedTraefikHash != actual.TraefikConfigHash {
			actions = append(actions, reconcileAction{
				Kind:        actionUpdateTraefik,
				Description: fmt.Sprintf("UPDATE Traefik HTTP (%d routes)", len(expected.Traefik.HttpRoutes)),
			})
		}

		tcpRoutes := ConvertToTCPRoutes(expected.Traefik.TCPRoutes)
		udpRoutes := ConvertToUDPRoutes(expected.Traefik.UDPRoutes)
		expectedL4Hash := traefik.HashTCPRoutes(tcpRoutes) + traefik.HashUDPRoutes(udpRoutes)
		if expectedL4Hash != actual.L4ConfigHash {
			actions = append(actions, reconcileAction{
				Kind:        actionUpdateTraefik,
				Description: fmt.Sprintf("UPDATE Traefik L4 (%d TCP, %d UDP)", len(tcpRoutes), len(udpRoutes)),
			})
		}

		expectedCerts := make([]traefik.Certificate, len(expected.Traefik.Certificates))
		for i, c := range expected.Traefik.Certificates {
			expectedCerts[i] = traefik.Certificate{Domain: c.Domain, Certificate: c.Certificate, CertificateKey: c.CertificateKey}
		}
		expectedCertsHash := traefik.HashCertificates(expectedCerts)
		if expectedCertsHash != actual.CertificatesHash {
			actions = append(actions, reconcileAction{
				Kind:        actionUpdateCertificates,
				Description: fmt.Sprintf("UPDATE Certificates (%d certs)", len(expected.Traefik.Certificates)),
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
			log.Printf("[reconcile] warning: failed to remove orphan container after retries: %v", err)
		}
		return nil

	case actionRemoveUnexpectedContainer:
		if action.Actual == nil {
			return fmt.Errorf("missing actual container for %s", action.Kind)
		}
		if err := container.ForceRemove(action.Actual.ID); err != nil {
			log.Printf("[reconcile] warning: failed to remove orphan: %v", err)
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
			if err := a.DeployExpectedContainer(*action.Expected); err != nil {
				return fmt.Errorf("failed to redeploy container: %w", err)
			}
		}
		return nil

	case actionRedeployContainer:
		if action.Actual == nil || action.Expected == nil {
			return fmt.Errorf("missing container state for %s", action.Kind)
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

	case actionUpdateCertificates:
		expectedCerts := make([]traefik.Certificate, len(a.expectedState.Traefik.Certificates))
		for i, c := range a.expectedState.Traefik.Certificates {
			expectedCerts[i] = traefik.Certificate{Domain: c.Domain, Certificate: c.Certificate, CertificateKey: c.CertificateKey}
		}
		if err := traefik.UpdateCertificates(expectedCerts); err != nil {
			return fmt.Errorf("failed to update certificates: %w", err)
		}
		return nil

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

	case actionWaitLegacyCutover:
		return fmt.Errorf("deployment %s did not stabilize within %s", action.DeploymentID, legacyCutoverMaxWait)

	default:
		return fmt.Errorf("unknown reconcile action: %s", action.Kind)
	}
}

func (a *Agent) updateTraefik() error {
	expectedHttpRoutes := ConvertToHttpRoutes(a.expectedState.Traefik.HttpRoutes)
	tcpRoutes := ConvertToTCPRoutes(a.expectedState.Traefik.TCPRoutes)
	udpRoutes := ConvertToUDPRoutes(a.expectedState.Traefik.UDPRoutes)

	var tcpPorts, udpPorts []int
	for _, r := range tcpRoutes {
		tcpPorts = append(tcpPorts, r.ExternalPort)
	}
	for _, r := range udpRoutes {
		udpPorts = append(udpPorts, r.ExternalPort)
	}

	needsRestart := false
	metricsRestart, err := traefik.EnsureMetricsConfig()
	if err != nil {
		return fmt.Errorf("failed to ensure Traefik metrics config: %w", err)
	}
	needsRestart = metricsRestart

	if len(tcpPorts) > 0 || len(udpPorts) > 0 {
		log.Printf("[reconcile] ensuring L4 entry points: %d TCP, %d UDP", len(tcpPorts), len(udpPorts))
		entryPointsRestart, err := traefik.EnsureEntryPoints(tcpPorts, udpPorts)
		if err != nil {
			return fmt.Errorf("failed to ensure entry points: %w", err)
		}
		needsRestart = needsRestart || entryPointsRestart
	}

	log.Printf("[reconcile] updating Traefik routes (HTTP: %d, TCP: %d, UDP: %d)", len(expectedHttpRoutes), len(tcpRoutes), len(udpRoutes))
	if err := traefik.UpdateHttpRoutesWithL4(expectedHttpRoutes, tcpRoutes, udpRoutes, a.expectedState.ServerName); err != nil {
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
