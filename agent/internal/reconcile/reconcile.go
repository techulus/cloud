package reconcile

import (
	"context"
	"fmt"
	"log"
	"path/filepath"

	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/crypto"
	agenthttp "techulus/cloud-agent/internal/http"
)

type Reconciler struct {
	encryptionKey string
	dataDir       string
}

func NewReconciler(encryptionKey, dataDir string) *Reconciler {
	return &Reconciler{
		encryptionKey: encryptionKey,
		dataDir:       dataDir,
	}
}

func (r *Reconciler) PullImage(ctx context.Context, reference string) (container.ResolvedImage, error) {
	return container.PullImage(ctx, reference)
}

func (r *Reconciler) DeployResolved(ctx context.Context, exp agenthttp.ExpectedContainer, image container.ResolvedImage) (*container.DeployResult, error) {
	portMappings := make([]container.PortMapping, len(exp.Ports))
	for i, p := range exp.Ports {
		portMappings[i] = container.PortMapping{
			ContainerPort: p.ContainerPort,
			HostPort:      p.HostPort,
		}
	}

	var healthCheck *container.HealthCheck
	if exp.HealthCheck != nil && exp.HealthCheck.Cmd != "" {
		healthCheck = &container.HealthCheck{
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
			return nil, fmt.Errorf("encryption key not configured, cannot decrypt secret %s", key)
		}
		decrypted, err := crypto.DecryptSecret(encryptedValue, r.encryptionKey)
		if err != nil {
			return nil, fmt.Errorf("failed to decrypt secret %s: %w", key, err)
		}
		decryptedEnv[key] = decrypted
	}

	volumeMounts := make([]container.VolumeMount, len(exp.Volumes))
	for i, v := range exp.Volumes {
		volumeMounts[i] = container.VolumeMount{
			Name:          v.Name,
			HostPath:      filepath.Join(r.dataDir, "volumes", exp.ServiceID, v.Name),
			ContainerPath: v.ContainerPath,
		}
	}

	return container.Deploy(ctx, &container.DeployConfig{
		Name:              exp.Name,
		Image:             exp.Image,
		ServiceID:         exp.ServiceID,
		ServiceName:       exp.ServiceName,
		DeploymentID:      exp.DeploymentID,
		IPAddress:         exp.IPAddress,
		PortMappings:      portMappings,
		PublishLocalPorts: exp.PublishLocalPorts,
		HealthCheck:       healthCheck,
		Env:               decryptedEnv,
		VolumeMounts:      volumeMounts,
		StartCommand:      exp.StartCommand,
		CPULimit:          exp.ResourceCPULimit,
		MemoryLimitMb:     exp.ResourceMemoryLimitMb,
		LogFunc:           func(stream, message string) { log.Printf("[deploy:%s] %s", stream, message) },
	}, image)
}
