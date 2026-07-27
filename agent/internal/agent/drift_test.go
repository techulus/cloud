package agent

import (
	"testing"

	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
)

func TestReconcileActionKey(t *testing.T) {
	tests := []struct {
		name   string
		first  reconcileAction
		second reconcileAction
		equal  bool
	}{
		{
			name:   "same deployment action",
			first:  reconcileAction{Kind: actionStartContainer, DeploymentID: "dep_1"},
			second: reconcileAction{Kind: actionStartContainer, DeploymentID: "dep_1"},
			equal:  true,
		},
		{
			name:   "different deployment",
			first:  reconcileAction{Kind: actionStartContainer, DeploymentID: "dep_1"},
			second: reconcileAction{Kind: actionStartContainer, DeploymentID: "dep_2"},
		},
		{
			name:   "different action",
			first:  reconcileAction{Kind: actionStartContainer, DeploymentID: "dep_1"},
			second: reconcileAction{Kind: actionRedeployContainer, DeploymentID: "dep_1"},
		},
		{
			name: "orphan container id",
			first: reconcileAction{
				Kind:   actionRemoveOrphanNoDeploymentID,
				Actual: &container.Container{ID: "ctr_1"},
			},
			second: reconcileAction{
				Kind:   actionRemoveOrphanNoDeploymentID,
				Actual: &container.Container{ID: "ctr_1"},
			},
			equal: true,
		},
		{
			name: "expected container name fallback",
			first: reconcileAction{
				Kind:     actionDeployMissingContainer,
				Expected: &agenthttp.ExpectedContainer{Name: "service-1"},
			},
			second: reconcileAction{
				Kind:     actionDeployMissingContainer,
				Expected: &agenthttp.ExpectedContainer{Name: "service-1"},
			},
			equal: true,
		},
		{
			name:   "singleton action",
			first:  reconcileAction{Kind: actionUpdateDNS},
			second: reconcileAction{Kind: actionUpdateDNS},
			equal:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := reconcileActionKey(tt.first) == reconcileActionKey(tt.second); got != tt.equal {
				t.Fatalf("key equality = %t, want %t", got, tt.equal)
			}
		})
	}
}

func TestVerifyExpectedContainerIdentitiesRejectsDuplicateDeployment(t *testing.T) {
	expected := &agenthttp.ExpectedState{Containers: []agenthttp.ExpectedContainer{{DeploymentID: "dep_1"}}}
	actual := []container.Container{
		{ID: "one", DeploymentID: "dep_1", State: "running", ImageID: "sha256:image"},
		{ID: "two", DeploymentID: "dep_1", State: "running", ImageID: "sha256:image"},
	}
	if err := verifyExpectedContainerIdentities(expected, actual, map[string]container.ResolvedImage{"": "sha256:image"}); err == nil {
		t.Fatal("duplicate deployment containers were accepted")
	}
}

func TestPlanReconcileUsesResolvedImageIdentity(t *testing.T) {
	a := NewAgent(nil, nil, nil, "", "", "", nil, nil, nil, nil, false, false)
	expected := &agenthttp.ExpectedState{Containers: []agenthttp.ExpectedContainer{{DeploymentID: "dep_1", Name: "service", Image: "example/app:latest"}}}
	resolved := map[string]container.ResolvedImage{"example/app:latest": "sha256:new"}

	for _, actual := range []container.Container{
		{DeploymentID: "dep_1", State: "running", Image: "example/app:latest"},
		{DeploymentID: "dep_1", State: "running", Image: "example/app:latest", ImageID: "sha256:old"},
	} {
		actions := a.planReconcile(expected, &ActualState{Containers: []container.Container{actual}}, resolved)
		if len(actions) == 0 || actions[0].Kind != actionRedeployContainer {
			t.Fatalf("identity drift did not plan redeploy for %+v: %+v", actual, actions)
		}
	}

	actual := &ActualState{Containers: []container.Container{{
		DeploymentID: "dep_1", State: "running", Image: "sha256:new", ImageID: "sha256:new",
	}}}
	for _, action := range a.planReconcile(expected, actual, resolved) {
		if action.Kind == actionRedeployContainer {
			t.Fatalf("matching immutable image identity planned redeploy: %+v", action)
		}
	}
}

func TestTransitionToIdleClearsProcessingImages(t *testing.T) {
	a := NewAgent(nil, nil, nil, "", "", "", nil, nil, nil, nil, false, false)
	a.SetState(StateProcessing)
	a.processingImages = map[string]container.ResolvedImage{"example/app:latest": "sha256:image"}

	a.transitionToIdle()

	if a.processingImages != nil {
		t.Fatalf("processing images retained after idle transition: %v", a.processingImages)
	}
}
