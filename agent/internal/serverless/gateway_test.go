package serverless

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
)

func init() {
	checkUpstreamReady = func(string) upstreamReadiness { return upstreamReadiness{ready: true} }
}

type fakeRuntime struct {
	mu                sync.Mutex
	state             *agenthttp.ExpectedState
	containers        []container.Container
	transitions       []agenthttp.ServerlessTransition
	stopped           []string
	deployCalls       int
	afterList         func()
	healthStatus      string
	deployStarted     chan struct{}
	deployStartedOnce sync.Once
	allowDeploy       chan struct{}
	pendingSleeps     map[string]bool
}

func (f *fakeRuntime) ExpectedState() *agenthttp.ExpectedState {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

func (f *fakeRuntime) DeployServerlessContainer(expected agenthttp.ExpectedContainer) error {
	if f.deployStarted != nil {
		f.deployStartedOnce.Do(func() {
			close(f.deployStarted)
		})
	}
	if f.allowDeploy != nil {
		<-f.allowDeploy
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deployCalls += 1
	for i, actual := range f.containers {
		if actual.DeploymentID == expected.DeploymentID {
			f.containers[i].State = "running"
			return nil
		}
	}
	f.containers = append(f.containers, container.Container{
		ID:           "ctr-" + expected.DeploymentID,
		State:        "running",
		DeploymentID: expected.DeploymentID,
		ServiceID:    expected.ServiceID,
	})
	return nil
}

func (f *fakeRuntime) StopServerlessContainer(containerID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopped = append(f.stopped, containerID)
	for i, actual := range f.containers {
		if actual.ID == containerID {
			f.containers[i].State = "exited"
		}
	}
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
	if transition.Type == "sleep" {
		if f.pendingSleeps == nil {
			f.pendingSleeps = map[string]bool{}
		}
		f.pendingSleeps[transition.DeploymentID] = true
	}
	if transition.Type == "wake_started" {
		delete(f.pendingSleeps, transition.DeploymentID)
	}
}

func (f *fakeRuntime) HasPendingServerlessSleep(deploymentID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pendingSleeps[deploymentID]
}

func (f *fakeRuntime) snapshot() ([]agenthttp.ServerlessTransition, []string, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]agenthttp.ServerlessTransition(nil), f.transitions...), append([]string(nil), f.stopped...), f.deployCalls
}

func (f *fakeRuntime) snapshotContainers() []container.Container {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]container.Container(nil), f.containers...)
}

func (f *fakeRuntime) setState(state *agenthttp.ExpectedState, containers []container.Container) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state = state
	f.containers = append([]container.Container(nil), containers...)
}

func useFastWakePolling(t *testing.T) {
	t.Helper()
	previous := wakePollInterval
	wakePollInterval = time.Millisecond
	t.Cleanup(func() { wakePollInterval = previous })
}

func stubUpstreamReadiness(t *testing.T, check func(string) upstreamReadiness) {
	t.Helper()
	previous := checkUpstreamReady
	checkUpstreamReady = check
	t.Cleanup(func() { checkUpstreamReady = previous })
}

func receiveProbe(t *testing.T, probes <-chan string) string {
	t.Helper()
	select {
	case probe := <-probes:
		return probe
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timed out waiting for readiness probe")
		return ""
	}
}

func assertProbeSet(t *testing.T, got []string, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("probes = %+v, want %+v", got, want)
	}
	for _, probe := range want {
		if !slices.Contains(got, probe) {
			t.Fatalf("probes = %+v, want %+v", got, want)
		}
	}
}

func TestServeHTTPRetriesStaleUpstreamForSafeRequest(t *testing.T) {
	var requests atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(backend.Close)

	gateway := testProxyGateway(t, backend.Listener.Addr().String())
	gateway.cacheUpstreams("app.example.com", []agenthttp.ServerlessUpstream{{Url: "127.0.0.1:0"}})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "http://app.example.com/health", nil)
	gateway.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if requests.Load() != 1 {
		t.Fatalf("backend requests = %d, want 1", requests.Load())
	}
}

func TestServeHTTPDoesNotRetryUnsafeRequest(t *testing.T) {
	var requests atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(backend.Close)

	gateway := testProxyGateway(t, backend.Listener.Addr().String())
	gateway.cacheUpstreams("app.example.com", []agenthttp.ServerlessUpstream{{Url: "127.0.0.1:0"}})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "http://app.example.com/items", strings.NewReader("item"))
	gateway.ServeHTTP(response, request)

	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadGateway)
	}
	if requests.Load() != 0 {
		t.Fatalf("backend requests = %d, want 0", requests.Load())
	}
}

