package agent

import (
	"log"
	"sync"

	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
)

func (a *Agent) SetLatestExpectedState(state *agenthttp.ExpectedState) {
	a.expectedStateMutex.Lock()
	defer a.expectedStateMutex.Unlock()
	a.latestExpectedState = state
}

func (a *Agent) ExpectedState() *agenthttp.ExpectedState {
	a.expectedStateMutex.RLock()
	defer a.expectedStateMutex.RUnlock()
	return a.latestExpectedState
}

func (a *Agent) DeployServerlessContainer(expected agenthttp.ExpectedContainer) error {
	return a.DeployExpectedContainer(expected)
}

func (a *Agent) DeployExpectedContainer(expected agenthttp.ExpectedContainer) error {
	return a.withDeploymentDeployLock(expected.DeploymentID, func() error {
		containers, err := container.List()
		if err == nil {
			for _, actual := range containers {
				if actual.DeploymentID != expected.DeploymentID || actual.State != "running" {
					continue
				}
				if normalizeImage(actual.Image) == normalizeImage(expected.Image) {
					return nil
				}
			}
		}
		return a.Reconciler.Deploy(expected)
	})
}

func (a *Agent) withDeploymentDeployLock(deploymentID string, fn func() error) error {
	a.deployLockMutex.Lock()
	if a.deploymentDeployLocks == nil {
		a.deploymentDeployLocks = map[string]*sync.Mutex{}
	}
	lock, ok := a.deploymentDeployLocks[deploymentID]
	if !ok {
		lock = &sync.Mutex{}
		a.deploymentDeployLocks[deploymentID] = lock
	}
	a.deployLockMutex.Unlock()

	lock.Lock()
	defer lock.Unlock()
	return fn()
}

func (a *Agent) RemoveServerlessContainer(containerID string) error {
	return container.ForceRemove(containerID)
}

func (a *Agent) ListServerlessContainers() ([]container.Container, error) {
	return container.List()
}

func (a *Agent) GetServerlessContainerHealth(containerID string) string {
	return container.GetHealthStatus(containerID)
}

func (a *Agent) QueueServerlessTransition(transition agenthttp.ServerlessTransition) {
	if transition.Type == "" || transition.DeploymentID == "" {
		return
	}

	a.serverlessMutex.Lock()
	if a.pendingServerlessSleep == nil {
		a.pendingServerlessSleep = map[string]struct{}{}
	}
	if a.pendingServerlessWake == nil {
		a.pendingServerlessWake = map[string]struct{}{}
	}
	switch transition.Type {
	case "sleep":
		a.pendingServerlessSleep[transition.DeploymentID] = struct{}{}
		delete(a.pendingServerlessWake, transition.DeploymentID)
	case "wake_started":
		delete(a.pendingServerlessSleep, transition.DeploymentID)
		a.pendingServerlessWake[transition.DeploymentID] = struct{}{}
	case "wake_failed":
		delete(a.pendingServerlessWake, transition.DeploymentID)
	}
	a.pendingServerlessTransitions = append(
		a.pendingServerlessTransitions,
		transition,
	)
	a.serverlessMutex.Unlock()

	a.RequestStatusReport("serverless " + transition.Type)
}

func (a *Agent) SnapshotServerlessTransitions() []agenthttp.ServerlessTransition {
	a.serverlessMutex.Lock()
	defer a.serverlessMutex.Unlock()
	return append([]agenthttp.ServerlessTransition(nil), a.pendingServerlessTransitions...)
}

func (a *Agent) ClearReportedServerlessTransitions(count int) {
	if count <= 0 {
		return
	}

	a.serverlessMutex.Lock()
	defer a.serverlessMutex.Unlock()
	if count > len(a.pendingServerlessTransitions) {
		count = len(a.pendingServerlessTransitions)
	}
	a.pendingServerlessTransitions = a.pendingServerlessTransitions[count:]
}

func (a *Agent) HasPendingServerlessSleep(deploymentID string) bool {
	a.serverlessMutex.Lock()
	defer a.serverlessMutex.Unlock()
	_, ok := a.pendingServerlessSleep[deploymentID]
	return ok
}

func (a *Agent) HasPendingServerlessWake(deploymentID string) bool {
	a.serverlessMutex.Lock()
	defer a.serverlessMutex.Unlock()
	_, ok := a.pendingServerlessWake[deploymentID]
	return ok
}

func (a *Agent) ShouldSuppressServerlessContainerReport(deploymentID string) bool {
	a.serverlessMutex.Lock()
	_, pendingSleep := a.pendingServerlessSleep[deploymentID]
	_, pendingWake := a.pendingServerlessWake[deploymentID]
	a.serverlessMutex.Unlock()

	if pendingWake {
		return false
	}
	if pendingSleep {
		return true
	}

	a.expectedStateMutex.RLock()
	defer a.expectedStateMutex.RUnlock()
	if a.latestExpectedState == nil {
		return false
	}
	for _, expected := range a.latestExpectedState.Containers {
		if expected.DeploymentID == deploymentID {
			return expected.DesiredState == "stopped"
		}
	}
	return false
}

func (a *Agent) ReconcilePendingServerlessTransitionsWithExpected(state *agenthttp.ExpectedState, fromCache bool) {
	if state == nil || fromCache {
		return
	}

	desiredByDeploymentID := map[string]string{}
	for _, expected := range state.Containers {
		desiredByDeploymentID[expected.DeploymentID] = expected.DesiredState
	}

	a.serverlessMutex.Lock()
	defer a.serverlessMutex.Unlock()
	pendingSleepTransitions := map[string]struct{}{}
	pendingWakeTransitions := map[string]struct{}{}
	for _, transition := range a.pendingServerlessTransitions {
		switch transition.Type {
		case "sleep":
			pendingSleepTransitions[transition.DeploymentID] = struct{}{}
		case "wake_started":
			pendingWakeTransitions[transition.DeploymentID] = struct{}{}
		}
	}

	for deploymentID := range a.pendingServerlessSleep {
		if _, stillReporting := pendingSleepTransitions[deploymentID]; stillReporting {
			continue
		}
		delete(a.pendingServerlessSleep, deploymentID)
		desiredState, ok := desiredByDeploymentID[deploymentID]
		if ok && desiredState == "running" {
			log.Printf("[serverless] sleep transition for deployment %s is not reflected in expected state; allowing reconcile", Truncate(deploymentID, 8))
		}
	}

	for deploymentID := range a.pendingServerlessWake {
		if _, stillReporting := pendingWakeTransitions[deploymentID]; stillReporting {
			continue
		}
		delete(a.pendingServerlessWake, deploymentID)
		desiredState, ok := desiredByDeploymentID[deploymentID]
		if !ok || desiredState != "running" {
			log.Printf("[serverless] wake transition for deployment %s is not reflected in expected state; allowing reconcile", Truncate(deploymentID, 8))
		}
	}
}
