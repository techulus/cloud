package agent

import (
	"slices"
	"testing"
	"time"

	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
)

func TestPendingServerlessWakeDoesNotStopStaleStoppedExpectedContainer(t *testing.T) {
	agent := &Agent{
		DisableDNS:             true,
		pendingServerlessSleep: map[string]serverlessTransitionGuard{},
		pendingServerlessWake: map[string]serverlessTransitionGuard{
			"dep_serverless": {createdAt: time.Now()},
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

func TestServerlessGatewayCapabilityRequiresStartedGateway(t *testing.T) {
	agent := &Agent{IsProxy: true}

	if slices.Contains(agent.agentCapabilities(), serverlessGatewayCapability) {
		t.Fatal("proxy reported serverless gateway capability before gateway start")
	}

	agent.serverlessGatewayRunning.Store(true)
	if !slices.Contains(agent.agentCapabilities(), serverlessGatewayCapability) {
		t.Fatal("proxy did not report serverless gateway capability after gateway start")
	}

	agent.IsProxy = false
	if slices.Contains(agent.agentCapabilities(), serverlessGatewayCapability) {
		t.Fatal("worker reported serverless gateway capability")
	}
}

func TestBuildStatusReportAlwaysIncludesAgentHealth(t *testing.T) {
	previousLastHealthCollect := lastHealthCollect
	lastHealthCollect = time.Now()
	t.Cleanup(func() {
		lastHealthCollect = previousLastHealthCollect
	})

	agent := &Agent{IsProxy: true}
	agent.serverlessGatewayRunning.Store(true)

	report := agent.BuildStatusReport(false)
	if report.AgentHealth == nil {
		t.Fatal("status report omitted agent health while health sampling was skipped")
	}
	if !slices.Contains(report.AgentHealth.Capabilities, serverlessGatewayCapability) {
		t.Fatalf("capabilities = %v, want %s", report.AgentHealth.Capabilities, serverlessGatewayCapability)
	}
}

func TestPendingServerlessWakeDoesNotSuppressContainerReport(t *testing.T) {
	agent := &Agent{
		pendingServerlessSleep: map[string]serverlessTransitionGuard{},
		pendingServerlessWake: map[string]serverlessTransitionGuard{
			"dep_serverless": {createdAt: time.Now()},
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

func TestAcceptedSleepKeepsGuardUntilExpectedStateStops(t *testing.T) {
	agent := &Agent{
		pendingServerlessSleep: map[string]serverlessTransitionGuard{},
		pendingServerlessWake:  map[string]serverlessTransitionGuard{},
	}
	agent.QueueServerlessTransition(agenthttp.ServerlessTransition{
		Type:         "sleep",
		DeploymentID: "dep_serverless",
		ContainerID:  "ctr_serverless",
	})
	transitions := agent.SnapshotServerlessTransitions()
	if len(transitions) != 1 || transitions[0].ID == "" {
		t.Fatalf("transitions = %+v, want one transition with id", transitions)
	}

	agent.AcknowledgeServerlessTransitions([]agenthttp.ServerlessTransitionResult{
		{
			ID:           transitions[0].ID,
			Type:         "sleep",
			DeploymentID: "dep_serverless",
			Outcome:      "applied",
		},
	}, len(transitions))

	agent.ReconcilePendingServerlessTransitionsWithExpected(expectedServerlessState("running"), false)
	if !agent.HasPendingServerlessSleep("dep_serverless") {
		t.Fatal("sleep guard was cleared before expected state stopped")
	}

	agent.ReconcilePendingServerlessTransitionsWithExpected(expectedServerlessState("stopped"), false)
	if agent.HasPendingServerlessSleep("dep_serverless") {
		t.Fatal("sleep guard was not cleared after expected state stopped")
	}
}

func TestRejectedSleepClearsGuard(t *testing.T) {
	agent := &Agent{
		pendingServerlessSleep: map[string]serverlessTransitionGuard{},
		pendingServerlessWake:  map[string]serverlessTransitionGuard{},
	}
	agent.QueueServerlessTransition(agenthttp.ServerlessTransition{
		Type:         "sleep",
		DeploymentID: "dep_serverless",
		ContainerID:  "ctr_serverless",
	})
	transitions := agent.SnapshotServerlessTransitions()

	agent.AcknowledgeServerlessTransitions([]agenthttp.ServerlessTransitionResult{
		{
			ID:           transitions[0].ID,
			Type:         "sleep",
			DeploymentID: "dep_serverless",
			Outcome:      "rejected",
			Reason:       "deployment is not sleepable from starting",
		},
	}, len(transitions))

	if agent.HasPendingServerlessSleep("dep_serverless") {
		t.Fatal("sleep guard was not cleared after explicit rejection")
	}
	if remaining := agent.SnapshotServerlessTransitions(); len(remaining) != 0 {
		t.Fatalf("remaining transitions = %+v, want none", remaining)
	}
}

func TestSleepGuardExpiresWhenExpectedStateStaysRunning(t *testing.T) {
	agent := &Agent{
		pendingServerlessSleep: map[string]serverlessTransitionGuard{
			"dep_serverless": {
				createdAt: time.Now().Add(-serverlessTransitionGuardTTL - time.Second),
			},
		},
		pendingServerlessWake: map[string]serverlessTransitionGuard{},
	}

	agent.ReconcilePendingServerlessTransitionsWithExpected(expectedServerlessState("running"), false)
	if agent.HasPendingServerlessSleep("dep_serverless") {
		t.Fatal("expired sleep guard was not cleared")
	}
}

func TestWakeGuardExpiresWhenExpectedStateStaysStopped(t *testing.T) {
	agent := &Agent{
		pendingServerlessSleep: map[string]serverlessTransitionGuard{},
		pendingServerlessWake: map[string]serverlessTransitionGuard{
			"dep_serverless": {
				createdAt: time.Now().Add(-serverlessTransitionGuardTTL - time.Second),
			},
		},
	}

	agent.ReconcilePendingServerlessTransitionsWithExpected(expectedServerlessState("stopped"), false)
	if agent.HasPendingServerlessWake("dep_serverless") {
		t.Fatal("expired wake guard was not cleared")
	}
}

func expectedServerlessState(desiredState string) *agenthttp.ExpectedState {
	return &agenthttp.ExpectedState{
		Containers: []agenthttp.ExpectedContainer{
			{
				DeploymentID: "dep_serverless",
				DesiredState: desiredState,
			},
		},
	}
}