func TestServeHTTPDoesNotRetryUpgradeRequest(t *testing.T) {
	var requests atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(backend.Close)

	gateway := testProxyGateway(t, backend.Listener.Addr().String())
	gateway.cacheUpstreams("app.example.com", []agenthttp.ServerlessUpstream{{Url: "127.0.0.1:0"}})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "http://app.example.com/socket", nil)
	request.Header.Set("Connection", "keep-alive, Upgrade")
	request.Header.Set("Upgrade", "websocket")
	gateway.ServeHTTP(response, request)

	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadGateway)
	}
	if requests.Load() != 0 {
		t.Fatalf("backend requests = %d, want 0", requests.Load())
	}
}

func TestServeHTTPDoesNotEvictCacheWhenRequestIsCancelled(t *testing.T) {
	gateway := testProxyGateway(t, "127.0.0.1:0")
	cached := []agenthttp.ServerlessUpstream{{Url: "127.0.0.1:0"}}
	gateway.cacheUpstreams("app.example.com", cached)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "http://app.example.com/", nil).WithContext(ctx)
	gateway.ServeHTTP(httptest.NewRecorder(), request)

	upstreams, ok := gateway.cachedUpstreams("app.example.com")
	if !ok || len(upstreams) != 1 || upstreams[0].Url != cached[0].Url {
		t.Fatalf("cached upstreams = %+v, ok=%t; want original cache entry", upstreams, ok)
	}
}

func TestServeHTTPRetriesOnlyOnce(t *testing.T) {
	retryAddress, accepts := acceptAndCloseAddress(t)
	gateway := testProxyGateway(t, retryAddress)
	gateway.cacheUpstreams("app.example.com", []agenthttp.ServerlessUpstream{{Url: "127.0.0.1:0"}})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "http://app.example.com/", nil)
	gateway.ServeHTTP(response, request)

	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadGateway)
	}
	if _, ok := gateway.cachedUpstreams("app.example.com"); ok {
		t.Fatal("failed retry left upstream cache populated")
	}
	if accepts.Load() != 1 {
		t.Fatalf("retry upstream connections = %d, want 1", accepts.Load())
	}
}

func testProxyGateway(t *testing.T, upstreamAddress string) *Gateway {
	t.Helper()
	host, portText, err := net.SplitHostPort(upstreamAddress)
	if err != nil {
		t.Fatalf("split upstream address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse upstream port: %v", err)
	}
	state := testExpectedState("running")
	state.Containers[0].IPAddress = host
	state.Serverless.Routes[0].Port = port
	state.Serverless.Routes[0].Upstreams = nil
	runtime := &fakeRuntime{
		state: state,
		containers: []container.Container{{
			ID:           "ctr-local",
			State:        "running",
			DeploymentID: "dep_local",
			ServiceID:    "svc_1",
		}},
	}
	return NewGateway(runtime)
}

func acceptAndCloseAddress(t *testing.T) (string, *atomic.Int32) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for closing upstream: %v", err)
	}
	t.Cleanup(func() { listener.Close() })
	var accepts atomic.Int32
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			accepts.Add(1)
			conn.Close()
		}
	}()
	return listener.Addr().String(), &accepts
}

