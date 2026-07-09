package health

import (
	"math"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/process"
)

type SystemStats struct {
	CpuUsagePercent    float64 `json:"cpuUsagePercent"`
	MemoryUsagePercent float64 `json:"memoryUsagePercent"`
	MemoryUsedMb       int     `json:"memoryUsedMb"`
	DiskUsagePercent   float64 `json:"diskUsagePercent"`
	DiskUsedGb         int     `json:"diskUsedGb"`
}

type AgentProcessStats struct {
	CPUUsagePercent    float64
	MemoryUsagePercent float64
	MemoryUsedBytes    uint64
}

type NetworkPeerHealth struct {
	ID           string `json:"id"`
	LastSeenSecs int    `json:"lastSeenSecs"`
	Reachable    bool   `json:"reachable"`
}

type NetworkHealth struct {
	TunnelUp  bool                `json:"tunnelUp"`
	PeerCount int                 `json:"peerCount"`
	Peers     []NetworkPeerHealth `json:"peers"`
}

type ContainerHealth struct {
	RuntimeResponsive bool    `json:"runtimeResponsive"`
	RunningContainers int     `json:"runningContainers"`
	StoppedContainers int     `json:"stoppedContainers"`
	StorageUsedGb     float64 `json:"storageUsedGb"`
}

type AgentHealthInfo struct {
	Version         string `json:"version"`
	UptimeSecs      int64  `json:"uptimeSecs"`
	LastSyncSuccess bool   `json:"lastSyncSuccess"`
	LastSyncAt      string `json:"lastSyncAt"`
}

var (
	agentProcessCPUMu        sync.Mutex
	agentProcessLastCPUTimes *cpu.TimesStat
	agentProcessLastCPUTime  time.Time
)

func CollectSystemStats() *SystemStats {
	stats := &SystemStats{}

	cpuPercent, err := cpu.Percent(time.Second, false)
	if err == nil && len(cpuPercent) > 0 {
		stats.CpuUsagePercent = cpuPercent[0]
	}

	memInfo, err := mem.VirtualMemory()
	if err == nil {
		stats.MemoryUsagePercent = memInfo.UsedPercent
		stats.MemoryUsedMb = int(memInfo.Used / 1024 / 1024)
	}

	diskInfo, err := disk.Usage("/")
	if err == nil {
		stats.DiskUsagePercent = diskInfo.UsedPercent
		stats.DiskUsedGb = int(diskInfo.Used / 1024 / 1024 / 1024)
	}

	return stats
}

func CollectAgentProcessStats() (*AgentProcessStats, error) {
	proc, err := process.NewProcess(int32(os.Getpid()))
	if err != nil {
		return nil, err
	}

	stats := &AgentProcessStats{}

	cpuPercent, err := collectAgentCPUPercent(proc)
	if err != nil {
		return nil, err
	}
	stats.CPUUsagePercent = cpuPercent

	memInfo, err := proc.MemoryInfo()
	if err != nil {
		return nil, err
	}
	stats.MemoryUsedBytes = memInfo.RSS

	memPercent, err := proc.MemoryPercent()
	if err != nil {
		return nil, err
	}
	stats.MemoryUsagePercent = float64(memPercent)

	return stats, nil
}

func collectAgentCPUPercent(proc *process.Process) (float64, error) {
	cpuTimes, err := proc.Times()
	if err != nil {
		return 0, err
	}
	now := time.Now()

	agentProcessCPUMu.Lock()
	defer agentProcessCPUMu.Unlock()

	if agentProcessLastCPUTimes == nil || agentProcessLastCPUTime.IsZero() {
		// Delta-based CPU metrics need one sample to establish the baseline.
		agentProcessLastCPUTimes = cpuTimes
		agentProcessLastCPUTime = now
		return 0, nil
	}

	elapsedSeconds := now.Sub(agentProcessLastCPUTime).Seconds()
	percent := calculateAgentCPUUsagePercent(
		agentProcessLastCPUTimes,
		cpuTimes,
		elapsedSeconds,
		runtime.NumCPU(),
	)
	agentProcessLastCPUTimes = cpuTimes
	agentProcessLastCPUTime = now

	return percent, nil
}

func calculateAgentCPUUsagePercent(previous, current *cpu.TimesStat, elapsedSeconds float64, cpuCount int) float64 {
	if previous == nil || current == nil {
		return 0
	}

	cpuDeltaSeconds := processCPUTotal(current) - processCPUTotal(previous)
	if elapsedSeconds <= 0 || cpuDeltaSeconds < 0 {
		return 0
	}
	if cpuCount <= 0 {
		cpuCount = 1
	}

	percent := (cpuDeltaSeconds / elapsedSeconds) * 100 / float64(cpuCount)
	if math.IsNaN(percent) || math.IsInf(percent, 0) {
		return 0
	}
	return percent
}

func processCPUTotal(times *cpu.TimesStat) float64 {
	return times.User + times.System
}

func CollectNetworkHealth(interfaceName string) *NetworkHealth {
	health := &NetworkHealth{
		TunnelUp: false,
		Peers:    []NetworkPeerHealth{},
	}

	cmd := exec.Command("wg", "show", interfaceName, "dump")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return health
	}

	health.TunnelUp = true

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) < 1 {
		return health
	}

	for i, line := range lines {
		if i == 0 {
			continue
		}

		fields := strings.Split(line, "\t")
		if len(fields) < 5 {
			continue
		}

		publicKey := fields[0]
		lastHandshake := fields[4]

		var lastSeenSecs int
		reachable := false

		if lastHandshake != "0" {
			ts, err := parseUnixTimestamp(lastHandshake)
			if err == nil {
				lastSeenSecs = int(time.Since(ts).Seconds())
				reachable = lastSeenSecs < 180
			}
		}

		health.Peers = append(health.Peers, NetworkPeerHealth{
			ID:           publicKey[:8],
			LastSeenSecs: lastSeenSecs,
			Reachable:    reachable,
		})
	}

	health.PeerCount = len(health.Peers)

	return health
}

func parseUnixTimestamp(s string) (time.Time, error) {
	ts, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return time.Time{}, err
	}
	return time.Unix(ts, 0), nil
}

func CollectContainerHealth() *ContainerHealth {
	health := &ContainerHealth{
		RuntimeResponsive: false,
	}

	cmd := exec.Command("podman", "ps", "-a", "--format", "{{.State}}")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return health
	}

	health.RuntimeResponsive = true

	states := strings.Split(strings.TrimSpace(string(output)), "\n")
	for _, state := range states {
		if state == "" {
			continue
		}
		if state == "running" {
			health.RunningContainers++
		} else {
			health.StoppedContainers++
		}
	}

	infoCmd := exec.Command("podman", "system", "info", "--format", "{{.Store.GraphRoot}}")
	infoOutput, err := infoCmd.CombinedOutput()
	if err == nil {
		graphRoot := strings.TrimSpace(string(infoOutput))
		if graphRoot != "" {
			diskInfo, err := disk.Usage(graphRoot)
			if err == nil {
				health.StorageUsedGb = float64(diskInfo.Used) / 1024 / 1024 / 1024
			}
		}
	}

	return health
}
