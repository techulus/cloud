package podman

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

type PortMapping struct {
	ContainerPort int
	HostPort      int
}

type HealthCheck struct {
	Cmd         string
	Interval    int
	Timeout     int
	Retries     int
	StartPeriod int
}

type VolumeMount struct {
	Name          string
	HostPath      string
	ContainerPath string
}

type BuildLogFunc func(stream string, message string)

type DeployConfig struct {
	Name         string
	Image        string
	ServiceID    string
	ServiceName  string
	DeploymentID string
	WireGuardIP  string
	IPAddress    string
	PortMappings []PortMapping
	HealthCheck  *HealthCheck
	Env          map[string]string
	VolumeMounts []VolumeMount
	LogFunc      BuildLogFunc
}

type DeployResult struct {
	ContainerID string
}

func RemoveServiceContainers(serviceID string) error {
	if serviceID == "" {
		return nil
	}

	cmd := exec.Command("podman", "ps", "-a", "--filter", fmt.Sprintf("label=techulus.service.id=%s", serviceID), "--format", "{{.ID}}")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil
	}

	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line == "" {
			continue
		}
		exec.Command("podman", "rm", "-f", line).Run()
	}

	return nil
}

func Deploy(config *DeployConfig) (*DeployResult, error) {
	logFunc := config.LogFunc
	if logFunc == nil {
		logFunc = func(stream string, message string) {}
	}

	image := config.Image

	exec.Command("podman", "rm", "-f", config.Name).Run()
	RemoveServiceContainers(config.ServiceID)

	logFunc("stdout", fmt.Sprintf("Pulling image: %s", image))

	pullCmd := exec.Command("podman", "pull", image)
	pullOutput, err := pullCmd.CombinedOutput()
	if err != nil {
		logFunc("stderr", fmt.Sprintf("Pull failed: %s", string(pullOutput)))
		return nil, fmt.Errorf("failed to pull image: %s: %w", string(pullOutput), err)
	}
	logFunc("stdout", string(pullOutput))

	for _, vm := range config.VolumeMounts {
		if err := os.MkdirAll(vm.HostPath, 0755); err != nil {
			logFunc("stderr", fmt.Sprintf("Failed to create volume directory %s: %s", vm.HostPath, err))
			return nil, fmt.Errorf("failed to create volume directory %s: %w", vm.HostPath, err)
		}
		logFunc("stdout", fmt.Sprintf("Created volume directory: %s", vm.HostPath))
	}

	args := []string{
		"run", "-d",
		"--name", config.Name,
		"--replace",
		"--restart", "unless-stopped",
		"--label", fmt.Sprintf("techulus.service.id=%s", config.ServiceID),
		"--label", fmt.Sprintf("techulus.service.name=%s", config.ServiceName),
		"--label", fmt.Sprintf("techulus.deployment.id=%s", config.DeploymentID),
	}

	if config.IPAddress != "" {
		args = append(args, "--network", NetworkName, "--ip", config.IPAddress)
	} else {
		for _, pm := range config.PortMappings {
			portMapping := fmt.Sprintf("%s:%d:%d", config.WireGuardIP, pm.HostPort, pm.ContainerPort)
			args = append(args, "-p", portMapping)
		}
	}

	if config.HealthCheck != nil && config.HealthCheck.Cmd != "" {
		args = append(args, "--health-cmd", config.HealthCheck.Cmd)
		args = append(args, "--health-interval", fmt.Sprintf("%ds", config.HealthCheck.Interval))
		args = append(args, "--health-timeout", fmt.Sprintf("%ds", config.HealthCheck.Timeout))
		args = append(args, "--health-retries", fmt.Sprintf("%d", config.HealthCheck.Retries))
		args = append(args, "--health-start-period", fmt.Sprintf("%ds", config.HealthCheck.StartPeriod))
	}

	for _, vm := range config.VolumeMounts {
		args = append(args, "-v", fmt.Sprintf("%s:%s", vm.HostPath, vm.ContainerPath))
	}

	for key, value := range config.Env {
		args = append(args, "-e", fmt.Sprintf("%s=%s", key, value))
	}

	args = append(args, image)

	logFunc("stdout", fmt.Sprintf("Starting container: %s", config.Name))

	runCmd := exec.Command("podman", args...)
	output, err := runCmd.CombinedOutput()
	if err != nil {
		logFunc("stderr", fmt.Sprintf("Start failed: %s", string(output)))
		return nil, fmt.Errorf("failed to run container: %s: %w", string(output), err)
	}

	containerID := strings.TrimSpace(string(output))
	logFunc("stdout", fmt.Sprintf("Container started: %s", containerID))

	return &DeployResult{
		ContainerID: containerID,
	}, nil
}

