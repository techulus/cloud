package agent

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
)

var serverlessTransitionCounter atomic.Uint64

const serverlessTransitionGuardTTL = 2 * time.Minute

type serverlessTransitionGuard struct {
	createdAt time.Time
}

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
	return a.withDeploymentDeployLock(expected.DeploymentID, func() error {
		containers, err := container.List()
		if err == nil {
			for _, actual := range containers {
				if actual.DeploymentID != expected.DeploymentID {
					continue
				}
				if !runningContainerMatchesExpectedRevision(actual, expected) {
					log.Printf(
						"[serverless] recreate deployment %s because revision/spec changed",
						Truncate(expected.DeploymentID, 8),
					)
					return a.Reconciler.Deploy(expected)
				}
				if actual.State == "running" {
					return nil
				}
				log.Printf(
					"[serverless] starting stopped container %s for deployment %s",
					Truncate(actual.ID, 12),
					Truncate(expected.DeploymentID, 8),
				)
				if err := container.Start(actual.ID); err != nil {
					log.Printf(
						"[serverless] start failed for deployment %s, recreating: %v",
						Truncate(expected.DeploymentID, 8),
						err,
					)
					return a.Reconciler.Deploy(expected)
				}
				return nil
			}
		}
		return a.Reconciler.Deploy(expected)
	})
}

func (a *Agent) DeployExpectedContainer(expected agenthttp.ExpectedContainer) error {
	return a.withDeploymentDeployLock(expected.DeploymentID, func() error {
		containers, err := container.List()
		if err == nil {
			for _, actual := range containers {
				if actual.DeploymentID != expected.DeploymentID || actual.State != "running" {
					continue
				}
				if runningContainerMatchesExpectedRevision(actual, expected) {
					return nil
				}
			}
		}
		return a.Reconciler.Deploy(expected)
	})
}

func runningContainerMatchesExpectedRevision(
	actual container.Container,
	expected agenthttp.ExpectedContainer,
) bool {
	return actual.SpecHash != "" &&
		actual.SpecHash == expected.ContainerSpecHash &&
		actual.RevisionID == expected.RevisionID
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

func (a *Agent) StopServerlessContainer(containerID string) error {
	return container.Stop(containerID)
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
	if transition.ID == "" {
		transition.ID = newServerlessTransitionID()
	}

	a.serverlessMutex.Lock()
	if a.pendingServerlessSleep == nil {
		a.pendingServerlessSleep = map[string]serverlessTransitionGuard{}
	}
	if a.pendingServerlessWake == nil {
		a.pendingServerlessWake = map[string]serverlessTransitionGuard{}
	}
	guard := serverlessTransitionGuard{createdAt: time.Now()}
	switch transition.Type {
	case "sleep":
		a.pendingServerlessSleep[transition.DeploymentID] = guard
		delete(a.pendingServerlessWake, transition.DeploymentID)
	case "wake_started":
		delete(a.pendingServerlessSleep, transition.DeploymentID)
		a.pendingServerlessWake[transition.DeploymentID] = guard
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

func (a *Agent) AcknowledgeServerlessTransitions(results []agenthttp.ServerlessTransitionResult, reportedCount int) {
	if len(results) == 0 {
		a.ClearReportedServerlessTransitions(reportedCount)
		return
	}

	acknowledged := map[string]agenthttp.ServerlessTransitionResult{}
	for _, result := range results {
		if result.ID == "" {
			continue
		}
		acknowledged[result.ID] = result
		if result.Outcome == "rejected" {
			log.Printf(
				"[serverless] transition rejected type=%s deployment=%s reason=%s",
				result.Type,
				Truncate(result.DeploymentID, 8),
				result.Reason,
			)
		}
	}

	a.serverlessMutex.Lock()
	defer a.serverlessMutex.Unlock()

	pending := a.pendingServerlessTransitions[:0]
	for _, transition := range a.pendingServerlessTransitions {
		result, ok := acknowledged[transition.ID]
		if !ok {
			pending = append(pending, transition)
			continue
		}

		if result.Outcome == "rejected" {
			switch transition.Type {
			case "sleep":
				delete(a.pendingServerlessSleep, transition.DeploymentID)
			case "wake_started", "wake_failed":
				delete(a.pendingServerlessWake, transition.DeploymentID)
			}
		}
	}
	a.pendingServerlessTransitions = pending
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

	now := time.Now()
	for deploymentID, guard := range a.pendingServerlessSleep {
		if _, stillReporting := pendingSleepTransitions[deploymentID]; stillReporting {
			continue
		}
		desiredState, ok := desiredByDeploymentID[deploymentID]
		if ok && desiredState == "stopped" {
			delete(a.pendingServerlessSleep, deploymentID)
			continue
		}
		if serverlessGuardExpired(guard, now) {
			log.Printf("[serverless] sleep transition guard for deployment %s expired after %s; allowing reconcile", Truncate(deploymentID, 8), roundServerlessGuardAge(now.Sub(guard.createdAt)))
			delete(a.pendingServerlessSleep, deploymentID)
			continue
		}
		if ok && desiredState == "running" {
			log.Printf("[serverless] sleep transition for deployment %s is not reflected in expected state; keeping reconcile suppressed", Truncate(deploymentID, 8))
		}
	}

	for deploymentID, guard := range a.pendingServerlessWake {
		if _, stillReporting := pendingWakeTransitions[deploymentID]; stillReporting {
			continue
		}
		desiredState, ok := desiredByDeploymentID[deploymentID]
		if ok && desiredState == "running" {
			delete(a.pendingServerlessWake, deploymentID)
			continue
		}
		if serverlessGuardExpired(guard, now) {
			log.Printf("[serverless] wake transition guard for deployment %s expired after %s; allowing reconcile", Truncate(deploymentID, 8), roundServerlessGuardAge(now.Sub(guard.createdAt)))
			delete(a.pendingServerlessWake, deploymentID)
			continue
		}
		if !ok || desiredState != "running" {
			log.Printf("[serverless] wake transition for deployment %s is not reflected in expected state; keeping reconcile suppressed", Truncate(deploymentID, 8))
		}
	}
}

func newServerlessTransitionID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return hex.EncodeToString(bytes[:])
	}
	return fmt.Sprintf("fallback-%d", serverlessTransitionCounter.Add(1))
}

func serverlessGuardExpired(guard serverlessTransitionGuard, now time.Time) bool {
	return !guard.createdAt.IsZero() && now.Sub(guard.createdAt) >= serverlessTransitionGuardTTL
}

func roundServerlessGuardAge(age time.Duration) time.Duration {
	return age.Round(time.Second)
}
