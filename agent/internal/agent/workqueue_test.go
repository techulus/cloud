package agent

import (
	"sync"
	"testing"

	agenthttp "techulus/cloud-agent/internal/http"
)

func TestBusyLaneRetainsLeaseAndExclusiveCannotOverlapRuntime(t *testing.T) {
	a := NewAgent(nil, nil, nil, "", "", "", nil, nil, nil, nil, false, false)
	if !a.claimWorkLane("reconcile") {
		t.Fatal("failed to acquire runtime lane")
	}
	a.AcceptLeasedWorkItems([]agenthttp.WorkQueueItem{{ID: "pending", Type: "restart", Attempt: 1}})
	_, active := a.SnapshotWorkStatus()
	if len(active) != 1 || active[0].ID != "pending" {
		t.Fatalf("busy-lane lease was not retained: %+v", active)
	}
	if a.claimWorkLane("force_cleanup") {
		t.Fatal("exclusive work acquired while reconciliation owned runtime lane")
	}
}

func TestPeriodicReconcileOwnsRuntimeLaneUntilIdle(t *testing.T) {
	a := NewAgent(nil, nil, nil, "", "", "", nil, nil, nil, nil, false, false)
	if !a.claimReconcileLane() {
		t.Fatal("periodic reconcile did not acquire runtime ownership")
	}
	a.SetState(StateProcessing)
	if a.claimWorkLane("restart") || a.claimWorkLane("force_cleanup") {
		t.Fatal("work overlapped active reconciliation")
	}
	a.SetState(StateIdle)
	a.releaseReconcileLane()
	if !a.claimWorkLane("restart") {
		t.Fatal("runtime lane was not released after reconciliation")
	}
}

func TestReconcileWorkRetainsRuntimeLaneThroughInternalReconcile(t *testing.T) {
	a := NewAgent(nil, nil, nil, "", "", "", nil, nil, nil, nil, false, false)
	if !a.claimWorkLane("reconcile") {
		t.Fatal("reconcile work did not acquire runtime lane")
	}

	a.workLaneMutex.Lock()
	a.reconcileWorkLaneActive = true
	a.workLaneMutex.Unlock()
	if !a.claimReconcileLane() {
		t.Fatal("work-owned reconcile could not start")
	}

	var wg sync.WaitGroup
	wg.Add(1)
	exclusiveStarted := make(chan bool, 1)
	go func() {
		defer wg.Done()
		exclusiveStarted <- a.claimWorkLane("force_cleanup")
	}()
	wg.Wait()
	if <-exclusiveStarted {
		t.Fatal("exclusive item started before work-owned reconcile finished")
	}

	a.releaseReconcileLane()
	if a.claimWorkLane("force_cleanup") {
		t.Fatal("periodic reconciliation released work-owned runtime lane")
	}
	a.workLaneMutex.Lock()
	a.reconcileWorkLaneActive = false
	a.workLaneMutex.Unlock()
	a.releaseWorkLane("reconcile")
	if !a.claimWorkLane("force_cleanup") {
		t.Fatal("exclusive item did not start after reconcile work finished")
	}
	if a.claimReconcileLane() {
		t.Fatal("tick started while exclusive item owned its lane")
	}
}

func TestReconcileWorkCompletionBeforeInternalReleaseDoesNotWedgeLane(t *testing.T) {
	a := NewAgent(nil, nil, nil, "", "", "", nil, nil, nil, nil, false, false)
	if !a.claimWorkLane("reconcile") {
		t.Fatal("reconcile work did not acquire runtime lane")
	}
	a.workLaneMutex.Lock()
	a.reconcileWorkLaneActive = true
	a.internalReconcileLaneActive = true
	a.reconcileWorkLaneActive = false
	a.workLaneMutex.Unlock()

	a.releaseWorkLane("reconcile")
	if a.claimWorkLane("restart") {
		t.Fatal("work completion released runtime lane before internal reconcile")
	}
	a.releaseReconcileLane()
	if !a.claimWorkLane("restart") {
		t.Fatal("runtime lane remained wedged after internal reconcile released")
	}
}
