package serverless

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
)

type fakeRuntime struct {
	mu           sync.Mutex
	state        *agenthttp.ExpectedState
	containers   []container.Container
	transitions  []agenthttp.ServerlessTransition
	removed      []string
	deployCalls  int
	deployErr    error
	afterList    func()
	healthStatus string
}

func (f *fakeRuntime) ExpectedState() *agenthttp.ExpectedState {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

func (f *fakeRuntime) DeployServerlessContainer(expected agenthttp.ExpectedContainer) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deployCalls += 1
	if f.deployErr != nil {
		return f.deployErr
	}
	f.containers = append(f.containers, container.Container{
		ID:           "ctr-" + expected.DeploymentID,
		State:        "running",
		DeploymentID: expected.DeploymentID,
		ServiceID:    expected.ServiceID,
	})
	return nil
}

func (f *fakeRuntime) RemoveServerlessContainer(containerID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, containerID)
	next := f.containers[:0]
	for _, actual := range f.containers {
		if actual.ID != containerID {
			next = append(next, actual)
		}
	}
	f.containers = next
	return nil
}

func (f *fakeRuntime) ListServerlessContainers() ([]container.Container, error) {
	f.mu.Lock()
	containers := append([]container.Container(nil), f.containers...)
	afterList := f.afterList
	f.mu.Unlock()
	if afterList != nil {
		afterList()
	}
	return containers, nil
}

func (f *fakeRuntime) GetServerlessContainerHealth(containerID string) string {
	if f.healthStatus != "" {
		return f.healthStatus
	}
	return "healthy"
}

func (f *fakeRuntime) QueueServerlessTransition(transition agenthttp.ServerlessTransition) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.transitions = append(f.transitions, transition)
}

func (f *fakeRuntime) snapshot() ([]agenthttp.ServerlessTransition, []string, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]agenthttp.ServerlessTransition(nil), f.transitions...), append([]string(nil), f.removed...), f.deployCalls
}

