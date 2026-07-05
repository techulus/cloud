package agent

import (
	"log"

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
	return a.Reconciler.Deploy(expected)
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
	if transition.Type == "sleep" {
		a.pendingServerlessSleep[transition.DeploymentID] = struct{}{}
	} else if transition.Type == "wake_started" {
		delete(a.pendingServerlessSleep, transition.DeploymentID)
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

func (a *Agent) ShouldSuppressServerlessContainerReport(deploymentID string) bool {
	if a.HasPendingServerlessSleep(deploymentID) {
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

func (a *Agent) ReconcilePendingServerlessSleepWithExpected(state *agenthttp.ExpectedState, fromCache bool) {
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
	for _, transition := range a.pendingServerlessTransitions {
		if transition.Type == "sleep" {
			pendingSleepTransitions[transition.DeploymentID] = struct{}{}
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
}

func (a *Agent) QueueServerlessWakeFailure(deploymentID string, err error) {
	if err == nil {
		return
	}
	log.Printf("[serverless] wake failed for deployment %s: %v", Truncate(deploymentID, 8), err)
	a.QueueServerlessTransition(agenthttp.ServerlessTransition{
		Type:         "wake_failed",
		DeploymentID: deploymentID,
		Error:        err.Error(),
	})
}