func Stop(containerID string) error {
	stopCmd := exec.Command("podman", "stop", containerID)
	if output, err := stopCmd.CombinedOutput(); err != nil {
		outputStr := string(output)
		if strings.Contains(outputStr, "no such container") ||
			strings.Contains(outputStr, "no container with name or ID") {
			return nil
		}
		return fmt.Errorf("failed to stop container: %s: %w", outputStr, err)
	}

	rmCmd := exec.Command("podman", "rm", containerID)
	if output, err := rmCmd.CombinedOutput(); err != nil {
		outputStr := string(output)
		if strings.Contains(outputStr, "no such container") ||
			strings.Contains(outputStr, "no container with name or ID") {
			return nil
		}
		return fmt.Errorf("failed to remove container: %s: %w", outputStr, err)
	}

	return nil
}

func ForceRemove(containerID string) error {
	var lastErr error

	for attempt := 1; attempt <= 3; attempt++ {
		cmd := exec.Command("podman", "rm", "-f", containerID)
		output, err := cmd.CombinedOutput()
		outputStr := string(output)

		if err == nil {
			return nil
		}

		if strings.Contains(outputStr, "no such container") ||
			strings.Contains(outputStr, "no container with name or ID") {
			return nil
		}

		lastErr = fmt.Errorf("attempt %d: %s: %w", attempt, outputStr, err)

		if attempt < 3 {
			time.Sleep(500 * time.Millisecond)
		}
	}

	return fmt.Errorf("failed to force remove container after 3 attempts: %w", lastErr)
}

func GetHealthStatus(containerID string) string {
	cmd := exec.Command("podman", "inspect", "-f", "{{.State.Health.Status}}", containerID)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "none"
	}
	status := strings.TrimSpace(string(output))
	if status == "<no value>" || status == "" {
		return "none"
	}
	return status
}

func CheckPrerequisites() error {
	if _, err := exec.LookPath("podman"); err != nil {
		return fmt.Errorf("podman not found: %w", err)
	}
	return nil
}

type Container struct {
	ID           string            `json:"Id"`
	Name         string            `json:"Name"`
	Image        string            `json:"Image"`
	State        string            `json:"State"`
	Created      int64             `json:"Created"`
	Labels       map[string]string `json:"Labels"`
	DeploymentID string
	ServiceID    string
}

type podmanContainer struct {
	Id      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	State   string            `json:"State"`
	Created int64             `json:"Created"`
	Labels  map[string]string `json:"Labels"`
}

func ListContainers() ([]Container, error) {
	cmd := exec.Command("podman", "ps", "-a", "--format", "json")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("failed to list containers: %s: %w", string(output), err)
	}

	var podmanContainers []podmanContainer
	if err := json.Unmarshal(output, &podmanContainers); err != nil {
		return nil, fmt.Errorf("failed to parse container list: %w", err)
	}

	containers := make([]Container, len(podmanContainers))
	for i, pc := range podmanContainers {
		name := ""
		if len(pc.Names) > 0 {
			name = pc.Names[0]
		}
		containers[i] = Container{
			ID:           pc.Id,
			Name:         name,
			Image:        pc.Image,
			State:        pc.State,
			Created:      pc.Created,
			Labels:       pc.Labels,
			DeploymentID: pc.Labels["techulus.deployment.id"],
			ServiceID:    pc.Labels["techulus.service.id"],
		}
	}

	return containers, nil
}
