package agent

import (
	"fmt"
	"log"
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
	if a.activeWorkItem != nil {
		active = append(active, agenthttp.ActiveWorkItem{
			ID:      a.activeWorkItem.ID,
			Attempt: a.activeWorkItem.Attempt,
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

	item := items[0]

	a.workMutex.Lock()
	if a.activeWorkItem != nil {
		log.Printf("[work-queue] ignoring leased item %s while %s is active", Truncate(item.ID, 8), Truncate(a.activeWorkItem.ID, 8))
		a.workMutex.Unlock()
		return
	}
	a.activeWorkItem = &item
	a.workMutex.Unlock()

	go a.processLeasedWorkItem(item)
}

func (a *Agent) processLeasedWorkItem(item agenthttp.WorkQueueItem) {
	log.Printf("[work-queue] processing item %s (type=%s attempt=%d)", Truncate(item.ID, 8), item.Type, item.Attempt)

	status := "completed"
	errorMsg := ""
	if err := a.ProcessWorkItem(item); err != nil {
		status = "failed"
		errorMsg = err.Error()
		log.Printf("[work-queue] item %s failed: %v", Truncate(item.ID, 8), err)
	} else {
		log.Printf("[work-queue] item %s completed", Truncate(item.ID, 8))
	}

	a.workMutex.Lock()
	if a.activeWorkItem != nil && a.activeWorkItem.ID == item.ID && a.activeWorkItem.Attempt == item.Attempt {
		a.activeWorkItem = nil
	}
	a.pendingWorkResults = append(a.pendingWorkResults, agenthttp.CompletedWorkItem{
		ID:      item.ID,
		Attempt: item.Attempt,
		Status:  status,
		Error:   errorMsg,
	})
	a.workMutex.Unlock()

	a.RequestStatusReport("work item " + status)
}

func (a *Agent) ProcessWorkItem(item agenthttp.WorkQueueItem) error {
	switch item.Type {
	case "restart":
		return a.ProcessRestart(item)
	case "stop":
		return a.ProcessStop(item)
	case "deploy", "reconcile":
		a.RequestReconcile("reconcile work item " + Truncate(item.ID, 8))
		return nil
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
	default:
		return fmt.Errorf("unknown work item type: %s", item.Type)
	}
}
