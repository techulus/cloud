package agent

import (
	"testing"

	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
)

func TestPendingServerlessWakeDoesNotStopStaleStoppedExpectedContainer(t *testing.T) {
	agent := &Agent{
		DisableDNS:             true,
		pendingServerlessSleep: map[string]struct{}{},
		pendingServerlessWake: map[string]struct{}{
			"dep_serverless": {},
		},
	}
	expected := &agenthttp.ExpectedState{
		Containers: []agenthttp.ExpectedContainer{
			{
				DeploymentID: "dep_serverless",
				ServiceID:    "svc_1",
				Name:         "svc_1-dep_serverless",
				DesiredState: "stopped",
				Image:        "nginx",
			},
		},
	}
	actual := &ActualState{
		Containers: []container.Container{
			{
				ID:           "ctr_serverless",
				Name:         "svc_1-dep_serverless",
				Image:        "nginx",
				State:        "running",
				DeploymentID: "dep_serverless",
			},
		},
	}

	for _, action := range agent.planReconcile(expected, actual) {
		if action.DeploymentID == "dep_serverless" {
			t.Fatalf("planReconcile returned action for pending wake: %+v", action)
		}
	}
}

func TestPendingServerlessWakeDoesNotSuppressContainerReport(t *testing.T) {
	agent := &Agent{
		pendingServerlessSleep: map[string]struct{}{},
		pendingServerlessWake: map[string]struct{}{
			"dep_serverless": {},
		},
		latestExpectedState: &agenthttp.ExpectedState{
			Containers: []agenthttp.ExpectedContainer{
				{
					DeploymentID: "dep_serverless",
					DesiredState: "stopped",
				},
			},
		},
	}

	if agent.ShouldSuppressServerlessContainerReport("dep_serverless") {
		t.Fatal("container report was suppressed while wake transition is pending")
	}
}