func TestGetUpstreamsReturnsWhenFollowerContextIsCancelled(t *testing.T) {
	g := NewGateway(&fakeRuntime{})
	g.wakeCalls["sleepy.example.com"] = &wakeCall{done: make(chan struct{})}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := g.getUpstreams(ctx, "sleepy.example.com")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestRequestCanUseAlwaysOnWorkerWhileLocalDeploymentWakes(t *testing.T) {
	runtime := &fakeRuntime{state: testExpectedState("stopped")}
	gateway := NewGateway(runtime)

	upstreams, err := gateway.getUpstreams(context.Background(), "app.example.com")
	if err != nil {
		t.Fatalf("getUpstreams failed: %v", err)
	}
	if len(upstreams) != 1 || upstreams[0].Url != "10.0.0.20:3000" {
		t.Fatalf("upstreams = %+v, want worker upstream", upstreams)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		transitions, _, deployCalls := runtime.snapshot()
		if deployCalls == 1 && len(transitions) == 1 && transitions[0].Type == "wake_started" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	transitions, _, deployCalls := runtime.snapshot()
	t.Fatalf("deployCalls=%d transitions=%+v, want one background wake", deployCalls, transitions)
}

func TestSleepingLocalDeploymentWakesAndReturnsLocalUpstream(t *testing.T) {
	previousPoll := wakePollInterval
	wakePollInterval = time.Millisecond
	t.Cleanup(func() {
		wakePollInterval = previousPoll
	})

	state := testExpectedState("stopped")
	state.Serverless.Routes[0].Upstreams = nil
	runtime := &fakeRuntime{state: state}
	gateway := NewGateway(runtime)

	upstreams, err := gateway.getUpstreams(context.Background(), "app.example.com")
	if err != nil {
		t.Fatalf("getUpstreams failed: %v", err)
	}
	if len(upstreams) != 1 || upstreams[0].Url != "10.0.0.10:3000" {
		t.Fatalf("upstreams = %+v, want local upstream", upstreams)
	}

	transitions, _, deployCalls := runtime.snapshot()
	if deployCalls != 1 {
		t.Fatalf("deployCalls = %d, want 1", deployCalls)
	}
	if len(transitions) != 1 || transitions[0].Type != "wake_started" {
		t.Fatalf("transitions = %+v, want wake_started", transitions)
	}
}

func TestSleepHostRemovesLocalContainerAndReportsSleep(t *testing.T) {
	state := testExpectedState("running")
	runtime := &fakeRuntime{
		state: state,
		containers: []container.Container{
			{ID: "ctr-local", State: "running", DeploymentID: "dep_local", ServiceID: "svc_1"},
		},
	}
	gateway := NewGateway(runtime)

	gateway.sleepHost("app.example.com")

	transitions, removed, _ := runtime.snapshot()
	if len(removed) != 1 || removed[0] != "ctr-local" {
		t.Fatalf("removed = %+v, want ctr-local", removed)
	}
	if len(transitions) != 1 {
		t.Fatalf("transitions = %+v, want one sleep transition", transitions)
	}
	if transitions[0].Type != "sleep" || transitions[0].DeploymentID != "dep_local" || transitions[0].ContainerID != "ctr-local" {
		t.Fatalf("transition = %+v, want sleep for dep_local/ctr-local", transitions[0])
	}
}

func TestSleepHostRechecksActivityBeforeRemovingContainer(t *testing.T) {
	state := testExpectedState("running")
	runtime := &fakeRuntime{
		state: state,
		containers: []container.Container{
			{ID: "ctr-local", State: "running", DeploymentID: "dep_local", ServiceID: "svc_1"},
		},
	}
	gateway := NewGateway(runtime)
	runtime.afterList = func() {
		gateway.beginActivity(serviceActivityKey("svc_1"))
	}

	gateway.sleepHost("app.example.com")

	transitions, removed, _ := runtime.snapshot()
	if len(removed) != 0 {
		t.Fatalf("removed = %+v, want no removals while request is active", removed)
	}
	if len(transitions) != 0 {
		t.Fatalf("transitions = %+v, want no sleep transition while request is active", transitions)
	}
}

func TestSleepHostUsesServiceActivityAcrossDomains(t *testing.T) {
	state := testExpectedState("running")
	secondRoute := state.Serverless.Routes[0]
	secondRoute.Domain = "api.example.com"
	state.Serverless.Routes = append(state.Serverless.Routes, secondRoute)
	runtime := &fakeRuntime{
		state: state,
		containers: []container.Container{
			{ID: "ctr-local", State: "running", DeploymentID: "dep_local", ServiceID: "svc_1"},
		},
	}
	gateway := NewGateway(runtime)
	gateway.beginActivity(serviceActivityKey("svc_1"))

	gateway.sleepHost("api.example.com")

	transitions, removed, _ := runtime.snapshot()
	if len(removed) != 0 {
		t.Fatalf("removed = %+v, want no removals while sibling domain is active", removed)
	}
	if len(transitions) != 0 {
		t.Fatalf("transitions = %+v, want no sleep transition while sibling domain is active", transitions)
	}
}

func TestWakeTimeoutQueuesWakeFailedTransition(t *testing.T) {
	previousPoll := wakePollInterval
	wakePollInterval = time.Millisecond
	t.Cleanup(func() {
		wakePollInterval = previousPoll
	})

	state := testExpectedState("stopped")
	state.Containers[0].HealthCheck = &agenthttp.HealthCheck{
		Cmd:      "curl http://localhost:3000/health",
		Interval: 1,
		Timeout:  1,
		Retries:  1,
	}
	state.Serverless.Routes[0].Upstreams = nil
	state.Serverless.Routes[0].WakeTimeoutSeconds = 1
	runtime := &fakeRuntime{
		state:        state,
		healthStatus: "unhealthy",
	}
	gateway := NewGateway(runtime)

	_, err := gateway.getUpstreams(context.Background(), "app.example.com")
	if err == nil {
		t.Fatal("getUpstreams succeeded, want timeout error")
	}

	transitions, _, deployCalls := runtime.snapshot()
	if deployCalls != 1 {
		t.Fatalf("deployCalls = %d, want 1", deployCalls)
	}
	if len(transitions) != 2 {
		t.Fatalf("transitions = %+v, want wake_started and wake_failed", transitions)
	}
	if transitions[0].Type != "wake_started" || transitions[1].Type != "wake_failed" {
		t.Fatalf("transitions = %+v, want wake_started then wake_failed", transitions)
	}
	if transitions[1].DeploymentID != "dep_local" || transitions[1].Error == "" {
		t.Fatalf("wake_failed transition = %+v, want dep_local with error", transitions[1])
	}
}

func testExpectedState(localDesiredState string) *agenthttp.ExpectedState {
	state := &agenthttp.ExpectedState{
		Containers: []agenthttp.ExpectedContainer{
			{
				DeploymentID: "dep_local",
				ServiceID:    "svc_1",
				ServiceName:  "api",
				Name:         "svc_1-dep_local",
				DesiredState: localDesiredState,
				Image:        "nginx",
				IPAddress:    "10.0.0.10",
			},
		},
	}
	state.Serverless.Routes = []agenthttp.ServerlessRoute{
		{
			ServiceID:          "svc_1",
			Domain:             "app.example.com",
			Port:               3000,
			SleepAfterSeconds:  300,
			WakeTimeoutSeconds: 5,
			MinReadyReplicas:   1,
			LocalDeploymentIDs: []string{"dep_local"},
			Upstreams: []agenthttp.ServerlessUpstream{
				{
					DeploymentID: "dep_worker",
					ServerID:     "server_worker",
					Url:          "10.0.0.20:3000",
					AlwaysOn:     true,
				},
			},
		},
	}
	return state
}
