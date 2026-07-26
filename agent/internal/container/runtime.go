package container

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"techulus/cloud-agent/internal/retry"
)

const (
	pullTimeout      = 10 * time.Minute
	operationTimeout = 30 * time.Second
	registryTimeout  = time.Minute
)

// ResolvedImage is an immutable local Podman image identity.
type ResolvedImage string

func commandError(ctx context.Context, stage string, output []byte, err error) error {
	if ctx.Err() != nil {
		return fmt.Errorf("%s timed out or was canceled: %s: %w", stage, string(output), ctx.Err())
	}
	return fmt.Errorf("%s failed: %s: %w", stage, string(output), err)
}

func PullImage(ctx context.Context, reference string) (ResolvedImage, error) {
	pullCtx, cancel := context.WithTimeout(ctx, pullTimeout)
	defer cancel()
	output, err := exec.CommandContext(pullCtx, "podman", "pull", "--tls-verify=false", reference).CombinedOutput()
	if err != nil {
		return "", commandError(pullCtx, "image pull", output, err)
	}

	inspectCtx, inspectCancel := context.WithTimeout(ctx, operationTimeout)
	defer inspectCancel()
	output, err = exec.CommandContext(inspectCtx, "podman", "image", "inspect", "--format", "{{.Id}}", reference).CombinedOutput()
	if err != nil {
		return "", commandError(inspectCtx, "pulled image identity inspection", output, err)
	}
	identity := ResolvedImage(strings.TrimSpace(string(output)))
	if identity == "" {
		return "", fmt.Errorf("pulled image identity inspection returned an empty image ID for %q", reference)
	}
	return identity, nil
}

func ContainerExists(containerID string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), operationTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "podman", "inspect", "--format", "json", containerID)
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
	ctx, cancel := context.WithTimeout(context.Background(), operationTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "podman", "inspect", "--format", "json", containerID)
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

func Deploy(ctx context.Context, config *DeployConfig, image ResolvedImage) (*DeployResult, error) {
	logFunc := config.LogFunc
	if logFunc == nil {
		logFunc = func(stream string, message string) {}
	}

	if image == "" {
		return nil, fmt.Errorf("resolved image identity is required")
	}

	for _, vm := range config.VolumeMounts {
		if err := os.MkdirAll(vm.HostPath, 0755); err != nil {
			logFunc("stderr", fmt.Sprintf("Failed to create volume directory %s: %s", vm.HostPath, err))
			return nil, fmt.Errorf("failed to create volume directory %s: %w", vm.HostPath, err)
		}
		logFunc("stdout", fmt.Sprintf("Created volume directory: %s", vm.HostPath))
	}

	args := buildPodmanRunArgs(config, string(image))
	removeCtx, removeCancel := context.WithTimeout(ctx, operationTimeout)
	exec.CommandContext(removeCtx, "podman", "rm", "-f", config.Name).Run()
	removeCancel()

	logFunc("stdout", fmt.Sprintf("Starting container: %s", config.Name))

	runCtx, runCancel := context.WithTimeout(ctx, operationTimeout)
	defer runCancel()
	runCmd := exec.CommandContext(runCtx, "podman", args...)
	output, err := runCmd.CombinedOutput()
	if err != nil {
		logFunc("stderr", fmt.Sprintf("Start failed: %s", string(output)))
		return nil, commandError(runCtx, "container run", output, err)
	}

	containerID := strings.TrimSpace(string(output))
	logFunc("stdout", fmt.Sprintf("Container started: %s", containerID))

	verifyCtx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()

	logFunc("stdout", "Verifying container is running...")
	err = retry.WithBackoff(verifyCtx, retry.DeployBackoff, func() (bool, error) {
		running, err := IsContainerRunning(containerID)
		if err != nil {
			return false, err
		}
		return running, nil
	})

	if err != nil {
		logsCtx, logsCancel := context.WithTimeout(ctx, operationTimeout)
		defer logsCancel()
		logsCmd := exec.CommandContext(logsCtx, "podman", "logs", "--tail", "50", containerID)
		logsOutput, _ := logsCmd.CombinedOutput()
		logFunc("stderr", fmt.Sprintf("Container failed to stay running. Logs:\n%s", string(logsOutput)))
		return nil, fmt.Errorf("container failed to stay running after start: %w", err)
	}

	logFunc("stdout", "Container verified running")

	return &DeployResult{
		ContainerID: containerID,
	}, nil
}