func TestGetUpstreamsReturnsWhenFollowerContextIsCancelled(t *testing.T) {
	state := testExpectedState("stopped")
	g := NewGateway(&fakeRuntime{state: state})
	g.wakeCalls[routeWakeKey(&state.Serverless.Routes[0])] = &wakeCall{done: make(chan struct{})}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := g.getUpstreams(ctx, "app.example.com")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestConcurrentDomainsShareOneWakeAttempt(t *testing.T) {
	state := testExpectedState("stopped")
	state.Serverless.Routes[0].Upstreams = nil
	secondRoute := state.Serverless.Routes[0]
	secondRoute.Domain = "api.example.com"
	state.Serverless.Routes = append(state.Serverless.Routes, secondRoute)
	runtime := &fakeRuntime{
		state:         state,
		deployStarted: make(chan struct{}),
		allowDeploy:   make(chan struct{}),
	}
	gateway := NewGateway(runtime)

	errs := make(chan error, 2)
	go func() {
		_, err := gateway.getUpstreams(context.Background(), "app.example.com")
		errs <- err
	}()
	select {
	case <-runtime.deployStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first wake to start")
	}
	go func() {
		_, err := gateway.getUpstreams(context.Background(), "api.example.com")
		errs <- err
	}()
	time.Sleep(10 * time.Millisecond)
	close(runtime.allowDeploy)

	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("getUpstreams failed: %v", err)
		}
	}
	transitions, _, deployCalls := runtime.snapshot()
	if deployCalls != 1 {
		t.Fatalf("deployCalls = %d, want 1", deployCalls)
	}
	if len(transitions) != 1 || transitions[0].Type != "wake_started" {
		t.Fatalf("transitions = %+v, want one wake_started", transitions)
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
	useFastWakePolling(t)

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

func TestSleepingLocalDeploymentPrefersPublishedLoopbackUpstream(t *testing.T) {
	releaseStatic := make(chan struct{})
	stubUpstreamReadiness(t, func(address string) upstreamReadiness {
		if address == "127.0.0.1:31000" {
			return upstreamReadiness{ready: true}
		}
		<-releaseStatic
		return upstreamReadiness{err: errors.New("connection refused")}
	})
	useFastWakePolling(t)
	t.Cleanup(func() { close(releaseStatic) })

	state := testExpectedState("stopped")
	state.Containers[0].PublishLocalPorts = true
	state.Containers[0].Ports = []agenthttp.PortMapping{
		{ContainerPort: 3000, HostPort: 31000},
	}
	state.Serverless.Routes[0].Upstreams = nil
	runtime := &fakeRuntime{state: state}
	gateway := NewGateway(runtime)

	upstreams, err := gateway.getUpstreams(context.Background(), "app.example.com")
	if err != nil {
		t.Fatalf("getUpstreams failed: %v", err)
	}
	if len(upstreams) != 1 || upstreams[0].Url != "127.0.0.1:31000" {
		t.Fatalf("upstreams = %+v, want loopback upstream", upstreams)
	}
}

func TestSleepingLocalDeploymentFallsBackToStaticIPWhenLoopbackUnreachable(t *testing.T) {
	stubUpstreamReadiness(t, func(address string) upstreamReadiness {
		if address == "10.0.0.10:3000" {
			return upstreamReadiness{ready: true}
		}
		return upstreamReadiness{err: errors.New("connection refused")}
	})
	useFastWakePolling(t)

	state := testExpectedState("stopped")
	state.Containers[0].PublishLocalPorts = true
	state.Containers[0].Ports = []agenthttp.PortMapping{
		{ContainerPort: 3000, HostPort: 31000},
	}
	state.Serverless.Routes[0].Upstreams = nil
	runtime := &fakeRuntime{state: state}
	gateway := NewGateway(runtime)

	upstreams, err := gateway.getUpstreams(context.Background(), "app.example.com")
	if err != nil {
		t.Fatalf("getUpstreams failed: %v", err)
	}
	if len(upstreams) != 1 || upstreams[0].Url != "10.0.0.10:3000" {
		t.Fatalf("upstreams = %+v, want static IP fallback", upstreams)
	}
}

func TestPublishedLoopbackAndStaticIPAreProbedConcurrently(t *testing.T) {
	probes := make(chan string, 2)
	release := make(chan struct{})
	var releaseOnce sync.Once
	stubUpstreamReadiness(t, func(address string) upstreamReadiness {
		probes <- address
		<-release
		return upstreamReadiness{err: errors.New("connection refused")}
	})
	useFastWakePolling(t)
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })

	state := testExpectedState("running")
	state.Containers[0].PublishLocalPorts = true
	state.Containers[0].Ports = []agenthttp.PortMapping{
		{ContainerPort: 3000, HostPort: 31000},
	}
	state.Serverless.Routes[0].Upstreams = nil
	runtime := &fakeRuntime{
		state: state,
		containers: []container.Container{
			{ID: "ctr-local", State: "running", DeploymentID: "dep_local", ServiceID: "svc_1"},
		},
	}
	gateway := NewGateway(runtime)

	done := make(chan struct{})
	go func() {
		_, _ = gateway.inspectUpstreams(&state.Serverless.Routes[0], state)
		close(done)
	}()

	got := []string{receiveProbe(t, probes)}
	select {
	case probe := <-probes:
		got = append(got, probe)
	case <-time.After(100 * time.Millisecond):
		t.Fatalf("only saw probes %+v; want loopback and static IP to start concurrently", got)
	}
	assertProbeSet(t, got, "127.0.0.1:31000", "10.0.0.10:3000")

	releaseOnce.Do(func() { close(release) })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for concurrent probes to finish")
	}
}

