package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"techulus/cloud-agent/internal/build"
	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/crypto"
	agenthttp "techulus/cloud-agent/internal/http"
)

func (a *Agent) ProcessRestart(item agenthttp.WorkQueueItem) error {
	var payload struct {
		DeploymentID string `json:"deploymentId"`
		ContainerID  string `json:"containerId"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse restart payload: %w", err)
	}

	log.Printf("[restart] restarting container %s for deployment %s", Truncate(payload.ContainerID, 12), Truncate(payload.DeploymentID, 8))

	if err := container.Restart(payload.ContainerID); err != nil {
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

	if err := container.Stop(payload.ContainerID); err != nil {
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

	for _, containerID := range payload.ContainerIDs {
		if err := container.Stop(containerID); err != nil {
			log.Printf("[force_cleanup] failed to stop %s: %v", Truncate(containerID, 12), err)
		}
		if err := container.ForceRemove(containerID); err != nil {
			log.Printf("[force_cleanup] failed to remove %s: %v", Truncate(containerID, 12), err)
		}
	}

	return nil
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

	buildDetails, err := a.Client.GetBuild(payload.BuildID)
	if err != nil {
		return fmt.Errorf("failed to get build details: %w", err)
	}

	timeoutMinutes := buildDetails.TimeoutMinutes
	if timeoutMinutes <= 0 {
		timeoutMinutes = 30
	}
	log.Printf("[build] starting build %s for commit %s (timeout: %d minutes)", Truncate(payload.BuildID, 8), Truncate(buildDetails.Build.CommitSha, 8), timeoutMinutes)

	if err := a.Client.UpdateBuildStatus(payload.BuildID, "cloning", ""); err != nil {
		log.Printf("[build] failed to update status to cloning: %v", err)
	}

	checkCancelled := func() bool {
		status, err := a.Client.GetBuildStatus(payload.BuildID)
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
		ImageURI:        buildDetails.ImageURI,
		ServiceID:       buildDetails.Build.ServiceID,
		ProjectID:       buildDetails.Build.ProjectID,
		RootDir:         buildDetails.RootDir,
		Secrets:         decryptedSecrets,
		TargetPlatforms: buildDetails.TargetPlatforms,
	}

	onStatusChange := func(status string) {
		if err := a.Client.UpdateBuildStatus(payload.BuildID, status, ""); err != nil {
			log.Printf("[build] failed to update status to %s: %v", status, err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMinutes)*time.Minute)
	defer cancel()
	err = a.Builder.Build(ctx, buildConfig, checkCancelled, onStatusChange)
	if err != nil {
		log.Printf("[build] build %s failed: %v", Truncate(payload.BuildID, 8), err)
		if updateErr := a.Client.UpdateBuildStatus(payload.BuildID, "failed", err.Error()); updateErr != nil {
			log.Printf("[build] failed to update status to failed: %v", updateErr)
		}
		return err
	}

	log.Printf("[build] build %s completed successfully", Truncate(payload.BuildID, 8))
	if err := a.Client.UpdateBuildStatus(payload.BuildID, "completed", ""); err != nil {
		log.Printf("[build] failed to update status to completed: %v", err)
	}

	return nil
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
