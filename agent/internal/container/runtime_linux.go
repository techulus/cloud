//go:build linux

package container

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"techulus/cloud-agent/internal/dns"
	"techulus/cloud-agent/internal/retry"
)

func ContainerExists(containerID string) (bool, error) {
	cmd := exec.Command("podman", "inspect", "--format", "json", containerID)
	output, err := cmd.CombinedOutput()
	if err != nil {
		outputStr := string(output)
		if strings.Contains(outputStr, "no such container") ||
			strings.Contains(outputStr, "no container with name or ID") ||
			strings.Contains(outputStr, "no such object") {
			return false, nil
		}
		return false, fmt.Errorf("failed to inspect container: %s: %w", outputStr, err)
	}
	return true, nil
}

func IsContainerRunning(containerID string) (bool, error) {
	cmd := exec.Command("podman", "inspect", "--format", "json", containerID)
	output, err := cmd.CombinedOutput()
	if err != nil {
		outputStr := string(output)
		if strings.Contains(outputStr, "no such container") ||
			strings.Contains(outputStr, "no container with name or ID") ||
			strings.Contains(outputStr, "no such object") {
			return false, nil
		}
		return false, fmt.Errorf("failed to inspect container: %s: %w", outputStr, err)
	}

	var containers []containerInspect
	if err := json.Unmarshal(output, &containers); err != nil {
		return false, fmt.Errorf("failed to parse container inspect: %w", err)
	}

	if len(containers) == 0 {
		return false, nil
	}

	return containers[0].State.Running, nil
}

func IsContainerStopped(containerID string) (bool, error) {
	running, err := IsContainerRunning(containerID)
	if err != nil {
		return false, err
	}
	return !running, nil
}

func Deploy(config *DeployConfig) (*DeployResult, error) {
	logFunc := config.LogFunc
	if logFunc == nil {
		logFunc = func(stream string, message string) {}
	}

	image := config.Image

	exec.Command("podman", "rm", "-f", config.Name).Run()

	logFunc("stdout", fmt.Sprintf("Pulling image: %s", image))

	pullCmd := exec.Command("podman", "pull", "--tls-verify=false", image)
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
		"--restart", "on-failure:5",
		"--cap-drop", "ALL",
		"--cap-add", "CHOWN",
		"--cap-add", "DAC_OVERRIDE",
		"--cap-add", "FOWNER",
		"--cap-add", "SETUID",
		"--cap-add", "SETGID",
		"--cap-add", "NET_BIND_SERVICE",
		"--cap-add", "NET_RAW",
	}

	args = append(args,
		"--label", fmt.Sprintf("techulus.service.id=%s", config.ServiceID),
		"--label", fmt.Sprintf("techulus.service.name=%s", config.ServiceName),
		"--label", fmt.Sprintf("techulus.deployment.id=%s", config.DeploymentID),
	)

	if config.IPAddress != "" {
		args = append(args, "--network", NetworkName, "--ip", config.IPAddress)
	} else {
		for _, pm := range config.PortMappings {
			portMapping := fmt.Sprintf("%s:%d:%d", config.WireGuardIP, pm.HostPort, pm.ContainerPort)
			args = append(args, "-p", portMapping)
		}
	}

	if dnsIP := dns.GetContainerDNS(); dnsIP != "" {
		args = append(args, "--dns", dnsIP)
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

	if config.StartCommand != "" {
		args = append(args, "--entrypoint", "/bin/sh")
		args = append(args, image)
		args = append(args, "-c", config.StartCommand)
	} else {
		args = append(args, image)
	}

	logFunc("stdout", fmt.Sprintf("Starting container: %s", config.Name))

	runCmd := exec.Command("podman", args...)
	output, err := runCmd.CombinedOutput()
	if err != nil {
		logFunc("stderr", fmt.Sprintf("Start failed: %s", string(output)))
		return nil, fmt.Errorf("failed to run container: %s: %w", string(output), err)
	}

	containerID := strings.TrimSpace(string(output))
	logFunc("stdout", fmt.Sprintf("Container started: %s", containerID))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	logFunc("stdout", "Verifying container is running...")
	err = retry.WithBackoff(ctx, retry.DeployBackoff, func() (bool, error) {
		running, err := IsContainerRunning(containerID)
		if err != nil {
			return false, err
		}
		return running, nil
	})

	if err != nil {
		logsCmd := exec.Command("podman", "logs", "--tail", "50", containerID)
		logsOutput, _ := logsCmd.CombinedOutput()
		logFunc("stderr", fmt.Sprintf("Container failed to stay running. Logs:\n%s", string(logsOutput)))
		return nil, fmt.Errorf("container failed to stay running after start: %w", err)
	}

	logFunc("stdout", "Container verified running")

	return &DeployResult{
		ContainerID: containerID,
	}, nil
}

