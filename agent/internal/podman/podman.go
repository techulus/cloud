package podman

import (
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

	for _, pm := range config.PortMappings {
		portMapping := fmt.Sprintf("%s:%d:%d", config.WireGuardIP, pm.HostPort, pm.ContainerPort)
		args = append(args, "-p", portMapping)
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
