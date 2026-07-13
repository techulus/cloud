package agent

import (
	"testing"
	"time"

	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
)

func TestContainerRevisionHashControlsRecreation(t *testing.T) {
	tests := []struct {
		name       string
		actualHash string
		wantAction bool
	}{
		{name: "matching hash", actualHash: "spec-v1", wantAction: false},
		{name: "changed hash", actualHash: "spec-v0", wantAction: true},
		{name: "legacy missing hash", actualHash: "", wantAction: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			agent := &Agent{DisableDNS: true}
			expected := &agenthttp.ExpectedState{
				Containers: []agenthttp.ExpectedContainer{
					{
						DeploymentID:      "deployment",
						ServiceID:         "service",
						Name:              "service-deployment",
						Image:             "docker.io/library/nginx",
						DesiredState:      "running",
						ContainerSpecHash: "spec-v1",
					},
				},
			}
			actual := &ActualState{
				Containers: []container.Container{
					{
						ID:           "container",
						DeploymentID: "deployment",
						Image:        "docker.io/library/nginx",
						State:        "running",
						SpecHash:     tt.actualHash,
					},
				},
			}

			found := false
			for _, action := range agent.planReconcile(expected, actual) {
				if action.DeploymentID == "deployment" && action.Kind == actionRedeployContainer {
					found = true
				}
			}
			if found != tt.wantAction {
				t.Fatalf("redeploy action = %v, want %v", found, tt.wantAction)
			}
		})
	}
}

func TestRunningContainerOnlySkipsDeployWhenRevisionSpecMatches(t *testing.T) {
	expected := agenthttp.ExpectedContainer{
		RevisionID:        "revision-v2",
		ContainerSpecHash: "spec-v2",
	}

	tests := []struct {
		name   string
		actual container.Container
		want   bool
	}{
		{
			name: "matching revision and spec",
			actual: container.Container{
				RevisionID: "revision-v2",
				SpecHash:   "spec-v2",
			},
			want: true,
		},
		{
			name: "legacy container without revision labels",
			actual: container.Container{
				Image: "docker.io/library/nginx",
			},
		},
		{
			name: "changed spec",
			actual: container.Container{
				RevisionID: "revision-v2",
				SpecHash:   "spec-v1",
			},
		},
		{
			name: "changed revision",
			actual: container.Container{
				RevisionID: "revision-v1",
				SpecHash:   "spec-v2",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := runningContainerMatchesExpectedRevision(tt.actual, expected); got != tt.want {
				t.Fatalf("revision/spec match = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestLegacyCutoverHealthWaitOnlyDefersOtherLegacyRecreations(t *testing.T) {
	healthCheck := &agenthttp.HealthCheck{Cmd: "check"}
	agent := &Agent{
		expectedState: &agenthttp.ExpectedState{
			Containers: []agenthttp.ExpectedContainer{
				{DeploymentID: "first", HealthCheck: healthCheck},
			},
		},
		legacyCutoverHealthWait:      "first",
		legacyCutoverHealthWaitSince: time.Now(),
	}
	legacyActual := container.Container{DeploymentID: "second"}
	legacyExpected := agenthttp.ExpectedContainer{
		DeploymentID:      "second",
		ContainerSpecHash: "spec-v1",
	}
	actions := []reconcileAction{
		{
			Kind:         actionRedeployContainer,
			DeploymentID: "second",
			Actual:       &legacyActual,
			Expected:     &legacyExpected,
		},
		{Kind: actionUpdateDNS},
	}

	filtered, waiting := agent.gateLegacyCutoverRecreations(actions, &ActualState{})
	if !waiting {
		t.Fatal("expected cutover health gate to remain active")
	}
	if len(filtered) != 1 || filtered[0].Kind != actionUpdateDNS {
		t.Fatalf("expected cluster reconciliation to continue, got %+v", filtered)
	}
}

func TestLegacyCutoverStabilizationTimeoutBecomesVisibleFailure(t *testing.T) {
	agent := &Agent{
		expectedState: &agenthttp.ExpectedState{
			Containers: []agenthttp.ExpectedContainer{{DeploymentID: "first"}},
		},
		legacyCutoverHealthWait:      "first",
		legacyCutoverHealthWaitSince: time.Now().Add(-legacyCutoverMaxWait),
	}

	filtered, waiting := agent.gateLegacyCutoverRecreations(
		[]reconcileAction{{
			Kind:         actionRedeployContainer,
			DeploymentID: "second",
			Actual:       &container.Container{DeploymentID: "second"},
			Expected: &agenthttp.ExpectedContainer{
				DeploymentID:      "second",
				ContainerSpecHash: "spec-v1",
			},
		}},
		&ActualState{},
	)

	if waiting || len(filtered) != 1 || filtered[0].Kind != actionWaitLegacyCutover {
		t.Fatalf("expected a visible stabilization failure action, got %+v", filtered)
	}
	if agent.legacyCutoverHealthWait != "" {
		t.Fatal("expected timed-out legacy recreation gate to be released")
	}

	nextActions, waiting := agent.gateLegacyCutoverRecreations(
		[]reconcileAction{{
			Kind:         actionRedeployContainer,
			DeploymentID: "second",
			Actual:       &container.Container{DeploymentID: "second"},
			Expected: &agenthttp.ExpectedContainer{
				DeploymentID:      "second",
				ContainerSpecHash: "spec-v1",
			},
		}},
		&ActualState{},
	)
	if waiting || len(nextActions) != 1 || nextActions[0].Kind != actionRedeployContainer {
		t.Fatalf("expected remaining legacy recreation to proceed, got %+v", nextActions)
	}
}

func TestLegacyCutoverWithoutHealthCheckWaitsForStabilization(t *testing.T) {
	agent := &Agent{
		expectedState: &agenthttp.ExpectedState{
			Containers: []agenthttp.ExpectedContainer{{DeploymentID: "first"}},
		},
		legacyCutoverHealthWait:      "first",
		legacyCutoverHealthWaitSince: time.Now(),
	}
	actual := &ActualState{Containers: []container.Container{{
		ID:           "container",
		DeploymentID: "first",
		State:        "running",
	}}}
	actions := []reconcileAction{{
		Kind:         actionRedeployContainer,
		DeploymentID: "second",
		Actual:       &container.Container{DeploymentID: "second"},
		Expected: &agenthttp.ExpectedContainer{
			DeploymentID:      "second",
			ContainerSpecHash: "spec-v1",
		},
	}}

	filtered, waiting := agent.gateLegacyCutoverRecreations(actions, actual)
	if !waiting || len(filtered) != 0 {
		t.Fatal("expected another legacy recreation to remain gated")
	}

	agent.legacyCutoverHealthWaitSince = time.Now().Add(-legacyCutoverStabilizationDelay)
	filtered, waiting = agent.gateLegacyCutoverRecreations(actions, actual)
	if waiting || len(filtered) != len(actions) {
		t.Fatal("expected recreation to continue after stabilization")
	}
}
