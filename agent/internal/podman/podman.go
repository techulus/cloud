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

type DeployConfig struct {
	Name         string
	Image        string
	WireGuardIP  string
	IPAddress    string
	PortMappings []PortMapping
}

type DeployResult struct {
	ContainerID string
}

func Deploy(config *DeployConfig) (*DeployResult, error) {
	image := config.Image
	pullCmd := exec.Command("podman", "pull", image)
	if output, err := pullCmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("failed to pull image: %s: %w", string(output), err)
	}

	args := []string{"run", "-d", "--name", config.Name, "--replace", "--restart", "unless-stopped"}

	if config.IPAddress != "" {
		args = append(args, "--network", NetworkName, "--ip", config.IPAddress)
	} else {
		for _, pm := range config.PortMappings {
			portMapping := fmt.Sprintf("%s:%d:%d", config.WireGuardIP, pm.HostPort, pm.ContainerPort)
			args = append(args, "-p", portMapping)
		}
	}

	args = append(args, image)

	runCmd := exec.Command("podman", args...)
	output, err := runCmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("failed to run container: %s: %w", string(output), err)
	}

	containerID := strings.TrimSpace(string(output))

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
