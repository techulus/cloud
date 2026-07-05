package serverless

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
)

const (
	GatewayPort      = 18080
	upstreamCacheTTL = 10 * time.Second
)

var wakePollInterval = 500 * time.Millisecond

type Gateway struct {
	runtime    Runtime
	counter    uint64
	server     *http.Server
	mu         sync.Mutex
	activityMu sync.Mutex

	upstreamCache map[string]cachedUpstreams
	wakeCalls     map[string]*wakeCall
	activities    map[string]*activityState
}

type Runtime interface {
	ExpectedState() *agenthttp.ExpectedState
	DeployServerlessContainer(agenthttp.ExpectedContainer) error
	RemoveServerlessContainer(containerID string) error
	ListServerlessContainers() ([]container.Container, error)
	GetServerlessContainerHealth(containerID string) string
	QueueServerlessTransition(agenthttp.ServerlessTransition)
}

type cachedUpstreams struct {
	upstreams []agenthttp.ServerlessUpstream
	expiresAt time.Time
}

type wakeCall struct {
	done      chan struct{}
	upstreams []agenthttp.ServerlessUpstream
	err       error
}

type activityState struct {
	mu             sync.Mutex
	activeRequests int
	sleepTimer     *time.Timer
}

func NewGateway(runtime Runtime) *Gateway {
	return &Gateway{
		runtime:       runtime,
		upstreamCache: map[string]cachedUpstreams{},
		wakeCalls:     map[string]*wakeCall{},
		activities:    map[string]*activityState{},
	}
}

func (g *Gateway) Start(ctx context.Context) error {
	addr := fmt.Sprintf("127.0.0.1:%d", GatewayPort)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", addr, err)
	}

	g.server = &http.Server{
		Handler:           g,
		ReadHeaderTimeout: 30 * time.Second,
	}

	go func() {
		<-ctx.Done()
		g.stopAllActivities()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := g.server.Shutdown(shutdownCtx); err != nil {
			log.Printf("[serverless-gateway] shutdown error: %v", err)
		}
	}()

	go func() {
		log.Printf("[serverless-gateway] listening on %s", addr)
		if err := g.server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("[serverless-gateway] server error: %v", err)
		}
	}()

	return nil
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host := normalizeHost(r.Host)
	if host == "" {
		http.Error(w, "missing host", http.StatusBadRequest)
		return
	}

	upstreams, err := g.getUpstreams(r.Context(), host)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return
		}
		log.Printf("[serverless-gateway] wake failed for host %s: %v", host, err)
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}

	if len(upstreams) == 0 {
		log.Printf("[serverless-gateway] no upstreams for host %s", host)
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}

	g.beginActivity(host)
	defer g.endActivity(host)

	upstream := upstreams[g.nextIndex(len(upstreams))]
	target, err := url.Parse("http://" + upstream.Url)
	if err != nil {
		log.Printf("[serverless-gateway] invalid upstream %q for host %s: %v", upstream.Url, host, err)
		http.Error(w, "bad upstream", http.StatusBadGateway)
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	originalHost := r.Host
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = originalHost
		req.Header.Set("X-Forwarded-Host", originalHost)
		req.Header.Set("X-Forwarded-Proto", forwardedProto(r))
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, req *http.Request, err error) {
		log.Printf("[serverless-gateway] proxy error for host %s to %s: %v", host, upstream.Url, err)
		g.evictUpstreams(host)
		http.Error(w, "bad gateway", http.StatusBadGateway)
	}
	proxy.ServeHTTP(w, r)
}

