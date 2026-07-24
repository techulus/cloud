package agent

import (
	"log"
	"os"
	"runtime"
	"sync"
	"time"

	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/dns"
	"techulus/cloud-agent/internal/health"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/logs"
	"techulus/cloud-agent/internal/traefik"

	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
)

var Version = "dev"

const serverlessGatewayCapability = "serverless_gateway"

var (
	agentStartTime    = time.Now()
	lastHealthCollect time.Time
	healthCollectMu   sync.Mutex
)

func (a *Agent) BuildStatusReport(includeResources bool) *agenthttp.StatusReport {
	report := &agenthttp.StatusReport{
		PublicIP:   a.PublicIP,
		PrivateIP:  a.PrivateIP,
		Containers: []agenthttp.ContainerStatus{},
		AgentHealth: &agenthttp.AgentHealth{
			Version:      Version,
			UptimeSecs:   int64(time.Since(agentStartTime).Seconds()),
			Capabilities: a.agentCapabilities(),
		},
	}

	if includeResources {
		report.Resources = GetSystemStats()
		report.Meta = GetSystemMeta()
	}

	healthCollectMu.Lock()
	if time.Since(lastHealthCollect) >= 60*time.Second {
		collectedAt := time.Now()
		systemStats := health.CollectSystemStats()
		if a.MetricsSender != nil {
			go func() {
				if err := a.MetricsSender.SendSystemStats(systemStats, collectedAt); err != nil {
					log.Printf("[metrics] failed to send system stats: %v", err)
				}
				agentStats, err := health.CollectAgentProcessStats()
				if err != nil {
					log.Printf("[metrics] failed to collect agent stats: %v", err)
				} else if err := a.MetricsSender.SendAgentStats(agentStats, collectedAt); err != nil {
					log.Printf("[metrics] failed to send agent stats: %v", err)
				}
				containerStats, err := container.CollectResourceStats()
				if err != nil {
					log.Printf("[metrics] failed to collect container stats: %v", err)
					return
				}
				if err := a.MetricsSender.SendContainerStats(containerStats, collectedAt); err != nil {
					log.Printf("[metrics] failed to send container stats: %v", err)
				}
			}()
		}
		report.NetworkHealth = health.CollectNetworkHealth("wg0")
		report.ContainerHealth = health.CollectContainerHealth()
		lastHealthCollect = time.Now()
		log.Printf("[health] collected: cpu=%.1f%%, mem=%.1f%%, disk=%.1f%%, network=%v, containers=%d running",
			systemStats.CpuUsagePercent, systemStats.MemoryUsagePercent,
			systemStats.DiskUsagePercent, report.NetworkHealth.TunnelUp,
			report.ContainerHealth.RunningContainers)
	}
	healthCollectMu.Unlock()

	containers, err := container.List()
	if err == nil {
		for _, c := range containers {
			if c.DeploymentID == "" {
				continue
			}
			if a.ShouldSuppressServerlessContainerReport(c.DeploymentID) {
				continue
			}
			// A container in a transient state (e.g. "created" mid-deploy) must not
			// be reported as stopped: the control plane would move its deployment to
			// a stopped phase it never recovers from. Report it on a later tick once
			// it settles.
			if c.State != "running" && c.State != "exited" {
				continue
			}

			status := "stopped"
			if c.State == "running" {
				status = "running"
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

	report.DeploymentErrors = a.SnapshotDeploymentErrors()
	report.RoutingSyncedRolloutIds = a.routingSyncedRolloutIds()

	return report
}

func (a *Agent) agentCapabilities() []string {
	if !a.IsProxy || !a.serverlessGatewayRunning.Load() {
		return nil
	}
	return []string{serverlessGatewayCapability}
}

func (a *Agent) routingSyncedRolloutIds() []string {
	expected := a.ExpectedState()
	if expected == nil || len(expected.RoutingSyncRolloutIds) == 0 {
		return nil
	}

	if !a.DisableDNS {
		expectedRecords := make([]dns.DnsRecord, len(expected.Dns.Records))
		for i, record := range expected.Dns.Records {
			expectedRecords[i] = dns.DnsRecord{Name: record.Name, Ips: record.Ips}
		}
		if dns.HashRecords(expectedRecords) != dns.GetCurrentConfigHash() {
			return nil
		}
	}

	if a.IsProxy && !a.proxyRoutingStateConverged(expected) {
		return nil
	}

	return append([]string(nil), expected.RoutingSyncRolloutIds...)
}

func (a *Agent) proxyRoutingStateConverged(expected *agenthttp.ExpectedState) bool {
	httpRoutes := ConvertToHttpRoutes(expected.Traefik.HttpRoutes)
	if traefik.HashRoutesWithServerName(httpRoutes, expected.ServerName) != traefik.GetCurrentConfigHash() {
		return false
	}
	tcpRoutes := ConvertToTCPRoutes(expected.Traefik.TCPRoutes)
	udpRoutes := ConvertToUDPRoutes(expected.Traefik.UDPRoutes)
	if traefik.HashTCPRoutes(tcpRoutes)+traefik.HashUDPRoutes(udpRoutes) != traefik.GetCurrentL4ConfigHash() {
		return false
	}
	certificates := make([]traefik.Certificate, len(expected.Traefik.Certificates))
	for i, certificate := range expected.Traefik.Certificates {
		certificates[i] = traefik.Certificate{
			Domain:         certificate.Domain,
			Certificate:    certificate.Certificate,
			CertificateKey: certificate.CertificateKey,
		}
	}
	if traefik.HashCertificates(certificates) != traefik.GetCurrentCertificatesHash() {
		return false
	}
	reloaded, err := traefik.DynamicConfigReloaded(a.DataDir)
	return err == nil && reloaded
}

func (a *Agent) RecordDeploymentError(deploymentID string, err error) {
	if deploymentID == "" || err == nil {
		return
	}

	a.deploymentErrorMutex.Lock()
	defer a.deploymentErrorMutex.Unlock()

	a.pendingDeploymentErrors = append(a.pendingDeploymentErrors, agenthttp.DeploymentError{
		DeploymentID: deploymentID,
		Message:      err.Error(),
	})
}

func (a *Agent) SnapshotDeploymentErrors() []agenthttp.DeploymentError {
	a.deploymentErrorMutex.Lock()
	defer a.deploymentErrorMutex.Unlock()

	return append([]agenthttp.DeploymentError(nil), a.pendingDeploymentErrors...)
}

func (a *Agent) ClearReportedDeploymentErrors(count int) {
	a.deploymentErrorMutex.Lock()
	defer a.deploymentErrorMutex.Unlock()

	if count >= len(a.pendingDeploymentErrors) {
		a.pendingDeploymentErrors = nil
		return
	}

	a.pendingDeploymentErrors = a.pendingDeploymentErrors[count:]
}

func (a *Agent) CollectLogs() {
	if a.LogCollector == nil {
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
		if c.State != "running" && c.State != "exited" {
			continue
		}
		containerInfos = append(containerInfos, logs.ContainerInfo{
			DeploymentID: c.DeploymentID,
			ServiceID:    c.ServiceID,
			ContainerID:  c.ID,
		})
	}

	a.LogCollector.UpdateContainers(containerInfos)
	a.LogCollector.Collect()
}

func GetSystemStats() *agenthttp.Resources {
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

func GetSystemMeta() map[string]string {
	meta := map[string]string{
		"arch": runtime.GOARCH,
		"os":   runtime.GOOS,
	}

	if hostname, err := os.Hostname(); err == nil {
		meta["hostname"] = hostname
	}

	return meta
}