func TestPublishedLocalPortsWithoutMatchingHostPortUsesStaticIP(t *testing.T) {
	stubUpstreamReadiness(t, func(address string) upstreamReadiness {
		if address != "10.0.0.10:3000" {
			t.Errorf("checked %s, want only static IP", address)
			return upstreamReadiness{err: errors.New("unexpected upstream")}
		}
		return upstreamReadiness{ready: true}
	})
	useFastWakePolling(t)

	state := testExpectedState("stopped")
	state.Containers[0].PublishLocalPorts = true
	state.Containers[0].Ports = []agenthttp.PortMapping{
		{ContainerPort: 8080, HostPort: 31000},
	}
	state.Serverless.Routes[0].Upstreams = nil
	runtime := &fakeRuntime{state: state}
	gateway := NewGateway(runtime)

	upstreams, err := gateway.getUpstreams(context.Background(), "app.example.com")
	if err != nil {
		t.Fatalf("getUpstreams failed: %v", err)
	}
	if len(upstreams) != 1 || upstreams[0].Url != "10.0.0.10:3000" {
		t.Fatalf("upstreams = %+v, want static IP upstream", upstreams)
	}
}

func TestSleepingLocalDeploymentStartsExistingStoppedContainer(t *testing.T) {
	useFastWakePolling(t)

	state := testExpectedState("stopped")
	state.Serverless.Routes[0].Upstreams = nil
	runtime := &fakeRuntime{
		state: state,
		containers: []container.Container{
			{
				ID:           "ctr-existing",
				State:        "exited",
				DeploymentID: "dep_local",
				ServiceID:    "svc_1",
			},
		},
	}
	gateway := NewGateway(runtime)

	upstreams, err := gateway.getUpstreams(context.Background(), "app.example.com")
	if err != nil {
		t.Fatalf("getUpstreams failed: %v", err)
	}
	if len(upstreams) != 1 || upstreams[0].Url != "10.0.0.10:3000" {
		t.Fatalf("upstreams = %+v, want local upstream", upstreams)
	}

	containers := runtime.snapshotContainers()
	if len(containers) != 1 {
		t.Fatalf("containers = %+v, want existing container only", containers)
	}
	if containers[0].ID != "ctr-existing" || containers[0].State != "running" {
		t.Fatalf("container = %+v, want existing container running", containers[0])
	}
}

func TestSleepServiceStopsLocalContainerAndReportsSleep(t *testing.T) {
	state := testExpectedState("running")
	runtime := &fakeRuntime{
		state: state,
		containers: []container.Container{
			{ID: "ctr-local", State: "running", DeploymentID: "dep_local", ServiceID: "svc_1"},
		},
	}
	gateway := NewGateway(runtime)

	gateway.sleepService("svc_1")

	transitions, stopped, _ := runtime.snapshot()
	if len(stopped) != 1 || stopped[0] != "ctr-local" {
		t.Fatalf("stopped = %+v, want ctr-local", stopped)
	}
	if len(transitions) != 1 {
		t.Fatalf("transitions = %+v, want one sleep transition", transitions)
	}
	if transitions[0].Type != "sleep" || transitions[0].DeploymentID != "dep_local" || transitions[0].ContainerID != "ctr-local" {
		t.Fatalf("transition = %+v, want sleep for dep_local/ctr-local", transitions[0])
	}
}

func TestSleepServiceRechecksActivityBeforeStoppingContainer(t *testing.T) {
	state := testExpectedState("running")
	runtime := &fakeRuntime{
		state: state,
		containers: []container.Container{
			{ID: "ctr-local", State: "running", DeploymentID: "dep_local", ServiceID: "svc_1"},
		},
	}
	gateway := NewGateway(runtime)
	runtime.afterList = func() {
		gateway.beginActivity("svc_1")
	}

	gateway.sleepService("svc_1")

	transitions, stopped, _ := runtime.snapshot()
	if len(stopped) != 0 {
		t.Fatalf("stopped = %+v, want no stops while request is active", stopped)
	}
	if len(transitions) != 0 {
		t.Fatalf("transitions = %+v, want no sleep transition while request is active", transitions)
	}
}

