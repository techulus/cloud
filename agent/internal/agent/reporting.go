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

var (
	agentStartTime    = time.Now()
	agentVersion      = "dev"
	lastHealthCollect time.Time
	healthCollectMu   sync.Mutex
)

func SetAgentVersion(version string) {
	agentVersion = version
}

func (a *Agent) BuildStatusReport(includeResources bool) *agenthttp.StatusReport {
	report := &agenthttp.StatusReport{
		PublicIP:   a.PublicIP,
		PrivateIP:  a.PrivateIP,
		Containers: []agenthttp.ContainerStatus{},
		DnsInSync:  a.dnsInSync,
	}

	if includeResources {
		report.Resources = GetSystemStats()
		report.Meta = GetSystemMeta()
	}

	healthCollectMu.Lock()
	if time.Since(lastHealthCollect) >= 60*time.Second {
		report.HealthStats = health.CollectSystemStats()
		report.NetworkHealth = health.CollectNetworkHealth("wg0")
		report.ContainerHealth = health.CollectContainerHealth()
		report.AgentHealth = &agenthttp.AgentHealth{
			Version:    agentVersion,
			UptimeSecs: int64(time.Since(agentStartTime).Seconds()),
		}
		lastHealthCollect = time.Now()
		log.Printf("[health] collected: cpu=%.1f%%, mem=%.1f%%, disk=%.1f%%, network=%v, containers=%d running",
			report.HealthStats.CpuUsagePercent, report.HealthStats.MemoryUsagePercent,
			report.HealthStats.DiskUsagePercent, report.NetworkHealth.TunnelUp,
			report.ContainerHealth.RunningContainers)
	}
	healthCollectMu.Unlock()

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

	return report
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
