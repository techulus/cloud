package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"techulus/cloud-agent/internal/build"
	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/crypto"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/paths"
	"techulus/cloud-agent/internal/retry"
)

const terminalBuildStatusTimeout = 2 * time.Minute

func (a *Agent) ProcessRestart(item agenthttp.WorkQueueItem) error {
	var payload struct {
		DeploymentID string `json:"deploymentId"`
		ContainerID  string `json:"containerId"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse restart payload: %w", err)
	}

	log.Printf("[restart] restarting container %s for deployment %s", Truncate(payload.ContainerID, 12), Truncate(payload.DeploymentID, 8))

	if err := a.withDeploymentOperationLock(payload.DeploymentID, func() error { return container.Restart(payload.ContainerID) }); err != nil {
		return fmt.Errorf("failed to restart container: %w", err)
	}

	return nil
}

func (a *Agent) ProcessStop(item agenthttp.WorkQueueItem) error {
	var payload struct {
		DeploymentID string `json:"deploymentId"`
		ContainerID  string `json:"containerId"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse stop payload: %w", err)
	}

	log.Printf("[stop] stopping container %s for deployment %s", Truncate(payload.ContainerID, 12), Truncate(payload.DeploymentID, 8))

	if err := a.withDeploymentOperationLock(payload.DeploymentID, func() error { return container.Stop(payload.ContainerID) }); err != nil {
		return fmt.Errorf("failed to stop container: %w", err)
	}

	return nil
}

func (a *Agent) ProcessForceCleanup(item agenthttp.WorkQueueItem) error {
	var payload struct {
		ServiceID    string   `json:"serviceId"`
		ContainerIDs []string `json:"containerIds"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse force_cleanup payload: %w", err)
	}

	log.Printf("[force_cleanup] cleaning up %d containers for service %s", len(payload.ContainerIDs), Truncate(payload.ServiceID, 8))

	deploymentByContainer := map[string]string{}
	if containers, err := container.List(); err == nil {
		for _, current := range containers {
			deploymentByContainer[current.ID] = current.DeploymentID
		}
	}
	var cleanupErrors []error
	for _, containerID := range payload.ContainerIDs {
		err := a.withDeploymentOperationLock(deploymentByContainer[containerID], func() error {
			stopErr := container.Stop(containerID)
			removeErr := container.ForceRemove(containerID)
			return errors.Join(stopErr, removeErr)
		})
		if err != nil {
			log.Printf("[force_cleanup] failed to clean %s: %v", Truncate(containerID, 12), err)
			cleanupErrors = append(cleanupErrors, fmt.Errorf("clean %s: %w", Truncate(containerID, 12), err))
		}
	}

	return errors.Join(cleanupErrors...)
}

func (a *Agent) ProcessCleanupVolumes(item agenthttp.WorkQueueItem) error {
	var payload struct {
		ServiceID string `json:"serviceId"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse cleanup_volumes payload: %w", err)
	}

	volumePath := filepath.Join(a.DataDir, "volumes", payload.ServiceID)
	log.Printf("[cleanup_volumes] removing volumes at %s", volumePath)

	if err := os.RemoveAll(volumePath); err != nil {
		return fmt.Errorf("failed to remove volume directory: %w", err)
	}

	return nil
}

