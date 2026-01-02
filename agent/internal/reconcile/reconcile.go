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