func Stop(containerID string) error {
	exists, err := ContainerExists(containerID)
	if err != nil {
		return fmt.Errorf("failed to check container existence: %w", err)
	}
	if !exists {
		return nil
	}

	log.Printf("[podman:stop] stopping container %s", containerID)
	stopCmd := exec.Command("podman", "stop", containerID)
	if output, err := stopCmd.CombinedOutput(); err != nil {
		outputStr := string(output)
		if strings.Contains(outputStr, "no such container") ||
			strings.Contains(outputStr, "no container with name or ID") ||
			strings.Contains(outputStr, "no such object") {
			return nil
		}
		return fmt.Errorf("failed to stop container: %s: %w", outputStr, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	log.Printf("[podman:stop] verifying container %s stopped", containerID)
	err = retry.WithBackoff(ctx, retry.StopBackoff, func() (bool, error) {
		stopped, err := IsContainerStopped(containerID)
		if err != nil {
			return false, err
		}
		return stopped, nil
	})

	if err != nil {
		return fmt.Errorf("container did not stop after verification: %w", err)
	}

	log.Printf("[podman:stop] container %s stopped successfully", containerID)
	return nil
}

func ForceRemove(containerID string) error {
	exists, err := ContainerExists(containerID)
	if err != nil {
		return fmt.Errorf("failed to check container existence: %w", err)
	}
	if !exists {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	log.Printf("[podman:force-remove] force removing container %s", containerID)

	var lastErr error
	err = retry.WithBackoff(ctx, retry.ForceRemoveBackoff, func() (bool, error) {
		cmd := exec.Command("podman", "rm", "-f", containerID)
		output, err := cmd.CombinedOutput()
		outputStr := string(output)

		if err == nil {
			exists, checkErr := ContainerExists(containerID)
			if checkErr != nil {
				lastErr = checkErr
				return false, checkErr
			}
			if !exists {
				return true, nil
			}
			lastErr = fmt.Errorf("container still exists after rm -f")
			return false, nil
		}

		if strings.Contains(outputStr, "no such container") ||
			strings.Contains(outputStr, "no container with name or ID") ||
			strings.Contains(outputStr, "no such object") {
			return true, nil
		}

		lastErr = fmt.Errorf("%s: %w", outputStr, err)
		return false, nil
	})

	if err != nil {
		if lastErr != nil {
			return fmt.Errorf("failed to force remove container: %w", lastErr)
		}
		return fmt.Errorf("failed to force remove container: %w", err)
	}

	log.Printf("[podman:force-remove] container %s removed successfully", containerID)
	return nil
}

func Restart(containerID string) error {
	exists, err := ContainerExists(containerID)
	if err != nil {
		return fmt.Errorf("failed to check container existence: %w", err)
	}
	if !exists {
		return fmt.Errorf("container does not exist: %s", containerID)
	}

	log.Printf("[podman:restart] restarting container %s", containerID)
	restartCmd := exec.Command("podman", "restart", containerID)
	if output, err := restartCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to restart container: %s: %w", string(output), err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	log.Printf("[podman:restart] verifying container %s is running", containerID)
	err = retry.WithBackoff(ctx, retry.DeployBackoff, func() (bool, error) {
		running, err := IsContainerRunning(containerID)
		if err != nil {
			return false, err
		}
		return running, nil
	})

	if err != nil {
		return fmt.Errorf("container failed to restart: %w", err)
	}

	log.Printf("[podman:restart] container %s restarted successfully", containerID)
	return nil
}

func Start(containerID string) error {
	exists, err := ContainerExists(containerID)
	if err != nil {
		return fmt.Errorf("failed to check container existence: %w", err)
	}
	if !exists {
		return fmt.Errorf("container does not exist: %s", containerID)
	}

	log.Printf("[podman:start] starting container %s", containerID)
	startCmd := exec.Command("podman", "start", containerID)
	if output, err := startCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to start container: %s: %w", string(output), err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	log.Printf("[podman:start] verifying container %s is running", containerID)
	err = retry.WithBackoff(ctx, retry.DeployBackoff, func() (bool, error) {
		running, err := IsContainerRunning(containerID)
		if err != nil {
			return false, err
		}
		return running, nil
	})

	if err != nil {
		return fmt.Errorf("container failed to start: %w", err)
	}

	log.Printf("[podman:start] container %s started successfully", containerID)
	return nil
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

func ImagePrune() {
	exec.Command("podman", "image", "prune", "-f").Run()
}

type podmanContainer struct {
	Id      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	State   string            `json:"State"`
	Created int64             `json:"Created"`
	Labels  map[string]string `json:"Labels"`
}

func List() ([]Container, error) {
	cmd := exec.Command("podman", "ps", "-a", "--filter", "label=techulus.service.id", "--format", "json")
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

func EnsureNetwork(subnetId int) error {
	subnet := fmt.Sprintf("10.200.%d.0/24", subnetId)
	gateway := fmt.Sprintf("10.200.%d.1", subnetId)

	checkCmd := exec.Command("podman", "network", "inspect", NetworkName)
	if err := checkCmd.Run(); err == nil {
		return nil
	}

	args := []string{
		"network", "create",
		"--driver", "bridge",
		"--subnet", subnet,
		"--gateway", gateway,
		"--disable-dns",
		NetworkName,
	}

	createCmd := exec.Command("podman", args...)
	output, err := createCmd.CombinedOutput()
	if err != nil {
		if strings.Contains(string(output), "already exists") {
			return nil
		}
		return fmt.Errorf("failed to create network: %s: %w", string(output), err)
	}

	return nil
}
