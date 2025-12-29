package podman

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
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
		return fmt.Errorf("failed to stop container: %s: %w", string(output), err)
	}

	rmCmd := exec.Command("podman", "rm", containerID)
	if output, err := rmCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to remove container: %s: %w", string(output), err)
	}

	return nil
}


func IsRunning(containerID string) (bool, error) {
	cmd := exec.Command("podman", "inspect", "-f", "{{.State.Running}}", containerID)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return false, nil
	}

	return strings.TrimSpace(string(output)) == "true", nil
}

func GetHealthStatus(containerID string) string {
	cmd := exec.Command("podman", "inspect", "-f", "{{.State.Health.Status}}", containerID)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return ""
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
	ID      string `json:"Id"`
	Name    string `json:"Name"`
	Image   string `json:"Image"`
	State   string `json:"State"`
	Created int64  `json:"Created"`
}

type podmanContainer struct {
	Id      string   `json:"Id"`
	Names   []string `json:"Names"`
	Image   string   `json:"Image"`
	State   string   `json:"State"`
	Created int64    `json:"Created"`
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
			ID:      pc.Id,
			Name:    name,
			Image:   pc.Image,
			State:   pc.State,
			Created: pc.Created,
		}
	}

	return containers, nil
}
