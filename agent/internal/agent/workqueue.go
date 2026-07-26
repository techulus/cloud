package agent

import (
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	agenthttp "techulus/cloud-agent/internal/http"
)

const (
	StatusReportInterval = 15 * time.Second
)

func (a *Agent) SnapshotWorkStatus() ([]agenthttp.CompletedWorkItem, []agenthttp.ActiveWorkItem) {
	a.workMutex.Lock()
	defer a.workMutex.Unlock()

	completed := append([]agenthttp.CompletedWorkItem(nil), a.pendingWorkResults...)
	active := []agenthttp.ActiveWorkItem{}
	for _, item := range a.activeWorkItems {
		active = append(active, agenthttp.ActiveWorkItem{
			ID: item.ID, Attempt: item.Attempt, Type: item.Type,
		})
	}

	return completed, active
}

func (a *Agent) AcknowledgeWorkResults(accepted []string, rejected []agenthttp.RejectedWorkItemResult) {
	if len(accepted) == 0 && len(rejected) == 0 {
		return
	}

	acknowledged := map[string]struct{}{}
	for _, id := range accepted {
		acknowledged[id] = struct{}{}
	}
	for _, item := range rejected {
		acknowledged[item.ID] = struct{}{}
		log.Printf("[work-queue] completion rejected for %s: %s", Truncate(item.ID, 8), item.Reason)
	}

	a.workMutex.Lock()
	defer a.workMutex.Unlock()

	pending := a.pendingWorkResults[:0]
	for _, result := range a.pendingWorkResults {
		if _, ok := acknowledged[result.ID]; !ok {
			pending = append(pending, result)
		}
	}
	a.pendingWorkResults = pending
}

func (a *Agent) LogRejectedActiveWorkItems(rejected []agenthttp.RejectedWorkItemResult) {
	for _, item := range rejected {
		log.Printf("[work-queue] active item renewal rejected for %s: %s", Truncate(item.ID, 8), item.Reason)
	}
}

func (a *Agent) AcceptLeasedWorkItems(items []agenthttp.WorkQueueItem) {
	if len(items) == 0 {
		return
	}

	for _, item := range items {
		a.workMutex.Lock()
		if _, exists := a.activeWorkItems[item.ID]; exists {
			a.workMutex.Unlock()
			continue
		}
		a.activeWorkItems[item.ID] = item
		a.pendingWorkItems[item.ID] = true
		a.workMutex.Unlock()
		a.startPendingWorkItems()
	}
	a.RequestStatusReport("work lease accepted")
}

func (a *Agent) startPendingWorkItems() {
	a.workMutex.Lock()
	defer a.workMutex.Unlock()
	for id, item := range a.activeWorkItems {
		if !a.pendingWorkItems[id] || !a.claimWorkLane(item.Type) {
			continue
		}
		delete(a.pendingWorkItems, id)
		go a.processLeasedWorkItem(item)
	}
}

func workLane(itemType string) string {
	switch itemType {
	case "deploy", "reconcile", "stop", "restart":
		return "runtime"
	case "build", "create_manifest":
		return "build"
	default:
		return "exclusive"
	}
}

func (a *Agent) claimWorkLane(itemType string) bool {
	a.workLaneMutex.Lock()
	defer a.workLaneMutex.Unlock()
	lane := workLane(itemType)
	if lane == "exclusive" {
		if a.exclusiveLaneActive || a.runtimeLaneActive || a.buildLaneActive {
			return false
		}
		a.exclusiveLaneActive = true
		return true
	}
	if a.exclusiveLaneActive {
		return false
	}
	if lane == "runtime" {
		if a.runtimeLaneActive {
			return false
		}
		a.runtimeLaneActive = true
	} else {
		if a.buildLaneActive {
			return false
		}
		a.buildLaneActive = true
	}
	return true
}

