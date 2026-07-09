package container

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"unicode"
)

type ResourceStats struct {
	ContainerID          string
	ServiceID            string
	DeploymentID         string
	CPUUsagePercent      float64
	MemoryUsagePercent   float64
	MemoryUsedBytes      float64
	NetworkReceiveBytes  float64
	NetworkTransmitBytes float64
}

func CollectResourceStats() ([]ResourceStats, error) {
	containers, err := List()
	if err != nil {
		return nil, err
	}

	running := make([]Container, 0, len(containers))
	args := []string{"stats", "--no-stream", "--format", "json"}
	for _, c := range containers {
		if c.State != "running" || c.ServiceID == "" || c.DeploymentID == "" {
			continue
		}
		running = append(running, c)
		args = append(args, c.ID)
	}
	if len(running) == 0 {
		return nil, nil
	}

	cmd := exec.Command("podman", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to collect container stats: %s: %w", stderr.String(), err)
	}

	return parsePodmanStatsOutput(output, running)
}

func parsePodmanStatsOutput(output []byte, containers []Container) ([]ResourceStats, error) {
	rows, err := parseStatsRows(output)
	if err != nil {
		return nil, err
	}

	stats := make([]ResourceStats, 0, len(rows))
	for _, row := range rows {
		containerID := firstRowString(row, "ID", "Id", "id", "ContainerID", "Container")
		container := findStatsContainerByID(containerID, containers)
		if container == nil {
			name := firstRowString(row, "Name", "Names", "name")
			container = findStatsContainerByName(name, containers)
		}
		if container == nil {
			continue
		}

		rx, tx := parseNetIO(firstRowString(row, "NetIO", "NetIOBytes", "net_io"))
		stats = append(stats, ResourceStats{
			ContainerID:          container.ID,
			ServiceID:            container.ServiceID,
			DeploymentID:         container.DeploymentID,
			CPUUsagePercent:      parsePercent(firstRowString(row, "CPUPerc", "CPU", "cpu_percent")),
			MemoryUsagePercent:   parsePercent(firstRowString(row, "MemPerc", "MEMPerc", "mem_percent")),
			MemoryUsedBytes:      parseMemUsed(firstRowString(row, "MemUsage", "MemUse", "mem_usage")),
			NetworkReceiveBytes:  rx,
			NetworkTransmitBytes: tx,
		})
	}

	return stats, nil
}

func parseStatsRows(output []byte) ([]map[string]interface{}, error) {
	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" {
		return nil, nil
	}

	if strings.HasPrefix(trimmed, "[") {
		var rows []map[string]interface{}
		if err := json.Unmarshal([]byte(trimmed), &rows); err != nil {
			return nil, fmt.Errorf("failed to parse podman stats JSON array: %w", err)
		}
		return rows, nil
	}

	var rows []map[string]interface{}
	for _, line := range strings.Split(trimmed, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row map[string]interface{}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			return nil, fmt.Errorf("failed to parse podman stats JSON row: %w", err)
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func findStatsContainerByID(value string, containers []Container) *Container {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}

	for i := range containers {
		containerID := strings.TrimSpace(containers[i].ID)
		if value == containerID {
			return &containers[i]
		}
		if containerID != "" && (strings.HasPrefix(containerID, value) || strings.HasPrefix(value, containerID)) {
			return &containers[i]
		}
	}
	return nil
}

func findStatsContainerByName(value string, containers []Container) *Container {
	value = strings.TrimPrefix(strings.TrimSpace(value), "/")
	if value == "" {
		return nil
	}

	for i := range containers {
		containerName := strings.TrimPrefix(strings.TrimSpace(containers[i].Name), "/")
		if value == containerName {
			return &containers[i]
		}
	}
	return nil
}

func firstRowString(row map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		value, ok := row[key]
		if !ok || value == nil {
			continue
		}
		switch v := value.(type) {
		case string:
			return v
		case []interface{}:
			if len(v) > 0 {
				return fmt.Sprint(v[0])
			}
		default:
			return fmt.Sprint(v)
		}
	}
	return ""
}

func parsePercent(value string) float64 {
	value = strings.TrimSpace(strings.TrimSuffix(value, "%"))
	if value == "" || value == "--" {
		return 0
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || !isFinite(parsed) {
		return 0
	}
	return parsed
}

func parseMemUsed(value string) float64 {
	parts := strings.Split(value, "/")
	if len(parts) == 0 {
		return 0
	}
	return parseByteQuantity(parts[0])
}

func parseNetIO(value string) (float64, float64) {
	parts := strings.Split(value, "/")
	if len(parts) != 2 {
		return 0, 0
	}
	return parseByteQuantity(parts[0]), parseByteQuantity(parts[1])
}

func parseByteQuantity(value string) float64 {
	value = strings.TrimSpace(value)
	if value == "" || value == "--" {
		return 0
	}

	compact := strings.ReplaceAll(value, " ", "")
	splitAt := len(compact)
	for i, r := range compact {
		if !(unicode.IsDigit(r) || r == '.' || r == '-') {
			splitAt = i
			break
		}
	}

	numberText := compact[:splitAt]
	unit := strings.ToLower(compact[splitAt:])
	parsed, err := strconv.ParseFloat(numberText, 64)
	if err != nil || !isFinite(parsed) {
		return 0
	}

	switch unit {
	case "", "b":
		return parsed
	case "kb", "k", "kib", "ki":
		return parsed * unitMultiplier(unit, 1)
	case "mb", "m", "mib", "mi":
		return parsed * unitMultiplier(unit, 2)
	case "gb", "g", "gib", "gi":
		return parsed * unitMultiplier(unit, 3)
	case "tb", "t", "tib", "ti":
		return parsed * unitMultiplier(unit, 4)
	default:
		return parsed
	}
}

func unitMultiplier(unit string, power float64) float64 {
	base := 1000.0
	if strings.Contains(unit, "i") {
		base = 1024.0
	}
	return math.Pow(base, power)
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
