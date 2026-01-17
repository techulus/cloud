package agent

import (
	"context"
	"log"
	"os"
	"runtime"
	"time"

	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/logs"

	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
)

func (a *Agent) HeartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.ReportStatus(false)
		}
	}
}

func (a *Agent) ReportStatus(includeResources bool) {
	report := &agenthttp.StatusReport{
		PublicIP:   a.PublicIP,
		PrivateIP:  a.PrivateIP,
		Containers: []agenthttp.ContainerStatus{},
	}

	if includeResources {
		report.Resources = GetSystemStats()
		report.Meta = GetSystemMeta()
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

	if err := a.Client.ReportStatus(report); err != nil {
		log.Printf("[status] failed to report status: %v", err)
	}
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
