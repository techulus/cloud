package health

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
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

type CrowdSecHealth struct {
	CheckedAt string                   `json:"checkedAt"`
	LAPI      CrowdSecAvailability     `json:"lapi"`
	Metrics   CrowdSecMetrics          `json:"metrics"`
	Bouncer   CrowdSecBouncer          `json:"bouncer"`
	Decisions CrowdSecDecisionSnapshot `json:"decisions"`
	Alerts    CrowdSecAlertSnapshot    `json:"alerts"`
}

type CrowdSecAvailability struct {
	Available bool `json:"available"`
}

type CrowdSecMetrics struct {
	Available bool  `json:"available"`
	Reads     int64 `json:"reads"`
	Parsed    int64 `json:"parsed"`
	Unparsed  int64 `json:"unparsed"`
}

type CrowdSecBouncer struct {
	Available  bool   `json:"available"`
	Error      string `json:"error,omitempty"`
	Registered bool   `json:"registered"`
	Revoked    bool   `json:"revoked"`
	LastPullAt string `json:"lastPullAt,omitempty"`
}

type CrowdSecDecision struct {
	Scope     string `json:"scope"`
	Value     string `json:"value"`
	Action    string `json:"action"`
	Reason    string `json:"reason"`
	Origin    string `json:"origin"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

type CrowdSecDecisionSnapshot struct {
	Available bool               `json:"available"`
	Truncated bool               `json:"truncated"`
	Records   []CrowdSecDecision `json:"records"`
}

type CrowdSecAlert struct {
	ID         int64  `json:"id"`
	DetectedAt string `json:"detectedAt"`
	Scenario   string `json:"scenario"`
	SourceIP   string `json:"sourceIp"`
	Country    string `json:"country"`
	EventCount int64  `json:"eventCount"`
}

type CrowdSecAlertSnapshot struct {
	Available bool            `json:"available"`
	Truncated bool            `json:"truncated"`
	Records   []CrowdSecAlert `json:"records"`
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

const crowdSecCollectionTimeout = 10 * time.Second

func CollectCrowdSecHealth() *CrowdSecHealth {
	health := &CrowdSecHealth{
		CheckedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Decisions: CrowdSecDecisionSnapshot{Records: []CrowdSecDecision{}},
		Alerts:    CrowdSecAlertSnapshot{Records: []CrowdSecAlert{}},
	}
	ctx, cancel := context.WithTimeout(context.Background(), crowdSecCollectionTimeout)
	defer cancel()

	_, err := runCrowdSec(ctx, "lapi", "status")
	health.LAPI.Available = err == nil

	if output, err := runCrowdSec(ctx, "metrics", "-o", "json"); err == nil {
		parseCrowdSecMetrics(output, &health.Metrics)
	}
	if output, err := runCrowdSec(ctx, "bouncers", "list", "-o", "json"); err != nil {
		health.Bouncer.Error = "command_failed"
	} else if !parseCrowdSecBouncer(output, &health.Bouncer) {
		health.Bouncer.Error = "invalid_output"
	}
	if output, err := runCrowdSec(ctx, "decisions", "list", "--no-simu", "--limit", "51", "-o", "json"); err == nil {
		parseCrowdSecDecisions(output, &health.Decisions)
	}
	if output, err := runCrowdSec(ctx, "alerts", "list", "--since", "24h", "--limit", "21", "-o", "json"); err == nil {
		parseCrowdSecAlerts(output, &health.Alerts)
	}
	return health
}

type cappedBuffer struct {
	bytes.Buffer
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	const limit = 1024 * 1024
	remaining := limit - b.Len()
	if remaining <= 0 {
		return len(p), nil
	}
	if len(p) > remaining {
		_, _ = b.Buffer.Write(p[:remaining])
		return len(p), nil
	}
	return b.Buffer.Write(p)
}

func runCrowdSec(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "cscli", args...)
	var output cappedBuffer
	cmd.Stdout = &output
	cmd.Stderr = io.Discard
	err := cmd.Run()
	return output.Bytes(), err
}

func parseCrowdSecMetrics(data []byte, result *CrowdSecMetrics) {
	type acquisitionMetrics struct {
		Reads    int64 `json:"reads"`
		Parsed   int64 `json:"parsed"`
		Unparsed int64 `json:"unparsed"`
	}
	var root struct {
		Acquisition json.RawMessage `json:"acquisition"`
	}
	if json.Unmarshal(data, &root) != nil || len(root.Acquisition) == 0 {
		return
	}

	var acquisitions map[string]acquisitionMetrics
	if json.Unmarshal(root.Acquisition, &acquisitions) == nil {
		for source, metrics := range acquisitions {
			if strings.Contains(strings.ToLower(source), "traefik") {
				result.Available = true
				result.Reads += metrics.Reads
				result.Parsed += metrics.Parsed
				result.Unparsed += metrics.Unparsed
			}
		}
		return
	}

	// Older CrowdSec releases exposed acquisition metrics as table-like rows.
	var rows []struct {
		Source  string `json:"source"`
		Name    string `json:"name"`
		Metrics struct {
			Reads    int64 `json:"lines_read"`
			Parsed   int64 `json:"lines_parsed"`
			Unparsed int64 `json:"lines_unparsed"`
		} `json:"metrics"`
	}
	if json.Unmarshal(root.Acquisition, &rows) != nil {
		return
	}
	for _, acquisition := range rows {
		if strings.Contains(strings.ToLower(acquisition.Source+" "+acquisition.Name), "traefik") {
			result.Available = true
			result.Reads += acquisition.Metrics.Reads
			result.Parsed += acquisition.Metrics.Parsed
			result.Unparsed += acquisition.Metrics.Unparsed
		}
	}
}

func parseCrowdSecBouncer(data []byte, result *CrowdSecBouncer) bool {
	var bouncers []struct {
		Name     string  `json:"name"`
		Revoked  bool    `json:"revoked"`
		LastPull *string `json:"last_pull"`
	}
	if json.Unmarshal(data, &bouncers) != nil {
		return false
	}
	result.Available = true
	for _, bouncer := range bouncers {
		if bouncer.Name == "traefik-bouncer" {
			result.Registered = true
			result.Revoked = bouncer.Revoked
			if bouncer.LastPull != nil {
				result.LastPullAt = *bouncer.LastPull
			}
			break
		}
	}
	return true
}

func parseCrowdSecDecisions(data []byte, result *CrowdSecDecisionSnapshot) {
	var alerts []struct {
		Decisions []struct {
			Scope     string `json:"scope"`
			Value     string `json:"value"`
			Type      string `json:"type"`
			Scenario  string `json:"scenario"`
			Origin    string `json:"origin"`
			Until     string `json:"until"`
			ExpiresAt string `json:"expires_at"`
		} `json:"decisions"`
	}
	if json.Unmarshal(data, &alerts) != nil {
		return
	}
	result.Available = true
	result.Truncated = len(alerts) >= 51
	for _, alert := range alerts {
		for _, decision := range alert.Decisions {
			if len(result.Records) == 50 {
				result.Truncated = true
				return
			}
			expiresAt := decision.ExpiresAt
			if expiresAt == "" {
				expiresAt = decision.Until
			}
			result.Records = append(result.Records, CrowdSecDecision{Scope: decision.Scope, Value: decision.Value, Action: decision.Type, Reason: decision.Scenario, Origin: decision.Origin, ExpiresAt: expiresAt})
		}
	}
}

func parseCrowdSecAlerts(data []byte, result *CrowdSecAlertSnapshot) {
	var alerts []struct {
		ID          int64  `json:"id"`
		CreatedAt   string `json:"created_at"`
		Scenario    string `json:"scenario"`
		EventsCount int64  `json:"events_count"`
		Source      struct {
			IP      string `json:"ip"`
			Country string `json:"cn"`
		} `json:"source"`
	}
	if json.Unmarshal(data, &alerts) != nil {
		return
	}
	result.Available = true
	result.Truncated = len(alerts) > 20
	for _, alert := range alerts {
		if len(result.Records) == 20 {
			break
		}
		result.Records = append(result.Records, CrowdSecAlert{ID: alert.ID, DetectedAt: alert.CreatedAt, Scenario: alert.Scenario, SourceIP: alert.Source.IP, Country: alert.Source.Country, EventCount: alert.EventsCount})
	}
}