func TestSleepServiceUsesServiceActivityAcrossDomains(t *testing.T) {
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
	gateway.beginActivity("svc_1")

	gateway.sleepService("svc_1")

	transitions, stopped, _ := runtime.snapshot()
	if len(stopped) != 0 {
		t.Fatalf("stopped = %+v, want no stops while sibling domain is active", stopped)
	}
	if len(transitions) != 0 {
		t.Fatalf("transitions = %+v, want no sleep transition while sibling domain is active", transitions)
	}
}

func TestPendingSleepCanWakeBeforeExpectedStateSettles(t *testing.T) {
	state := testExpectedState("running")
	state.Serverless.Routes[0].Upstreams = nil
	runtime := &fakeRuntime{
		state: state,
		containers: []container.Container{
			{ID: "ctr-local", State: "exited", DeploymentID: "dep_local", ServiceID: "svc_1"},
		},
		pendingSleeps: map[string]bool{"dep_local": true},
	}
	gateway := NewGateway(runtime)

	upstreams, err := gateway.getUpstreams(context.Background(), "app.example.com")
	if err != nil {
		t.Fatalf("getUpstreams returned error: %v", err)
	}
	if len(upstreams) != 1 || upstreams[0].DeploymentID != "dep_local" {
		t.Fatalf("upstreams = %+v, want local dep_local", upstreams)
	}

	transitions, _, deployCalls := runtime.snapshot()
	if deployCalls != 1 {
		t.Fatalf("deployCalls = %d, want 1", deployCalls)
	}
	if len(transitions) != 1 || transitions[0].Type != "wake_started" {
		t.Fatalf("transitions = %+v, want one wake_started transition", transitions)
	}
	if runtime.HasPendingServerlessSleep("dep_local") {
		t.Fatal("pending sleep was not cleared by wake_started")
	}
}

func TestBlockingWakeRefreshesRouteAfterRedeploy(t *testing.T) {
	stubUpstreamReadiness(t, func(address string) upstreamReadiness {
		if address == "10.0.0.11:3000" {
			return upstreamReadiness{ready: true}
		}
		return upstreamReadiness{err: errors.New("connection refused")}
	})
	useFastWakePolling(t)

	oldState := testExpectedStateWithLocalDeployment("running", "dep_local", "10.0.0.10")
	oldState.Serverless.Routes[0].Upstreams = nil
	newState := testExpectedStateWithLocalDeployment("running", "dep_new", "10.0.0.11")
	newState.Serverless.Routes[0].Upstreams = nil

	runtime := &fakeRuntime{
		state: oldState,
		containers: []container.Container{
			{ID: "ctr-old", State: "running", DeploymentID: "dep_local", ServiceID: "svc_1"},
		},
	}
	var swapped sync.Once
	runtime.afterList = func() {
		swapped.Do(func() {
			runtime.setState(newState, []container.Container{
				{ID: "ctr-new", State: "running", DeploymentID: "dep_new", ServiceID: "svc_1"},
			})
		})
	}
	gateway := NewGateway(runtime)

	upstreams, err := gateway.waitForReadyUpstreams(&oldState.Serverless.Routes[0], 5, time.Now(), []string{"dep_local"})
	if err != nil {
		t.Fatalf("waitForReadyUpstreams failed: %v", err)
	}
	if len(upstreams) != 1 || upstreams[0].Url != "10.0.0.11:3000" || upstreams[0].DeploymentID != "dep_new" {
		t.Fatalf("upstreams = %+v, want redeployed local upstream", upstreams)
	}
	transitions, _, _ := runtime.snapshot()
	if len(transitions) != 0 {
		t.Fatalf("transitions = %+v, want no stale wake_failed transition", transitions)
	}
}