func (a *Agent) ProcessBuild(item agenthttp.WorkQueueItem) error {
	if a.Builder == nil {
		return fmt.Errorf("builder not configured")
	}

	var payload struct {
		BuildID string `json:"buildId"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse build payload: %w", err)
	}

	a.buildMutex.Lock()
	if a.isBuilding {
		a.buildMutex.Unlock()
		return fmt.Errorf("another build is in progress")
	}
	a.isBuilding = true
	a.currentBuildID = payload.BuildID
	a.buildMutex.Unlock()

	defer func() {
		a.buildMutex.Lock()
		a.isBuilding = false
		a.currentBuildID = ""
		a.buildMutex.Unlock()
	}()

	buildDetails, err := a.Client.ClaimBuild(payload.BuildID, item.Attempt)
	if err != nil {
		return fmt.Errorf("failed to claim build: %w", err)
	}

	timeoutMinutes := buildDetails.TimeoutMinutes
	if timeoutMinutes <= 0 {
		timeoutMinutes = 30
	}
	log.Printf("[build] starting build %s for commit %s (timeout: %d minutes)", Truncate(payload.BuildID, 8), Truncate(buildDetails.Build.CommitSha, 8), timeoutMinutes)

	if err := a.Client.UpdateBuildStatus(payload.BuildID, item.Attempt, "cloning", "", "", nil); err != nil {
		log.Printf("[build] failed to update status to cloning: %v", err)
	}

	checkCancelled := func() bool {
		status, err := a.Client.GetBuildStatus(payload.BuildID, item.Attempt)
		if err != nil {
			return false
		}
		return status == "cancelled"
	}

	decryptedSecrets := make(map[string]string)
	for key, encryptedValue := range buildDetails.Secrets {
		decrypted, err := crypto.DecryptSecret(encryptedValue, a.Config.EncryptionKey)
		if err != nil {
			log.Printf("[build] failed to decrypt secret %s: %v", key, err)
			continue
		}
		decryptedSecrets[key] = decrypted
	}

	buildConfig := &build.Config{
		BuildID:         payload.BuildID,
		CloneURL:        buildDetails.CloneURL,
		CommitSha:       buildDetails.Build.CommitSha,
		Branch:          buildDetails.Build.Branch,
		ImageRepository: buildDetails.ImageRepository,
		ImageURI:        buildDetails.ImageURI,
		ServiceID:       buildDetails.Build.ServiceID,
		ProjectID:       buildDetails.Build.ProjectID,
		RootDir:         buildDetails.RootDir,
		Secrets:         decryptedSecrets,
		TargetPlatforms: buildDetails.TargetPlatforms,
	}

	onStatusChange := func(status string) {
		if err := a.Client.UpdateBuildStatus(payload.BuildID, item.Attempt, status, "", buildConfig.ResolvedCommitSha, buildConfig.Timings); err != nil {
			log.Printf("[build] failed to update status to %s: %v", status, err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMinutes)*time.Minute)
	defer cancel()
	err = a.Builder.Build(ctx, buildConfig, checkCancelled, onStatusChange)
	if err != nil {
		log.Printf("[build] build %s failed: %v", Truncate(payload.BuildID, 8), err)
		if reportErr := a.reportTerminalBuildStatus(payload.BuildID, item.Attempt, "failed", err.Error(), buildConfig.ResolvedCommitSha, buildConfig.Timings); reportErr != nil {
			return errors.Join(err, fmt.Errorf("failed to report build failure: %w", reportErr))
		}
		return err
	}

	log.Printf("[build] build %s completed successfully", Truncate(payload.BuildID, 8))
	if err := a.reportTerminalBuildStatus(payload.BuildID, item.Attempt, "completed", "", buildConfig.ResolvedCommitSha, buildConfig.Timings); err != nil {
		return fmt.Errorf("failed to report build completion: %w", err)
	}

	return nil
}

func (a *Agent) reportTerminalBuildStatus(buildID string, attempt int, status, errorMsg, resolvedCommitSha string, timings any) error {
	ctx, cancel := context.WithTimeout(context.Background(), terminalBuildStatusTimeout)
	defer cancel()

	return retry.WithBackoff(ctx, retry.StopBackoff, func() (bool, error) {
		err := a.Client.UpdateBuildStatus(buildID, attempt, status, errorMsg, resolvedCommitSha, timings)
		return err == nil, err
	})
}

func (a *Agent) RunBuildCleanup() {
	if a.Builder == nil {
		return
	}

	log.Printf("[build:cleanup] running periodic cleanup")
	if err := a.Builder.Cleanup(); err != nil {
		log.Printf("[build:cleanup] cleanup failed: %v", err)
	}
}

func (a *Agent) ProcessCreateManifest(item agenthttp.WorkQueueItem) error {
	var payload struct {
		Images        []string `json:"images"`
		FinalImageUri string   `json:"finalImageUri"`
		BuildGroupID  string   `json:"buildGroupId"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse create_manifest payload: %w", err)
	}

	log.Printf("[create_manifest] creating manifest for %s with %d images", payload.FinalImageUri, len(payload.Images))

	craneArgs := []string{"index", "append", "--insecure", "-t", payload.FinalImageUri}
	for _, img := range payload.Images {
		craneArgs = append(craneArgs, "-m", img)
	}

	manifestStarted := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, paths.CranePath, craneArgs...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("[create_manifest] crane failed: %s", string(output))
		return fmt.Errorf("crane index append failed: %w: %s", err, string(output))
	}

	digestCmd := exec.CommandContext(ctx, paths.CranePath, "digest", "--insecure", payload.FinalImageUri)
	digestOutput, err := digestCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("crane digest failed: %w: %s", err, string(digestOutput))
	}
	digest := strings.TrimSpace(string(digestOutput))
	if !regexp.MustCompile(`^sha256:[0-9a-f]{64}$`).MatchString(digest) {
		return fmt.Errorf("crane returned invalid manifest digest %q", digest)
	}
	repository := payload.FinalImageUri
	if at := strings.Index(repository, "@"); at >= 0 {
		repository = repository[:at]
	} else if colon := strings.LastIndex(repository, ":"); colon > strings.LastIndex(repository, "/") {
		repository = repository[:colon]
	}
	immutableImage := repository + "@" + digest
	durationMs := time.Since(manifestStarted).Milliseconds()
	if err := a.Client.ReportManifestResult(payload.BuildGroupID, item.Attempt, immutableImage, durationMs); err != nil {
		return fmt.Errorf("failed to report manifest digest: %w", err)
	}
	log.Printf("[create_manifest] manifest created successfully for %s in %s", immutableImage, time.Duration(durationMs)*time.Millisecond)
	return nil
}
