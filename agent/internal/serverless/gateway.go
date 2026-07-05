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
	"sort"
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

var (
	wakePollInterval      = 500 * time.Millisecond
	idleTimerSeedInterval = 15 * time.Second
)

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
	StopServerlessContainer(containerID string) error
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

	go func() {
		g.seedIdleTimers()
		ticker := time.NewTicker(idleTimerSeedInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				g.seedIdleTimers()
			}
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

	route := findRoute(g.runtime.ExpectedState(), host)
	if route == nil {
		log.Printf("[serverless-gateway] no route metadata for host %s", host)
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	activityKey := serviceActivityKey(route.ServiceID)
	g.beginActivity(activityKey)
	defer g.endActivity(activityKey, route.ServiceID, route.SleepAfterSeconds)

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

	route := findRoute(g.runtime.ExpectedState(), host)
	if route == nil {
		return nil, fmt.Errorf("no serverless route metadata for host %s", host)
	}
	wakeKey := routeWakeKey(route)
	call, owner := g.beginWake(wakeKey)
	if owner {
		go func() {
			upstreams, err := g.resolveUpstreams(host)
			g.finishWake(wakeKey, call, upstreams, err)
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
	upstreams := cloneUpstreams(call.upstreams)
	if len(upstreams) > 0 {
		g.cacheUpstreams(host, upstreams)
	}
	return upstreams, nil
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

	wakeStartedAt := time.Now()
	if len(ready) >= max(1, route.MinReadyReplicas) || (len(ready) > 0 && hasAlwaysOnUpstream(ready)) {
		log.Printf(
			"[serverless-gateway] wake requested host=%s deployments=%d ready_upstreams=%d mode=background",
			host,
			len(sleepingLocalIDs),
			len(ready),
		)
		go func() {
			startedIDs := g.wakeLocalDeployments(route, state, sleepingLocalIDs)
			if len(startedIDs) > 0 {
				g.waitForWokenDeployments(route, route.WakeTimeoutSeconds, wakeStartedAt, startedIDs)
			}
		}()
		return ready, nil
	}

	log.Printf(
		"[serverless-gateway] wake requested host=%s deployments=%d ready_upstreams=%d mode=blocking timeout=%s",
		host,
		len(sleepingLocalIDs),
		len(ready),
		wakeTimeout(route.WakeTimeoutSeconds),
	)
	startedIDs := g.wakeLocalDeployments(route, state, sleepingLocalIDs)
	if len(startedIDs) == 0 {
		return nil, fmt.Errorf("failed to start local serverless wake")
	}
	return g.waitForReadyUpstreams(route, route.WakeTimeoutSeconds, wakeStartedAt, startedIDs)
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

func (g *Gateway) wakeLocalDeployments(route *agenthttp.ServerlessRoute, state *agenthttp.ExpectedState, deploymentIDs []string) []string {
	expectedByDeploymentID := expectedContainersByDeploymentID(state)
	startedIDs := []string{}
	for _, deploymentID := range deploymentIDs {
		expected, ok := expectedByDeploymentID[deploymentID]
		if !ok {
			log.Printf(
				"[serverless-gateway] wake skipped host=%s deployment=%s reason=missing_expected_state",
				route.Domain,
				deploymentID,
			)
			continue
		}
		deployStartedAt := time.Now()
		log.Printf(
			"[serverless-gateway] wake starting host=%s deployment=%s service=%s container=%s",
			route.Domain,
			deploymentID,
			expected.ServiceID,
			expected.Name,
		)
		g.runtime.QueueServerlessTransition(agenthttp.ServerlessTransition{
			Type:         "wake_started",
			DeploymentID: deploymentID,
		})
		if err := g.runtime.DeployServerlessContainer(expected); err != nil {
			log.Printf(
				"[serverless-gateway] wake failed host=%s deployment=%s service=%s latency=%s error=%v",
				route.Domain,
				deploymentID,
				expected.ServiceID,
				roundDuration(time.Since(deployStartedAt)),
				err,
			)
			g.runtime.QueueServerlessTransition(agenthttp.ServerlessTransition{
				Type:         "wake_failed",
				DeploymentID: deploymentID,
				Error:        err.Error(),
			})
			continue
		}
		startedIDs = append(startedIDs, deploymentID)
		log.Printf(
			"[serverless-gateway] wake container started host=%s deployment=%s service=%s latency=%s",
			route.Domain,
			deploymentID,
			expected.ServiceID,
			roundDuration(time.Since(deployStartedAt)),
		)
	}
	g.evictUpstreams(route.Domain)
	return startedIDs
}

func (g *Gateway) waitForReadyUpstreams(route *agenthttp.ServerlessRoute, wakeTimeoutSeconds int, startedAt time.Time, wokenDeploymentIDs []string) ([]agenthttp.ServerlessUpstream, error) {
	timeout := wakeTimeout(wakeTimeoutSeconds)
	deadline := startedAt.Add(timeout)

	for {
		state := g.runtime.ExpectedState()
		ready, sleepingLocalIDs, err := g.readyUpstreams(route, state)
		if err != nil {
			return nil, err
		}
		if len(ready) >= max(1, route.MinReadyReplicas) || (len(ready) > 0 && len(sleepingLocalIDs) == 0) {
			pendingIDs := pendingWakeDeploymentIDs(wokenDeploymentIDs, ready)
			if len(pendingIDs) > 0 {
				go g.waitForWokenDeployments(route, route.WakeTimeoutSeconds, startedAt, pendingIDs)
			}
			log.Printf(
				"[serverless-gateway] wake ready host=%s upstreams=%d latency=%s",
				route.Domain,
				len(ready),
				roundDuration(time.Since(startedAt)),
			)
			return ready, nil
		}
		if time.Now().After(deadline) {
			pendingIDs := pendingWakeDeploymentIDs(wokenDeploymentIDs, ready)
			g.queueWakeTimeouts(route, pendingIDs, startedAt)
			if len(ready) > 0 {
				log.Printf(
					"[serverless-gateway] wake partially ready host=%s upstreams=%d latency=%s",
					route.Domain,
					len(ready),
					roundDuration(time.Since(startedAt)),
				)
				return ready, nil
			}
			log.Printf(
				"[serverless-gateway] wake timed out host=%s latency=%s",
				route.Domain,
				roundDuration(time.Since(startedAt)),
			)
			return nil, fmt.Errorf("timed out waiting for local serverless wake")
		}
		time.Sleep(wakePollInterval)
	}
}

func (g *Gateway) waitForWokenDeployments(route *agenthttp.ServerlessRoute, wakeTimeoutSeconds int, startedAt time.Time, wokenDeploymentIDs []string) {
	timeout := wakeTimeout(wakeTimeoutSeconds)
	deadline := startedAt.Add(timeout)

	for {
		state := g.runtime.ExpectedState()
		ready, _, err := g.readyUpstreams(route, state)
		if err != nil {
			log.Printf("[serverless-gateway] wake monitor failed host=%s error=%v", route.Domain, err)
			return
		}
		pendingIDs := pendingWakeDeploymentIDs(wokenDeploymentIDs, ready)
		if len(pendingIDs) == 0 {
			log.Printf(
				"[serverless-gateway] wake ready host=%s deployments=%d latency=%s",
				route.Domain,
				len(wokenDeploymentIDs),
				roundDuration(time.Since(startedAt)),
			)
			return
		}
		if time.Now().After(deadline) {
			g.queueWakeTimeouts(route, pendingIDs, startedAt)
			return
		}
		time.Sleep(wakePollInterval)
	}
}

func pendingWakeDeploymentIDs(wokenDeploymentIDs []string, ready []agenthttp.ServerlessUpstream) []string {
	readyIDs := map[string]struct{}{}
	for _, upstream := range ready {
		if upstream.Local {
			readyIDs[upstream.DeploymentID] = struct{}{}
		}
	}

	pendingIDs := []string{}
	for _, deploymentID := range wokenDeploymentIDs {
		if _, ok := readyIDs[deploymentID]; !ok {
			pendingIDs = append(pendingIDs, deploymentID)
		}
	}
	return pendingIDs
}

func (g *Gateway) queueWakeTimeouts(route *agenthttp.ServerlessRoute, deploymentIDs []string, startedAt time.Time) {
	for _, deploymentID := range deploymentIDs {
		errMessage := fmt.Sprintf("timed out waiting %s for local serverless wake", roundDuration(time.Since(startedAt)))
		log.Printf(
			"[serverless-gateway] wake timed out host=%s deployment=%s service=%s latency=%s",
			route.Domain,
			deploymentID,
			route.ServiceID,
			roundDuration(time.Since(startedAt)),
		)
		g.runtime.QueueServerlessTransition(agenthttp.ServerlessTransition{
			Type:         "wake_failed",
			DeploymentID: deploymentID,
			Error:        errMessage,
		})
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

func (g *Gateway) beginWake(wakeKey string) (*wakeCall, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()

	if call, ok := g.wakeCalls[wakeKey]; ok {
		return call, false
	}

	call := &wakeCall{done: make(chan struct{})}
	g.wakeCalls[wakeKey] = call
	return call, true
}

func (g *Gateway) finishWake(wakeKey string, call *wakeCall, upstreams []agenthttp.ServerlessUpstream, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	call.upstreams = cloneUpstreams(upstreams)
	call.err = err
	delete(g.wakeCalls, wakeKey)
	close(call.done)
}

func (g *Gateway) cacheUpstreams(host string, upstreams []agenthttp.ServerlessUpstream) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.upstreamCache[host] = cachedUpstreams{
		upstreams: cloneUpstreams(upstreams),
		expiresAt: time.Now().Add(upstreamCacheTTL),
	}
}

func (g *Gateway) evictUpstreams(host string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.upstreamCache, host)
}

func (g *Gateway) evictServiceUpstreams(serviceID string) {
	state := g.runtime.ExpectedState()
	g.mu.Lock()
	defer g.mu.Unlock()
	if state == nil {
		g.upstreamCache = map[string]cachedUpstreams{}
		return
	}
	for _, route := range state.Serverless.Routes {
		if route.ServiceID == serviceID {
			delete(g.upstreamCache, normalizeHost(route.Domain))
		}
	}
}

func (g *Gateway) seedIdleTimers() {
	state := g.runtime.ExpectedState()
	if state == nil {
		return
	}
	actualContainers, err := g.runtime.ListServerlessContainers()
	if err != nil {
		log.Printf("[serverless-gateway] failed to seed idle timers: %v", err)
		return
	}
	actualByDeploymentID := actualContainersByDeploymentID(actualContainers)
	seenServices := map[string]struct{}{}
	for _, route := range state.Serverless.Routes {
		if _, seen := seenServices[route.ServiceID]; seen {
			continue
		}
		seenServices[route.ServiceID] = struct{}{}
		if !hasRunningLocalDeployment(route.LocalDeploymentIDs, actualByDeploymentID) {
			continue
		}
		g.scheduleSleepTimer(serviceActivityKey(route.ServiceID), route.ServiceID, route.SleepAfterSeconds)
	}
}

func (g *Gateway) scheduleSleepTimer(key string, serviceID string, sleepAfterSeconds int) {
	activity := g.activity(key)
	activity.mu.Lock()
	defer activity.mu.Unlock()
	if activity.activeRequests > 0 || activity.sleepTimer != nil {
		return
	}
	delay := sleepDelay(sleepAfterSeconds)
	activity.sleepTimer = time.AfterFunc(delay, func() {
		g.sleepService(serviceID)
	})
}

func (g *Gateway) activity(key string) *activityState {
	g.activityMu.Lock()
	defer g.activityMu.Unlock()

	activity, ok := g.activities[key]
	if !ok {
		activity = &activityState{}
		g.activities[key] = activity
	}
	return activity
}

func (g *Gateway) beginActivity(key string) {
	activity := g.activity(key)
	activity.mu.Lock()
	defer activity.mu.Unlock()

	if activity.sleepTimer != nil {
		activity.sleepTimer.Stop()
		activity.sleepTimer = nil
	}
	activity.activeRequests += 1
}

func (g *Gateway) endActivity(key string, serviceID string, sleepAfterSeconds int) {
	activity := g.activity(key)
	activity.mu.Lock()
	defer activity.mu.Unlock()

	if activity.activeRequests > 0 {
		activity.activeRequests -= 1
	}
	if activity.activeRequests > 0 {
		return
	}

	if activity.sleepTimer != nil {
		activity.sleepTimer.Stop()
	}
	delay := sleepDelay(sleepAfterSeconds)
	activity.sleepTimer = time.AfterFunc(delay, func() {
		g.sleepService(serviceID)
	})
}

func (g *Gateway) sleepHost(host string) {
	route := findRoute(g.runtime.ExpectedState(), host)
	if route == nil {
		log.Printf("[serverless-gateway] sleep skipped host=%s reason=missing_route_metadata", host)
		return
	}
	g.sleepService(route.ServiceID)
}

func (g *Gateway) sleepService(serviceID string) {
	activityKey := serviceActivityKey(serviceID)
	activity := g.activity(activityKey)
	activity.mu.Lock()
	if activity.activeRequests > 0 {
		activeRequests := activity.activeRequests
		activity.mu.Unlock()
		log.Printf(
			"[serverless-gateway] sleep skipped service=%s reason=active_requests active=%d",
			serviceID,
			activeRequests,
		)
		return
	}
	activity.sleepTimer = nil
	activity.mu.Unlock()

	state := g.runtime.ExpectedState()
	route := findRouteByServiceID(state, serviceID)
	if route == nil {
		log.Printf("[serverless-gateway] sleep skipped service=%s reason=missing_route_metadata", serviceID)
		return
	}
	localDeploymentIDs := localDeploymentIDsForService(state, serviceID)
	log.Printf(
		"[serverless-gateway] sleep timer fired service=%s deployments=%d",
		serviceID,
		len(localDeploymentIDs),
	)

	actualContainers, err := g.runtime.ListServerlessContainers()
	if err != nil {
		log.Printf("[serverless-gateway] failed to list containers before sleep for service %s: %v", serviceID, err)
		return
	}

	expectedByDeploymentID := expectedContainersByDeploymentID(state)
	actualByDeploymentID := actualContainersByDeploymentID(actualContainers)
	for _, deploymentID := range localDeploymentIDs {
		expected, ok := expectedByDeploymentID[deploymentID]
		if !ok {
			log.Printf(
				"[serverless-gateway] sleep skipped service=%s deployment=%s reason=missing_expected_state",
				serviceID,
				deploymentID,
			)
			continue
		}
		actual, ok := actualByDeploymentID[deploymentID]
		if !ok || actual.State != "running" {
			reason := "no_local_container"
			if ok {
				reason = "container_not_running"
			}
			log.Printf(
				"[serverless-gateway] sleep skipped service=%s deployment=%s reason=%s",
				serviceID,
				deploymentID,
				reason,
			)
			continue
		}
		if expected.DesiredState != "stopped" && !g.isContainerReady(actual, expected) {
			log.Printf(
				"[serverless-gateway] sleep skipped service=%s deployment=%s reason=container_not_ready",
				serviceID,
				deploymentID,
			)
			continue
		}

		activity.mu.Lock()
		if activity.activeRequests > 0 {
			activeRequests := activity.activeRequests
			activity.mu.Unlock()
			log.Printf(
				"[serverless-gateway] sleep skipped service=%s deployment=%s reason=active_requests active=%d",
				serviceID,
				deploymentID,
				activeRequests,
			)
			return
		}
		sleepStartedAt := time.Now()
		if expected.DesiredState != "stopped" {
			log.Printf(
				"[serverless-gateway] sleep starting service=%s deployment=%s container=%s",
				serviceID,
				deploymentID,
				actual.ID,
			)
			g.runtime.QueueServerlessTransition(agenthttp.ServerlessTransition{
				Type:         "sleep",
				DeploymentID: deploymentID,
				ContainerID:  actual.ID,
			})
		} else {
			log.Printf(
				"[serverless-gateway] sleep stop starting service=%s deployment=%s container=%s reason=already_expected_stopped",
				serviceID,
				deploymentID,
				actual.ID,
			)
		}
		if err := g.runtime.StopServerlessContainer(actual.ID); err != nil {
			activity.mu.Unlock()
			log.Printf(
				"[serverless-gateway] sleep failed service=%s deployment=%s container=%s latency=%s error=%v",
				serviceID,
				deploymentID,
				actual.ID,
				roundDuration(time.Since(sleepStartedAt)),
				err,
			)
			continue
		}
		g.evictServiceUpstreams(serviceID)
		activity.mu.Unlock()
		log.Printf(
			"[serverless-gateway] sleep complete service=%s deployment=%s container=%s latency=%s",
			serviceID,
			deploymentID,
			actual.ID,
			roundDuration(time.Since(sleepStartedAt)),
		)
	}
	g.evictServiceUpstreams(serviceID)
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

func findRouteByServiceID(state *agenthttp.ExpectedState, serviceID string) *agenthttp.ServerlessRoute {
	if state == nil {
		return nil
	}
	for i := range state.Serverless.Routes {
		if state.Serverless.Routes[i].ServiceID == serviceID {
			return &state.Serverless.Routes[i]
		}
	}
	return nil
}

func localDeploymentIDsForService(state *agenthttp.ExpectedState, serviceID string) []string {
	if state == nil {
		return nil
	}
	ids := map[string]struct{}{}
	for _, route := range state.Serverless.Routes {
		if route.ServiceID != serviceID {
			continue
		}
		for _, deploymentID := range route.LocalDeploymentIDs {
			ids[deploymentID] = struct{}{}
		}
	}
	deploymentIDs := make([]string, 0, len(ids))
	for deploymentID := range ids {
		deploymentIDs = append(deploymentIDs, deploymentID)
	}
	sort.Strings(deploymentIDs)
	return deploymentIDs
}

func routeWakeKey(route *agenthttp.ServerlessRoute) string {
	deploymentIDs := append([]string(nil), route.LocalDeploymentIDs...)
	sort.Strings(deploymentIDs)
	return fmt.Sprintf(
		"%s:%d:%s",
		route.ServiceID,
		route.Port,
		strings.Join(deploymentIDs, ","),
	)
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

func hasRunningLocalDeployment(deploymentIDs []string, actualByDeploymentID map[string]container.Container) bool {
	for _, deploymentID := range deploymentIDs {
		if actual, ok := actualByDeploymentID[deploymentID]; ok && actual.State == "running" {
			return true
		}
	}
	return false
}

func sortUpstreams(upstreams []agenthttp.ServerlessUpstream) {
	sort.Slice(upstreams, func(i, j int) bool {
		return compareUpstream(upstreams[i], upstreams[j]) < 0
	})
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

func wakeTimeout(wakeTimeoutSeconds int) time.Duration {
	timeout := time.Duration(wakeTimeoutSeconds) * time.Second
	if timeout <= 0 {
		return 5 * time.Minute
	}
	return timeout
}

func sleepDelay(sleepAfterSeconds int) time.Duration {
	delay := time.Duration(sleepAfterSeconds) * time.Second
	if delay <= 0 {
		return 5 * time.Minute
	}
	return delay
}

func serviceActivityKey(serviceID string) string {
	return "service:" + serviceID
}

func roundDuration(duration time.Duration) time.Duration {
	return duration.Round(time.Millisecond)
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