func TestBlockingWakeReturnsWhenRouteDisappearsDuringRedeploy(t *testing.T) {
	stubUpstreamReadiness(t, func(string) upstreamReadiness {
		return upstreamReadiness{err: errors.New("connection refused")}
	})
	useFastWakePolling(t)

	oldState := testExpectedState("running")
	oldState.Serverless.Routes[0].Upstreams = nil
	newState := testExpectedState("running")
	newState.Serverless.Routes = nil
	runtime := &fakeRuntime{
		state: oldState,
		containers: []container.Container{
			{ID: "ctr-old", State: "running", DeploymentID: "dep_local", ServiceID: "svc_1"},
		},
	}
	var swapped sync.Once
	runtime.afterList = func() {
		swapped.Do(func() {
			runtime.setState(newState, nil)
		})
	}
	gateway := NewGateway(runtime)

	done := make(chan error, 1)
	go func() {
		_, err := gateway.waitForReadyUpstreams(&oldState.Serverless.Routes[0], 5, time.Now(), []string{"dep_local"})
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("waitForReadyUpstreams succeeded, want stale route error")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("timed out waiting for stale route to return")
	}
	transitions, _, _ := runtime.snapshot()
	if len(transitions) != 0 {
		t.Fatalf("transitions = %+v, want no stale wake_failed transition", transitions)
	}
}

func TestWakeMonitorDropsStaleDeploymentAfterRedeploy(t *testing.T) {
	stubUpstreamReadiness(t, func(string) upstreamReadiness {
		return upstreamReadiness{err: errors.New("connection refused")}
	})
	useFastWakePolling(t)

	oldState := testExpectedStateWithLocalDeployment("running", "dep_local", "10.0.0.10")
	oldState.Serverless.Routes[0].Upstreams = nil
	newState := testExpectedStateWithLocalDeployment("running", "dep_new", "10.0.0.11")
	newState.Serverless.Routes[0].Upstreams = nil
	runtime := &fakeRuntime{
		state: oldState,
		containers: []container.Container{
			{ID: "ctr-old", State: "running", DeploymentID: "dep_local", ServiceID: "svc_1"},
		},
	}
	var swapped sync.Once
	runtime.afterList = func() {
		swapped.Do(func() {
			runtime.setState(newState, []container.Container{
				{ID: "ctr-new", State: "running", DeploymentID: "dep_new", ServiceID: "svc_1"},
			})
		})
	}
	gateway := NewGateway(runtime)

	done := make(chan struct{})
	go func() {
		gateway.waitForWokenDeployments(&oldState.Serverless.Routes[0], 5, time.Now(), []string{"dep_local"})
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("timed out waiting for stale wake monitor to return")
	}
	transitions, _, _ := runtime.snapshot()
	if len(transitions) != 0 {
		t.Fatalf("transitions = %+v, want no stale wake_failed transition", transitions)
	}
}

func TestWakeTimeoutQueuesWakeFailedTransition(t *testing.T) {
	useFastWakePolling(t)

	state := testExpectedState("stopped")
	state.Containers[0].HealthCheck = &agenthttp.HealthCheck{
		Cmd: "curl http://localhost:3000/health",
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

func TestWakeTimeoutWhenLocalPortNeverOpens(t *testing.T) {
	stubUpstreamReadiness(t, func(string) upstreamReadiness {
		return upstreamReadiness{err: errors.New("connection refused")}
	})
	useFastWakePolling(t)

	var logs bytes.Buffer
	previousOutput := log.Writer()
	previousFlags := log.Flags()
	log.SetOutput(&logs)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(previousOutput)
		log.SetFlags(previousFlags)
	})

	state := testExpectedState("stopped")
	state.Serverless.Routes[0].Upstreams = nil
	state.Serverless.Routes[0].WakeTimeoutSeconds = 1
	runtime := &fakeRuntime{state: state}
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
	if strings.Contains(logs.String(), "wake waiting") {
		t.Fatalf("log output contains verbose wake waiting logs:\n%s", logs.String())
	}
}

func testExpectedState(localDesiredState string) *agenthttp.ExpectedState {
	state := &agenthttp.ExpectedState{
		Containers: []agenthttp.ExpectedContainer{
			{
				DeploymentID: "dep_local",
				ServiceID:    "svc_1",
				DesiredState: localDesiredState,
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
			LocalDeploymentIDs: []string{"dep_local"},
			Upstreams: []agenthttp.ServerlessUpstream{
				{
					DeploymentID: "dep_worker",
					Url:          "10.0.0.20:3000",
					AlwaysOn:     true,
				},
			},
		},
	}
	return state
}

func testExpectedStateWithLocalDeployment(localDesiredState string, deploymentID string, ipAddress string) *agenthttp.ExpectedState {
	state := testExpectedState(localDesiredState)
	state.Containers[0].DeploymentID = deploymentID
	state.Containers[0].IPAddress = ipAddress
	state.Serverless.Routes[0].LocalDeploymentIDs = []string{deploymentID}
	return state
}