func (a *Agent) releaseWorkLane(itemType string) {
	a.workLaneMutex.Lock()
	defer a.workLaneMutex.Unlock()
	switch workLane(itemType) {
	case "runtime":
		if !a.internalReconcileLaneActive {
			a.runtimeLaneActive = false
		}
	case "build":
		a.buildLaneActive = false
	default:
		a.exclusiveLaneActive = false
	}
}

func (a *Agent) processLeasedWorkItem(item agenthttp.WorkQueueItem) {
	log.Printf("[work-queue] processing item %s (type=%s attempt=%d)", Truncate(item.ID, 8), item.Type, item.Attempt)

	status := "completed"
	errorMsg := ""
	restartAfterReport := false
	if err := a.ProcessWorkItem(item); err != nil {
		if errors.Is(err, errAgentUpgradeRestartNeeded) {
			restartAfterReport = true
		} else {
			status = "failed"
			errorMsg = err.Error()
			log.Printf("[work-queue] item %s failed: %v", Truncate(item.ID, 8), err)
		}
	} else {
		log.Printf("[work-queue] item %s completed", Truncate(item.ID, 8))
	}

	a.workMutex.Lock()
	if !restartAfterReport {
		delete(a.activeWorkItems, item.ID)
		delete(a.pendingWorkItems, item.ID)
	}
	a.pendingWorkResults = append(a.pendingWorkResults, agenthttp.CompletedWorkItem{
		ID:      item.ID,
		Attempt: item.Attempt,
		Status:  status,
		Error:   errorMsg,
	})
	a.workMutex.Unlock()
	a.releaseWorkLane(item.Type)
	a.startPendingWorkItems()

	a.RequestStatusReport("work item " + status)
	if restartAfterReport {
		a.reportStatus("agent upgrade completed")
		log.Printf("[upgrade] exiting so systemd restarts the upgraded agent")
		os.Exit(0)
	}
}

func (a *Agent) ProcessWorkItem(item agenthttp.WorkQueueItem) error {
	switch item.Type {
	case "restart":
		return a.ProcessRestart(item)
	case "stop":
		return a.ProcessStop(item)
	case "deploy", "reconcile":
		a.workLaneMutex.Lock()
		if !a.runtimeLaneActive || a.exclusiveLaneActive {
			a.workLaneMutex.Unlock()
			return fmt.Errorf("reconcile work item does not own runtime lane")
		}
		a.reconcileWorkLaneActive = true
		a.workLaneMutex.Unlock()
		defer func() {
			a.workLaneMutex.Lock()
			a.reconcileWorkLaneActive = false
			a.workLaneMutex.Unlock()
		}()
		a.RequestReconcile("reconcile work item " + Truncate(item.ID, 8))
		deadline := time.Now().Add(ProcessingTimeout)
		for time.Now().Before(deadline) {
			a.expectedStateMutex.RLock()
			expected := a.latestExpectedState
			applied := a.latestAppliedGeneration
			a.expectedStateMutex.RUnlock()
			a.workLaneMutex.Lock()
			internalActive := a.internalReconcileLaneActive
			a.workLaneMutex.Unlock()
			if expected != nil && applied >= expected.Generation && a.GetState() == StateIdle && !internalActive {
				return nil
			}
			time.Sleep(100 * time.Millisecond)
		}
		return fmt.Errorf("reconciliation did not converge within %v", ProcessingTimeout)
	case "force_cleanup":
		return a.ProcessForceCleanup(item)
	case "cleanup_volumes":
		return a.ProcessCleanupVolumes(item)
	case "build":
		return a.ProcessBuild(item)
	case "backup_volume":
		return a.ProcessBackupVolume(item)
	case "restore_volume":
		return a.ProcessRestoreVolume(item)
	case "create_manifest":
		return a.ProcessCreateManifest(item)
	case "upgrade_agent":
		return a.ProcessAgentUpgrade(item)
	default:
		return fmt.Errorf("unknown work item type: %s", item.Type)
	}
}