func buildPodmanRunArgs(config *DeployConfig, image string) []string {
	networkMAC := StableMACAddress(config.IPAddress)

	args := []string{
		"run", "-d",
		"--name", config.Name,
		"--replace",
		"--restart", "on-failure:5",
		"--cap-drop", "ALL",
		"--cap-add", "CHOWN",
		"--cap-add", "DAC_OVERRIDE",
		"--cap-add", "FOWNER",
		"--cap-add", "SETPCAP",
		"--cap-add", "SETUID",
		"--cap-add", "SETGID",
		"--cap-add", "NET_BIND_SERVICE",
		"--cap-add", "NET_RAW",
		"--log-opt", "max-size=10m",
		"--log-opt", "max-file=3",
	}

	args = append(args,
		"--label", fmt.Sprintf("techulus.service.id=%s", config.ServiceID),
		"--label", fmt.Sprintf("techulus.service.name=%s", config.ServiceName),
		"--label", fmt.Sprintf("techulus.deployment.id=%s", config.DeploymentID),
	)
	if config.IPAddress != "" {
		args = append(args, "--network", NetworkName, "--ip", config.IPAddress)
		if networkMAC != "" {
			args = append(args, "--mac-address", networkMAC)
		}
		if config.PublishLocalPorts {
			for _, pm := range config.PortMappings {
				portMapping := fmt.Sprintf("127.0.0.1:%d:%d", pm.HostPort, pm.ContainerPort)
				args = append(args, "-p", portMapping)
			}
		}
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

	if config.MemoryLimitMb != nil && *config.MemoryLimitMb > 0 {
		args = append(args, "--memory", fmt.Sprintf("%dm", *config.MemoryLimitMb))
	}
	if config.CPULimit != nil && *config.CPULimit > 0 {
		args = append(args, "--cpus", fmt.Sprintf("%.2f", *config.CPULimit))
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
	return args
}

func Stop(containerID string) error {
	exists, err := ContainerExists(containerID)
	if err != nil {
		return fmt.Errorf("failed to check container existence: %w", err)
	}
	if !exists {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	log.Printf("[podman:stop] stopping container %s", containerID)
	stopCmd := exec.CommandContext(ctx, "podman", "stop", containerID)
	if output, err := stopCmd.CombinedOutput(); err != nil {
		outputStr := string(output)
		if strings.Contains(outputStr, "no such container") ||
			strings.Contains(outputStr, "no container with name or ID") ||
			strings.Contains(outputStr, "no such object") {
			return nil
		}
		return commandError(ctx, "container stop", output, err)
	}

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
		cmd := exec.CommandContext(ctx, "podman", "rm", "-f", containerID)
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
	return startOrRestart(containerID, "restart")
}

func Start(containerID string) error {
	return startOrRestart(containerID, "start")
}

func startOrRestart(containerID, operation string) error {
	exists, err := ContainerExists(containerID)
	if err != nil {
		return fmt.Errorf("failed to check container existence: %w", err)
	}
	if !exists {
		return fmt.Errorf("container does not exist: %s", containerID)
	}

	log.Printf("[podman:%s] %sing container %s", operation, operation, containerID)
	ctx, cancel := context.WithTimeout(context.Background(), operationTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "podman", operation, containerID)
	if output, err := cmd.CombinedOutput(); err != nil {
		return commandError(ctx, "container "+operation, output, err)
	}

	log.Printf("[podman:%s] verifying container %s is running", operation, containerID)
	err = retry.WithBackoff(ctx, retry.DeployBackoff, func() (bool, error) {
		running, err := IsContainerRunning(containerID)
		if err != nil {
			return false, err
		}
		return running, nil
	})

	if err != nil {
		return fmt.Errorf("container failed to %s: %w", operation, err)
	}

	log.Printf("[podman:%s] container %s %sed successfully", operation, containerID, operation)
	return nil
}

func GetHealthStatus(containerID string) string {
	return GetHealthStatusContext(context.Background(), containerID)
}

func GetHealthStatusContext(ctx context.Context, containerID string) string {
	cmd := exec.CommandContext(ctx, "podman", "inspect", "-f", "{{.State.Health.Status}}", containerID)
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

func Login(registryURL, username, password string, insecure bool) error {
	if registryURL == "" || username == "" {
		return nil
	}

	log.Printf("[podman:login] logging in to registry %s", registryURL)

	args := []string{"login"}
	if insecure {
		args = append(args, "--tls-verify=false")
	}
	args = append(args, "-u", username, "-p", password, registryURL)

	ctx, cancel := context.WithTimeout(context.Background(), registryTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "podman", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return commandError(ctx, "podman registry login", output, err)
	}

	log.Printf("[podman:login] successfully logged in to registry %s", registryURL)

	if err := writeDockerConfig(registryURL, username, password); err != nil {
		log.Printf("[registry] failed to write docker config: %v", err)
	}

	registryHost := strings.TrimPrefix(registryURL, "https://")
	registryHost = strings.TrimPrefix(registryHost, "http://")
	registryHost = strings.TrimSuffix(registryHost, "/")

	craneArgs := []string{"auth", "login", "-u", username, "-p", password, registryHost}
	craneCtx, craneCancel := context.WithTimeout(context.Background(), registryTimeout)
	defer craneCancel()
	craneCmd := exec.CommandContext(craneCtx, "/usr/local/bin/crane", craneArgs...)
	if out, err := craneCmd.CombinedOutput(); err != nil {
		log.Printf("[crane:login] failed: %s: %v", string(out), err)
	} else {
		log.Printf("[crane:login] successfully logged in to %s", registryHost)
	}

	return nil
}

func writeDockerConfig(registryURL, username, password string) error {
	registryHost := strings.TrimPrefix(registryURL, "https://")
	registryHost = strings.TrimPrefix(registryHost, "http://")
	registryHost = strings.TrimSuffix(registryHost, "/")

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	dockerDir := filepath.Join(homeDir, ".docker")
	if err := os.MkdirAll(dockerDir, 0700); err != nil {
		return err
	}

	auth := base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
	config := map[string]interface{}{
		"auths": map[string]interface{}{
			registryHost: map[string]string{
				"auth": auth,
			},
		},
	}

	configBytes, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	configPath := filepath.Join(dockerDir, "config.json")
	if err := os.WriteFile(configPath, configBytes, 0600); err != nil {
		return err
	}

	log.Printf("[registry] wrote docker config to %s", configPath)
	return nil
}

func ImagePrune() error {
	cmd := exec.Command("podman", "image", "prune", "-a", "-f", "--filter", "until=168h")
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to prune images: %s: %w", string(output), err)
	}
	return nil
}

type podmanContainer struct {
	Id      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	ImageID string            `json:"ImageID"`
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
			ImageID:      pc.ImageID,
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

	// Podman only creates the bridge interface when a container uses the network.
	// Run a throwaway container to force bridge creation so DNS can bind to the gateway IP.
	runCtx, runCancel := context.WithTimeout(context.Background(), operationTimeout)
	defer runCancel()
	exec.CommandContext(runCtx, "podman", "run", "--rm", "--network", NetworkName, "busybox", "true").Run()

	return nil
}
