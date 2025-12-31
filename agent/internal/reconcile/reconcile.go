package reconcile

import (
	"fmt"
	"log"

	"techulus/cloud-agent/internal/crypto"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/podman"
)

type Reconciler struct {
	encryptionKey string
}

func NewReconciler(encryptionKey string) *Reconciler {
	return &Reconciler{
		encryptionKey: encryptionKey,
	}
}

func (r *Reconciler) Reconcile(expected []agenthttp.ExpectedContainer, actual []podman.Container) error {
	expectedMap := make(map[string]agenthttp.ExpectedContainer)
	for _, c := range expected {
		expectedMap[c.DeploymentID] = c
	}

	actualMap := make(map[string]podman.Container)
	for _, c := range actual {
		if c.DeploymentID != "" {
			actualMap[c.DeploymentID] = c
		}
	}

	for deploymentID, exp := range expectedMap {
		act, exists := actualMap[deploymentID]
		if !exists {
			log.Printf("[reconcile] deploying missing container for deployment %s", deploymentID)
			if err := r.Deploy(exp); err != nil {
				log.Printf("[reconcile] failed to deploy %s: %v", deploymentID, err)
			}
			continue
		}

		if r.needsRedeploy(exp, act) {
			log.Printf("[reconcile] redeploying container for deployment %s (config changed)", deploymentID)
			if err := podman.Stop(act.ID); err != nil {
				log.Printf("[reconcile] failed to stop old container %s: %v", act.ID, err)
			}
			if err := r.Deploy(exp); err != nil {
				log.Printf("[reconcile] failed to redeploy %s: %v", deploymentID, err)
			}
		}
	}

	for deploymentID, act := range actualMap {
		if _, exists := expectedMap[deploymentID]; !exists {
			if act.State == "running" {
				log.Printf("[reconcile] stopping orphan container %s (deployment %s)", act.ID, deploymentID)
				if err := podman.Stop(act.ID); err != nil {
					log.Printf("[reconcile] failed to stop orphan %s: %v", act.ID, err)
				}
			}
		}
	}

	return nil
}

func (r *Reconciler) Deploy(exp agenthttp.ExpectedContainer) error {
	portMappings := make([]podman.PortMapping, len(exp.Ports))
	for i, p := range exp.Ports {
		portMappings[i] = podman.PortMapping{
			ContainerPort: p.ContainerPort,
			HostPort:      p.HostPort,
		}
	}

	var healthCheck *podman.HealthCheck
	if exp.HealthCheck != nil && exp.HealthCheck.Cmd != "" {
		healthCheck = &podman.HealthCheck{
			Cmd:         exp.HealthCheck.Cmd,
			Interval:    exp.HealthCheck.Interval,
			Timeout:     exp.HealthCheck.Timeout,
			Retries:     exp.HealthCheck.Retries,
			StartPeriod: exp.HealthCheck.StartPeriod,
		}
	}

	decryptedEnv := make(map[string]string)
	for key, encryptedValue := range exp.Env {
		if r.encryptionKey == "" {
			return fmt.Errorf("encryption key not configured, cannot decrypt secret %s", key)
		}
		decrypted, err := crypto.DecryptSecret(encryptedValue, r.encryptionKey)
		if err != nil {
			return fmt.Errorf("failed to decrypt secret %s: %w", key, err)
		}
		decryptedEnv[key] = decrypted
	}

	volumeMounts := make([]podman.VolumeMount, len(exp.Volumes))
	for i, v := range exp.Volumes {
		volumeMounts[i] = podman.VolumeMount{
			Name:          v.Name,
			HostPath:      v.HostPath,
			ContainerPath: v.ContainerPath,
		}
	}

	_, err := podman.Deploy(&podman.DeployConfig{
		Name:         exp.Name,
		Image:        exp.Image,
		ServiceID:    exp.ServiceID,
		ServiceName:  exp.ServiceName,
		DeploymentID: exp.DeploymentID,
		IPAddress:    exp.IPAddress,
		PortMappings: portMappings,
		HealthCheck:  healthCheck,
		Env:          decryptedEnv,
		VolumeMounts: volumeMounts,
		LogFunc:      func(stream, message string) { log.Printf("[deploy:%s] %s", stream, message) },
	})

	return err
}

func (r *Reconciler) needsRedeploy(exp agenthttp.ExpectedContainer, act podman.Container) bool {
	if act.State != "running" {
		return true
	}

	if exp.Image != act.Image {
		log.Printf("[reconcile] image mismatch: expected %s, actual %s", exp.Image, act.Image)
		return true
	}

	return false
}
