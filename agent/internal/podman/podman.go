package podman

import (
	"fmt"
	"os/exec"
	"strings"
)

type DeployConfig struct {
	Name        string
	Image       string
	Port        int
	WireGuardIP string
	HostPort    int
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

	portMapping := fmt.Sprintf("%s:%d:%d", config.WireGuardIP, config.HostPort, config.Port)
	containerName := fmt.Sprintf("%s-%d", config.Name, config.HostPort)

	runCmd := exec.Command("podman", "run",
		"-d",
		"--name", containerName,
		"-p", portMapping,
		"--restart", "unless-stopped",
		image,
	)

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
