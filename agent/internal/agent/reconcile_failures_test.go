package agent

import (
	"errors"
	"testing"
	"time"

	agenthttp "techulus/cloud-agent/internal/http"
)

func TestFailedReconcileActionDoesNotBlockFollowingActions(t *testing.T) {
	now := time.Now()
	agent := &Agent{
		expectedState:     &agenthttp.ExpectedState{},
		reconcileFailures: map[string]reconcileActionFailure{},
	}
	badContainer := agenthttp.ExpectedContainer{
		DeploymentID:      "bad-deployment",
		ContainerSpecHash: "bad-spec",
	}
	badAction := reconcileAction{
		Kind:         actionDeployMissingContainer,
		Description:  "deploy image that cannot be pulled",
		DeploymentID: badContainer.DeploymentID,
		Expected:     &badContainer,
	}
	clusterAction := reconcileAction{
		Kind:        actionUpdateDNS,
		Description: "update DNS",
	}

	agent.recordReconcileFailure(badAction, errors.New("image pull failed"), now)
	selected, eligible, _ := agent.nextEligibleReconcileAction(
		[]reconcileAction{badAction, clusterAction},
		now,
	)

	if !eligible {
		t.Fatal("expected the independent action to remain eligible")
	}
	if selected.Kind != actionUpdateDNS {
		t.Fatalf("expected DNS action, got %s", selected.Kind)
	}

	selected, eligible, _ = agent.nextEligibleReconcileAction(
		[]reconcileAction{badAction, clusterAction},
		now.Add(2*reconcileFailureBaseBackoff),
	)
	if !eligible || selected.Kind != actionDeployMissingContainer {
		t.Fatalf("expected failed action to become eligible after backoff, got %s", selected.Kind)
	}
}

func TestChangedContainerSpecClearsActionBackoff(t *testing.T) {
	now := time.Now()
	agent := &Agent{
		expectedState:     &agenthttp.ExpectedState{},
		reconcileFailures: map[string]reconcileActionFailure{},
	}
	original := agenthttp.ExpectedContainer{
		DeploymentID:      "deployment",
		ContainerSpecHash: "original-spec",
	}
	originalAction := reconcileAction{
		Kind:         actionRedeployContainer,
		Description:  "redeploy original",
		DeploymentID: original.DeploymentID,
		Expected:     &original,
	}
	agent.recordReconcileFailure(originalAction, errors.New("image pull failed"), now)

	updated := original
	updated.ContainerSpecHash = "updated-spec"
	updatedAction := originalAction
	updatedAction.Description = "redeploy updated"
	updatedAction.Expected = &updated

	selected, eligible, _ := agent.nextEligibleReconcileAction(
		[]reconcileAction{updatedAction},
		now,
	)
	if !eligible || selected.Expected.ContainerSpecHash != "updated-spec" {
		t.Fatal("expected a changed container specification to bypass stale backoff")
	}
	if failures := agent.SnapshotReconciliationFailures(); len(failures) != 0 {
		t.Fatalf("expected stale failure to be pruned, got %d", len(failures))
	}
}
