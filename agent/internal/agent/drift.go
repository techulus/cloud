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

func (a *Agent) Tick() {
	switch a.GetState() {
	case StateIdle:
		a.handleIdle()
	case StateProcessing:
		a.handleProcessing()
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

	actual, err := a.getActualState()
	if err != nil {
		log.Printf("[idle] failed to get actual state: %v", err)
		return
	}

	a.updateDnsInSync(expected, actual)

	changes := a.detectChanges(expected, actual)
	if len(changes) > 0 {
		log.Printf("[idle] drift detected, %d change(s) to apply:", len(changes))
		for _, change := range changes {
			log.Printf("  → %s", change)
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
		a.SetState(StateIdle)
		return
	}

	actual, err := a.getActualState()
	if err != nil {
		log.Printf("[processing] failed to get actual state: %v", err)
		a.SetState(StateIdle)
		return
	}

	a.updateDnsInSync(a.expectedState, actual)

	if len(a.detectChanges(a.expectedState, actual)) == 0 {
		log.Printf("[processing] state converged, transitioning to IDLE")
		a.SetState(StateIdle)
		return
	}

	err = a.reconcileOne(actual)
	if err != nil {
		log.Printf("[processing] reconciliation failed: %v, transitioning to IDLE", err)
		a.SetState(StateIdle)
		return
	}
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

	if !a.DisableDNS {
		expectedDnsRecords := make([]dns.DnsRecord, len(expected.Dns.Records))
		for i, r := range expected.Dns.Records {
			expectedDnsRecords[i] = dns.DnsRecord{Name: r.Name, Ips: r.Ips}
		}
		expectedDnsHash := dns.HashRecords(expectedDnsRecords)
		if expectedDnsHash != actual.DnsConfigHash {
			changes = append(changes, fmt.Sprintf("UPDATE DNS (%d records)", len(expected.Dns.Records)))
		}
	}

	if a.IsProxy {
		expectedHttpRoutes := ConvertToHttpRoutes(expected.Traefik.HttpRoutes)
		expectedTraefikHash := traefik.HashRoutesWithServerName(expectedHttpRoutes, expected.ServerName)
		if expectedTraefikHash != actual.TraefikConfigHash {
			changes = append(changes, fmt.Sprintf("UPDATE Traefik HTTP (%d routes)", len(expected.Traefik.HttpRoutes)))
		}

		tcpRoutes := ConvertToTCPRoutes(expected.Traefik.TCPRoutes)
		udpRoutes := ConvertToUDPRoutes(expected.Traefik.UDPRoutes)
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
			if err := a.Reconciler.Deploy(exp); err != nil {
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
					if err := a.Reconciler.Deploy(exp); err != nil {
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
				if err := a.Reconciler.Deploy(exp); err != nil {
					return fmt.Errorf("failed to redeploy container: %w", err)
				}
				return nil
			}
		}
	}

	if !a.DisableDNS {
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
	}

	if a.IsProxy {
		expectedHttpRoutes := ConvertToHttpRoutes(a.expectedState.Traefik.HttpRoutes)
		tcpRoutes := ConvertToTCPRoutes(a.expectedState.Traefik.TCPRoutes)
		udpRoutes := ConvertToUDPRoutes(a.expectedState.Traefik.UDPRoutes)

		httpDrift := traefik.HashRoutesWithServerName(expectedHttpRoutes, a.expectedState.ServerName) != actual.TraefikConfigHash
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