func (g *Gateway) getUpstreams(ctx context.Context, host string) ([]agenthttp.ServerlessUpstream, error) {
	if upstreams, ok := g.cachedUpstreams(host); ok {
		return upstreams, nil
	}

	call, owner := g.beginWake(host)
	if owner {
		go func() {
			upstreams, err := g.resolveUpstreams(host)
			g.finishWake(host, call, upstreams, err)
		}()
	}

	select {
	case <-call.done:
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	if call.err != nil {
		return nil, call.err
	}
	return cloneUpstreams(call.upstreams), nil
}

func (g *Gateway) resolveUpstreams(host string) ([]agenthttp.ServerlessUpstream, error) {
	state := g.runtime.ExpectedState()
	route := findRoute(state, host)
	if route == nil {
		return nil, fmt.Errorf("no serverless route metadata for host %s", host)
	}

	ready, sleepingLocalIDs, err := g.readyUpstreams(route, state)
	if err != nil {
		return nil, err
	}
	if len(sleepingLocalIDs) == 0 {
		if len(ready) > 0 {
			return ready, nil
		}
		return nil, fmt.Errorf("no ready upstreams for host %s", host)
	}

	if len(ready) >= max(1, route.MinReadyReplicas) || (len(ready) > 0 && hasAlwaysOnUpstream(ready)) {
		go g.wakeLocalDeployments(route, state, sleepingLocalIDs)
		return ready, nil
	}

	g.wakeLocalDeployments(route, state, sleepingLocalIDs)
	return g.waitForReadyUpstreams(route, route.WakeTimeoutSeconds)
}

func (g *Gateway) readyUpstreams(route *agenthttp.ServerlessRoute, state *agenthttp.ExpectedState) ([]agenthttp.ServerlessUpstream, []string, error) {
	actualContainers, err := g.runtime.ListServerlessContainers()
	if err != nil {
		return nil, nil, fmt.Errorf("failed to list local containers: %w", err)
	}

	expectedByDeploymentID := expectedContainersByDeploymentID(state)
	actualByDeploymentID := actualContainersByDeploymentID(actualContainers)
	localIDs := map[string]struct{}{}
	for _, deploymentID := range route.LocalDeploymentIDs {
		localIDs[deploymentID] = struct{}{}
	}

	upstreamsByURL := map[string]agenthttp.ServerlessUpstream{}
	for _, upstream := range route.Upstreams {
		if upstream.Local {
			continue
		}
		upstreamsByURL[upstream.Url] = upstream
	}

	sleepingLocalIDs := []string{}
	for _, deploymentID := range route.LocalDeploymentIDs {
		expected, ok := expectedByDeploymentID[deploymentID]
		if !ok {
			continue
		}
		actual, isRunning := actualByDeploymentID[deploymentID]
		if isRunning && g.isContainerReady(actual, expected) {
			if upstream, ok := localUpstream(route, expected); ok {
				upstreamsByURL[upstream.Url] = upstream
			}
			continue
		}
		if expected.DesiredState == "stopped" {
			sleepingLocalIDs = append(sleepingLocalIDs, deploymentID)
		}
	}

	upstreams := make([]agenthttp.ServerlessUpstream, 0, len(upstreamsByURL))
	for _, upstream := range upstreamsByURL {
		if upstream.Local {
			if _, ok := localIDs[upstream.DeploymentID]; !ok {
				continue
			}
		}
		upstreams = append(upstreams, upstream)
	}
	sortUpstreams(upstreams)
	return upstreams, sleepingLocalIDs, nil
}

func (g *Gateway) wakeLocalDeployments(route *agenthttp.ServerlessRoute, state *agenthttp.ExpectedState, deploymentIDs []string) {
	expectedByDeploymentID := expectedContainersByDeploymentID(state)
	for _, deploymentID := range deploymentIDs {
		expected, ok := expectedByDeploymentID[deploymentID]
		if !ok {
			continue
		}
		g.runtime.QueueServerlessTransition(agenthttp.ServerlessTransition{
			Type:         "wake_started",
			DeploymentID: deploymentID,
		})
		if err := g.runtime.DeployServerlessContainer(expected); err != nil {
			log.Printf("[serverless-gateway] wake failed for deployment %s: %v", deploymentID, err)
			g.runtime.QueueServerlessTransition(agenthttp.ServerlessTransition{
				Type:         "wake_failed",
				DeploymentID: deploymentID,
				Error:        err.Error(),
			})
		}
	}
	g.evictUpstreams(route.Domain)
}

func (g *Gateway) waitForReadyUpstreams(route *agenthttp.ServerlessRoute, wakeTimeoutSeconds int) ([]agenthttp.ServerlessUpstream, error) {
	timeout := time.Duration(wakeTimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	deadline := time.Now().Add(timeout)

	for {
		state := g.runtime.ExpectedState()
		ready, sleepingLocalIDs, err := g.readyUpstreams(route, state)
		if err != nil {
			return nil, err
		}
		if len(ready) >= max(1, route.MinReadyReplicas) || (len(ready) > 0 && len(sleepingLocalIDs) == 0) {
			return ready, nil
		}
		if time.Now().After(deadline) {
			if len(ready) > 0 {
				return ready, nil
			}
			return nil, fmt.Errorf("timed out waiting for local serverless wake")
		}
		time.Sleep(wakePollInterval)
	}
}

func (g *Gateway) isContainerReady(actual container.Container, expected agenthttp.ExpectedContainer) bool {
	if actual.State != "running" {
		return false
	}
	if expected.HealthCheck == nil || expected.HealthCheck.Cmd == "" {
		return true
	}
	health := g.runtime.GetServerlessContainerHealth(actual.ID)
	return health == "healthy" || health == "none"
}

func (g *Gateway) cachedUpstreams(host string) ([]agenthttp.ServerlessUpstream, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()

	cached, ok := g.upstreamCache[host]
	if !ok || time.Now().After(cached.expiresAt) {
		if ok {
			delete(g.upstreamCache, host)
		}
		return nil, false
	}

	return cloneUpstreams(cached.upstreams), true
}

func (g *Gateway) beginWake(host string) (*wakeCall, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()

	if call, ok := g.wakeCalls[host]; ok {
		return call, false
	}

	call := &wakeCall{done: make(chan struct{})}
	g.wakeCalls[host] = call
	return call, true
}

func (g *Gateway) finishWake(host string, call *wakeCall, upstreams []agenthttp.ServerlessUpstream, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	call.upstreams = cloneUpstreams(upstreams)
	call.err = err
	if err == nil && len(upstreams) > 0 {
		g.upstreamCache[host] = cachedUpstreams{
			upstreams: cloneUpstreams(upstreams),
			expiresAt: time.Now().Add(upstreamCacheTTL),
		}
	}
	delete(g.wakeCalls, host)
	close(call.done)
}

func (g *Gateway) evictUpstreams(host string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.upstreamCache, host)
}

func (g *Gateway) activity(host string) *activityState {
	g.activityMu.Lock()
	defer g.activityMu.Unlock()

	activity, ok := g.activities[host]
	if !ok {
		activity = &activityState{}
		g.activities[host] = activity
	}
	return activity
}

func (g *Gateway) beginActivity(host string) {
	activity := g.activity(host)
	activity.mu.Lock()
	defer activity.mu.Unlock()

	if activity.sleepTimer != nil {
		activity.sleepTimer.Stop()
		activity.sleepTimer = nil
	}
	activity.activeRequests += 1
}

func (g *Gateway) endActivity(host string) {
	activity := g.activity(host)
	activity.mu.Lock()
	defer activity.mu.Unlock()

	if activity.activeRequests > 0 {
		activity.activeRequests -= 1
	}
	if activity.activeRequests > 0 {
		return
	}

	route := findRoute(g.runtime.ExpectedState(), host)
	if route == nil {
		return
	}
	delay := time.Duration(route.SleepAfterSeconds) * time.Second
	if delay <= 0 {
		delay = 5 * time.Minute
	}
	if activity.sleepTimer != nil {
		activity.sleepTimer.Stop()
	}
	activity.sleepTimer = time.AfterFunc(delay, func() {
		g.sleepHost(host)
	})
}

func (g *Gateway) sleepHost(host string) {
	activity := g.activity(host)
	activity.mu.Lock()
	if activity.activeRequests > 0 {
		activity.mu.Unlock()
		return
	}
	activity.sleepTimer = nil
	activity.mu.Unlock()

	state := g.runtime.ExpectedState()
	route := findRoute(state, host)
	if route == nil {
		return
	}

	actualContainers, err := g.runtime.ListServerlessContainers()
	if err != nil {
		log.Printf("[serverless-gateway] failed to list containers before sleep for %s: %v", host, err)
		return
	}

	expectedByDeploymentID := expectedContainersByDeploymentID(state)
	actualByDeploymentID := actualContainersByDeploymentID(actualContainers)
	for _, deploymentID := range route.LocalDeploymentIDs {
		expected, ok := expectedByDeploymentID[deploymentID]
		if !ok {
			continue
		}
		actual, ok := actualByDeploymentID[deploymentID]
		if !ok || actual.State != "running" {
			continue
		}
		if expected.DesiredState != "stopped" {
			g.runtime.QueueServerlessTransition(agenthttp.ServerlessTransition{
				Type:         "sleep",
				DeploymentID: deploymentID,
				ContainerID:  actual.ID,
			})
		}
		if err := g.runtime.RemoveServerlessContainer(actual.ID); err != nil {
			log.Printf("[serverless-gateway] failed to sleep deployment %s: %v", deploymentID, err)
			continue
		}
	}
	g.evictUpstreams(host)
}

func (g *Gateway) stopAllActivities() {
	g.activityMu.Lock()
	activities := make([]*activityState, 0, len(g.activities))
	for _, activity := range g.activities {
		activities = append(activities, activity)
	}
	g.activityMu.Unlock()

	for _, activity := range activities {
		activity.mu.Lock()
		if activity.sleepTimer != nil {
			activity.sleepTimer.Stop()
			activity.sleepTimer = nil
		}
		activity.mu.Unlock()
	}
}

func findRoute(state *agenthttp.ExpectedState, host string) *agenthttp.ServerlessRoute {
	if state == nil {
		return nil
	}
	normalizedHost := normalizeHost(host)
	for i := range state.Serverless.Routes {
		if normalizeHost(state.Serverless.Routes[i].Domain) == normalizedHost {
			return &state.Serverless.Routes[i]
		}
	}
	return nil
}

func expectedContainersByDeploymentID(state *agenthttp.ExpectedState) map[string]agenthttp.ExpectedContainer {
	containersByDeploymentID := map[string]agenthttp.ExpectedContainer{}
	if state == nil {
		return containersByDeploymentID
	}
	for _, expected := range state.Containers {
		containersByDeploymentID[expected.DeploymentID] = expected
	}
	return containersByDeploymentID
}

func actualContainersByDeploymentID(containers []container.Container) map[string]container.Container {
	containersByDeploymentID := map[string]container.Container{}
	for _, actual := range containers {
		if actual.DeploymentID != "" {
			containersByDeploymentID[actual.DeploymentID] = actual
		}
	}
	return containersByDeploymentID
}

func localUpstream(route *agenthttp.ServerlessRoute, expected agenthttp.ExpectedContainer) (agenthttp.ServerlessUpstream, bool) {
	if expected.IPAddress != "" {
		return agenthttp.ServerlessUpstream{
			DeploymentID: expected.DeploymentID,
			Url:          fmt.Sprintf("%s:%d", expected.IPAddress, route.Port),
			Local:        true,
		}, true
	}

	for _, port := range expected.Ports {
		if port.ContainerPort == route.Port && port.HostPort > 0 {
			return agenthttp.ServerlessUpstream{
				DeploymentID: expected.DeploymentID,
				Url:          fmt.Sprintf("127.0.0.1:%d", port.HostPort),
				Local:        true,
			}, true
		}
	}
	return agenthttp.ServerlessUpstream{}, false
}

func hasAlwaysOnUpstream(upstreams []agenthttp.ServerlessUpstream) bool {
	for _, upstream := range upstreams {
		if upstream.AlwaysOn {
			return true
		}
	}
	return false
}

func sortUpstreams(upstreams []agenthttp.ServerlessUpstream) {
	for i := 0; i < len(upstreams); i++ {
		for j := i + 1; j < len(upstreams); j++ {
			if compareUpstream(upstreams[j], upstreams[i]) < 0 {
				upstreams[i], upstreams[j] = upstreams[j], upstreams[i]
			}
		}
	}
}

func compareUpstream(a, b agenthttp.ServerlessUpstream) int {
	if a.AlwaysOn != b.AlwaysOn {
		if a.AlwaysOn {
			return -1
		}
		return 1
	}
	if a.Local != b.Local {
		if a.Local {
			return -1
		}
		return 1
	}
	return strings.Compare(a.Url, b.Url)
}

func cloneUpstreams(upstreams []agenthttp.ServerlessUpstream) []agenthttp.ServerlessUpstream {
	return append([]agenthttp.ServerlessUpstream(nil), upstreams...)
}

func (g *Gateway) nextIndex(length int) int {
	if length <= 1 {
		return 0
	}
	return int(atomic.AddUint64(&g.counter, 1)-1) % length
}

func normalizeHost(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		return strings.ToLower(strings.TrimSpace(h))
	}
	return strings.ToLower(strings.TrimSpace(host))
}

func forwardedProto(r *http.Request) string {
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		return proto
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}
