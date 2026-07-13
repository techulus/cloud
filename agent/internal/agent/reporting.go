package agent

import (
	"log"
	"os"
	"runtime"
	"sync"
	"time"

	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/health"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/logs"

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
		DnsInSync:  a.dnsInSync,
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

	report.DeploymentErrors = a.SnapshotDeploymentErrors()

	return report
}

func (a *Agent) agentCapabilities() []string {
	if !a.IsProxy || !a.serverlessGatewayRunning.Load() {
		return nil
	}
	return []string{serverlessGatewayCapability}
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
