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
	GatewayPort              = 18080
	upstreamCacheTTL         = 10 * time.Second
	proxyRetryResolveTimeout = 2 * time.Second
)

var (
	wakePollInterval      = 500 * time.Millisecond
	idleTimerSeedInterval = 15 * time.Second
	upstreamDialTimeout   = 250 * time.Millisecond
	checkUpstreamReady    = tcpUpstreamReady
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
	HasPendingServerlessSleep(deploymentID string) bool
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

type upstreamReadiness struct {
	ready   bool
	latency time.Duration
	err     error
}

type upstreamResolution struct {
	ready            []agenthttp.ServerlessUpstream
	sleepingLocalIDs []string
	waiting          []upstreamWaitReason
}

type upstreamWaitReason struct {
	deploymentID string
	serviceID    string
	containerID  string
	upstreamURL  string
	reason       string
	state        string
	health       string
	dialLatency  time.Duration
	err          error
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
	activityKey := route.ServiceID
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
	proxyErr := g.proxyOnce(w, r, upstream)
	if proxyErr == nil {
		return
	}
	if requestCancelled(r, proxyErr) {
		return
	}

	log.Printf("[serverless-gateway] proxy error for host %s to %s: %v", host, upstream.Url, proxyErr)
	g.evictUpstreams(host)
	if !retryableProxyRequest(r) {
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}

	retryCtx, cancel := context.WithTimeout(r.Context(), proxyRetryResolveTimeout)
	defer cancel()
	retryUpstreams, err := g.getUpstreams(retryCtx, host)
	if err != nil || len(retryUpstreams) == 0 {
		if r.Context().Err() != nil {
			return
		}
		if err == nil {
			err = errors.New("no upstreams after cache eviction")
		}
		log.Printf("[serverless-gateway] proxy retry resolution failed for host %s: %v", host, err)
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}

	retryUpstream := selectRetryUpstream(retryUpstreams, upstream.Url, g.nextIndex(len(retryUpstreams)))
	proxyErr = g.proxyOnce(w, r, retryUpstream)
	if proxyErr == nil || requestCancelled(r, proxyErr) {
		return
	}
	log.Printf("[serverless-gateway] proxy retry failed for host %s to %s: %v", host, retryUpstream.Url, proxyErr)
	g.evictUpstreams(host)
	http.Error(w, "bad gateway", http.StatusBadGateway)
}

func (g *Gateway) proxyOnce(w http.ResponseWriter, r *http.Request, upstream agenthttp.ServerlessUpstream) error {
	target, err := url.Parse("http://" + upstream.Url)
	if err != nil {
		return fmt.Errorf("invalid upstream %q: %w", upstream.Url, err)
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	originalHost := r.Host
	originalProto := forwardedProto(r)
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = originalHost
		req.Header.Set("X-Forwarded-Host", originalHost)
		req.Header.Set("X-Forwarded-Proto", originalProto)
	}
	var proxyErr error
	proxy.ErrorHandler = func(_ http.ResponseWriter, _ *http.Request, err error) {
		proxyErr = err
	}
	proxy.ServeHTTP(w, r)
	return proxyErr
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

	resolution, err := g.inspectUpstreams(route, state)
	if err != nil {
		return nil, err
	}
	ready := resolution.ready
	sleepingLocalIDs := resolution.sleepingLocalIDs
	if len(sleepingLocalIDs) == 0 {
		if len(ready) > 0 {
			return ready, nil
		}
		return nil, fmt.Errorf("no ready upstreams for host %s", host)
	}

	wakeStartedAt := time.Now()
	if len(ready) > 0 {
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

func (g *Gateway) inspectUpstreams(route *agenthttp.ServerlessRoute, state *agenthttp.ExpectedState) (upstreamResolution, error) {
	actualContainers, err := g.runtime.ListServerlessContainers()
	if err != nil {
		return upstreamResolution{}, fmt.Errorf("failed to list local containers: %w", err)
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

	resolution := upstreamResolution{}
	for _, deploymentID := range route.LocalDeploymentIDs {
		expected, ok := expectedByDeploymentID[deploymentID]
		if !ok {
			resolution.waiting = append(resolution.waiting, upstreamWaitReason{
				deploymentID: deploymentID,
				serviceID:    route.ServiceID,
				reason:       "missing_expected_state",
			})
			continue
		}
		actual, exists := actualByDeploymentID[deploymentID]
		if exists && actual.State == "running" {
			ready, waitReason := g.containerReady(actual, expected)
			if !ready {
				resolution.waiting = append(resolution.waiting, waitReason)
				continue
			}
			upstreams := localUpstreamCandidates(route, expected)
			if len(upstreams) > 0 {
				upstream, waitReasons, upstreamReady := probeLocalUpstreams(upstreams, expected, actual)
				if upstreamReady {
					upstreamsByURL[upstream.Url] = upstream
				} else {
					resolution.waiting = append(resolution.waiting, waitReasons...)
				}
			} else {
				resolution.waiting = append(resolution.waiting, upstreamWaitReason{
					deploymentID: expected.DeploymentID,
					serviceID:    expected.ServiceID,
					containerID:  actual.ID,
					reason:       "missing_local_upstream",
					state:        actual.State,
				})
			}
			continue
		}
		if expected.DesiredState == "stopped" || g.runtime.HasPendingServerlessSleep(deploymentID) {
			resolution.sleepingLocalIDs = append(resolution.sleepingLocalIDs, deploymentID)
			resolution.waiting = append(resolution.waiting, upstreamWaitReason{
				deploymentID: expected.DeploymentID,
				serviceID:    expected.ServiceID,
				reason:       "sleeping",
				state:        containerState(actual, exists),
			})
			continue
		}
		resolution.waiting = append(resolution.waiting, upstreamWaitReason{
			deploymentID: expected.DeploymentID,
			serviceID:    expected.ServiceID,
			reason:       "container_not_running",
			state:        containerState(actual, exists),
		})
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
	resolution.ready = upstreams
	return resolution, nil
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
	domain := route.Domain
	timeout := wakeTimeout(wakeTimeoutSeconds)
	deadline := startedAt.Add(timeout)
	attempt := 0

	for {
		attempt++
		state := g.runtime.ExpectedState()
		currentRoute := findRoute(state, domain)
		if currentRoute == nil {
			log.Printf(
				"[serverless-gateway] wake stale host=%s reason=route_missing attempts=%d latency=%s",
				domain,
				attempt,
				roundDuration(time.Since(startedAt)),
			)
			return nil, fmt.Errorf("serverless route changed during wake")
		}
		route = currentRoute
		currentWokenIDs := currentWakeDeploymentIDs(route, state, wokenDeploymentIDs)
		resolution, err := g.inspectUpstreams(route, state)
		if err != nil {
			return nil, err
		}
		ready := resolution.ready
		if len(ready) > 0 {
			pendingIDs := pendingWakeDeploymentIDs(currentWokenIDs, ready)
			if len(pendingIDs) > 0 {
				go g.waitForWokenDeployments(route, route.WakeTimeoutSeconds, startedAt, pendingIDs)
			}
			logWakeReady(route, ready, attempt, startedAt)
			return ready, nil
		}
		if len(currentWokenIDs) == 0 {
			log.Printf(
				"[serverless-gateway] wake stale host=%s reason=deployments_replaced attempts=%d latency=%s",
				domain,
				attempt,
				roundDuration(time.Since(startedAt)),
			)
			return nil, fmt.Errorf("serverless route changed during wake")
		}
		waitSummary := summarizeWaitReasons(filterWaitReasons(resolution.waiting, currentWokenIDs))
		if time.Now().After(deadline) {
			pendingIDs := pendingWakeDeploymentIDs(currentWokenIDs, ready)
			g.queueWakeTimeouts(route, pendingIDs, startedAt, waitSummary)
			log.Printf(
				"[serverless-gateway] wake timed out host=%s attempts=%d latency=%s last_wait=%q",
				route.Domain,
				attempt,
				roundDuration(time.Since(startedAt)),
				waitSummary,
			)
			return nil, fmt.Errorf("timed out waiting for local serverless wake")
		}
		time.Sleep(wakePollInterval)
	}
}

func (g *Gateway) waitForWokenDeployments(route *agenthttp.ServerlessRoute, wakeTimeoutSeconds int, startedAt time.Time, wokenDeploymentIDs []string) {
	domain := route.Domain
	timeout := wakeTimeout(wakeTimeoutSeconds)
	deadline := startedAt.Add(timeout)
	attempt := 0

	for {
		attempt++
		state := g.runtime.ExpectedState()
		currentRoute := findRoute(state, domain)
		if currentRoute == nil {
			log.Printf(
				"[serverless-gateway] wake monitor stale host=%s reason=route_missing attempts=%d latency=%s",
				domain,
				attempt,
				roundDuration(time.Since(startedAt)),
			)
			return
		}
		route = currentRoute
		currentWokenIDs := currentWakeDeploymentIDs(route, state, wokenDeploymentIDs)
		if len(currentWokenIDs) == 0 {
			log.Printf(
				"[serverless-gateway] wake monitor stale host=%s reason=deployments_replaced attempts=%d latency=%s",
				domain,
				attempt,
				roundDuration(time.Since(startedAt)),
			)
			return
		}
		resolution, err := g.inspectUpstreams(route, state)
		if err != nil {
			log.Printf("[serverless-gateway] wake monitor failed host=%s error=%v", route.Domain, err)
			return
		}
		ready := resolution.ready
		pendingIDs := pendingWakeDeploymentIDs(currentWokenIDs, ready)
		if len(pendingIDs) == 0 {
			logWakeReadyDeployments(route, ready, len(currentWokenIDs), attempt, startedAt)
			return
		}
		waitSummary := summarizeWaitReasons(filterWaitReasons(resolution.waiting, pendingIDs))
		if time.Now().After(deadline) {
			g.queueWakeTimeouts(route, pendingIDs, startedAt, waitSummary)
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

func filterWaitReasons(reasons []upstreamWaitReason, deploymentIDs []string) []upstreamWaitReason {
	if len(reasons) == 0 || len(deploymentIDs) == 0 {
		return nil
	}
	pending := map[string]struct{}{}
	for _, deploymentID := range deploymentIDs {
		pending[deploymentID] = struct{}{}
	}
	filtered := []upstreamWaitReason{}
	for _, reason := range reasons {
		if _, ok := pending[reason.deploymentID]; ok {
			filtered = append(filtered, reason)
		}
	}
	return filtered
}

func currentWakeDeploymentIDs(route *agenthttp.ServerlessRoute, state *agenthttp.ExpectedState, deploymentIDs []string) []string {
	if route == nil || len(deploymentIDs) == 0 {
		return nil
	}

	expectedByDeploymentID := expectedContainersByDeploymentID(state)
	routeIDs := map[string]struct{}{}
	for _, deploymentID := range route.LocalDeploymentIDs {
		routeIDs[deploymentID] = struct{}{}
	}

	currentIDs := []string{}
	for _, deploymentID := range deploymentIDs {
		if _, ok := routeIDs[deploymentID]; !ok {
			continue
		}
		if _, ok := expectedByDeploymentID[deploymentID]; !ok {
			continue
		}
		currentIDs = append(currentIDs, deploymentID)
	}
	return currentIDs
}

func logWakeReady(route *agenthttp.ServerlessRoute, ready []agenthttp.ServerlessUpstream, attempt int, startedAt time.Time) {
	fields := []string{
		fmt.Sprintf("host=%s", route.Domain),
		fmt.Sprintf("upstreams=%d", len(ready)),
	}
	if localUpstreams := formatLocalUpstreamURLs(ready); localUpstreams != "" {
		fields = append(fields, fmt.Sprintf("local_upstreams=%s", localUpstreams))
	}
	fields = append(fields,
		fmt.Sprintf("attempts=%d", attempt),
		fmt.Sprintf("latency=%s", roundDuration(time.Since(startedAt))),
	)
	log.Printf("[serverless-gateway] wake ready %s", strings.Join(fields, " "))
}

func logWakeReadyDeployments(route *agenthttp.ServerlessRoute, ready []agenthttp.ServerlessUpstream, deployments int, attempt int, startedAt time.Time) {
	fields := []string{
		fmt.Sprintf("host=%s", route.Domain),
		fmt.Sprintf("deployments=%d", deployments),
	}
	if localUpstreams := formatLocalUpstreamURLs(ready); localUpstreams != "" {
		fields = append(fields, fmt.Sprintf("local_upstreams=%s", localUpstreams))
	}
	fields = append(fields,
		fmt.Sprintf("attempts=%d", attempt),
		fmt.Sprintf("latency=%s", roundDuration(time.Since(startedAt))),
	)
	log.Printf("[serverless-gateway] wake ready %s", strings.Join(fields, " "))
}

func formatLocalUpstreamURLs(upstreams []agenthttp.ServerlessUpstream) string {
	urls := []string{}
	for _, upstream := range upstreams {
		if upstream.Local {
			urls = append(urls, upstream.Url)
		}
	}
	sort.Strings(urls)
	return strings.Join(urls, ",")
}

func summarizeWaitReasons(reasons []upstreamWaitReason) string {
	if len(reasons) == 0 {
		return ""
	}
	parts := make([]string, 0, len(reasons))
	for _, reason := range reasons {
		part := fmt.Sprintf("deployment=%s reason=%s", reason.deploymentID, reason.reason)
		if reason.upstreamURL != "" {
			part += fmt.Sprintf(" upstream=%s", reason.upstreamURL)
		}
		if reason.state != "" {
			part += fmt.Sprintf(" state=%s", reason.state)
		}
		if reason.health != "" {
			part += fmt.Sprintf(" health=%s", reason.health)
		}
		if reason.dialLatency > 0 {
			part += fmt.Sprintf(" dial_latency=%s", roundDuration(reason.dialLatency))
		}
		if reason.err != nil {
			part += fmt.Sprintf(" error=%q", compactError(reason.err))
		}
		parts = append(parts, part)
	}
	sort.Strings(parts)
	return strings.Join(parts, "; ")
}

func compactError(err error) string {
	if err == nil {
		return ""
	}
	message := strings.TrimSpace(err.Error())
	if len(message) <= 240 {
		return message
	}
	return message[:240] + "..."
}

func (g *Gateway) queueWakeTimeouts(route *agenthttp.ServerlessRoute, deploymentIDs []string, startedAt time.Time, waitSummary string) {
	for _, deploymentID := range deploymentIDs {
		errMessage := fmt.Sprintf("timed out waiting %s for local serverless wake", roundDuration(time.Since(startedAt)))
		if waitSummary != "" {
			errMessage = fmt.Sprintf("%s; last wait: %s", errMessage, waitSummary)
		}
		log.Printf(
			"[serverless-gateway] wake timed out host=%s deployment=%s service=%s latency=%s last_wait=%q",
			route.Domain,
			deploymentID,
			route.ServiceID,
			roundDuration(time.Since(startedAt)),
			waitSummary,
		)
		g.runtime.QueueServerlessTransition(agenthttp.ServerlessTransition{
			Type:         "wake_failed",
			DeploymentID: deploymentID,
			Error:        errMessage,
		})
	}
}

func (g *Gateway) containerReady(actual container.Container, expected agenthttp.ExpectedContainer) (bool, upstreamWaitReason) {
	if actual.State != "running" {
		return false, upstreamWaitReason{
			deploymentID: expected.DeploymentID,
			serviceID:    expected.ServiceID,
			containerID:  actual.ID,
			reason:       "container_not_running",
			state:        actual.State,
		}
	}
	if expected.HealthCheck == nil || expected.HealthCheck.Cmd == "" {
		return true, upstreamWaitReason{}
	}
	health := g.runtime.GetServerlessContainerHealth(actual.ID)
	if health == "healthy" || health == "none" {
		return true, upstreamWaitReason{}
	}
	return false, upstreamWaitReason{
		deploymentID: expected.DeploymentID,
		serviceID:    expected.ServiceID,
		containerID:  actual.ID,
		reason:       "health_not_ready",
		state:        actual.State,
		health:       health,
	}
}

func tcpUpstreamReady(address string) upstreamReadiness {
	startedAt := time.Now()
	conn, err := net.DialTimeout("tcp", address, upstreamDialTimeout)
	if err != nil {
		return upstreamReadiness{
			latency: time.Since(startedAt),
			err:     err,
		}
	}
	conn.Close()
	return upstreamReadiness{
		ready:   true,
		latency: time.Since(startedAt),
	}
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
		g.scheduleSleepTimer(route.ServiceID, route.ServiceID, route.SleepAfterSeconds)
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

func (g *Gateway) sleepService(serviceID string) {
	activity := g.activity(serviceID)
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
		containerReady, _ := g.containerReady(actual, expected)
		if expected.DesiredState != "stopped" && !containerReady {
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

func containerState(actual container.Container, exists bool) string {
	if !exists {
		return "missing"
	}
	if actual.State == "" {
		return "unknown"
	}
	return actual.State
}

func localUpstreamCandidates(route *agenthttp.ServerlessRoute, expected agenthttp.ExpectedContainer) []agenthttp.ServerlessUpstream {
	upstreams := []agenthttp.ServerlessUpstream{}
	if expected.PublishLocalPorts {
		upstreams = append(upstreams, localLoopbackUpstreams(route, expected)...)
	}
	if expected.IPAddress != "" {
		upstreams = append(upstreams, agenthttp.ServerlessUpstream{
			DeploymentID: expected.DeploymentID,
			Url:          fmt.Sprintf("%s:%d", expected.IPAddress, route.Port),
			Local:        true,
		})
	}
	if expected.IPAddress == "" && !expected.PublishLocalPorts {
		upstreams = append(upstreams, localLoopbackUpstreams(route, expected)...)
	}
	return upstreams
}

func localLoopbackUpstreams(route *agenthttp.ServerlessRoute, expected agenthttp.ExpectedContainer) []agenthttp.ServerlessUpstream {
	upstreams := []agenthttp.ServerlessUpstream{}
	for _, port := range expected.Ports {
		if port.ContainerPort == route.Port && port.HostPort > 0 {
			upstreams = append(upstreams, agenthttp.ServerlessUpstream{
				DeploymentID: expected.DeploymentID,
				Url:          fmt.Sprintf("127.0.0.1:%d", port.HostPort),
				Local:        true,
			})
		}
	}
	return upstreams
}

type upstreamProbeResult struct {
	upstream  agenthttp.ServerlessUpstream
	readiness upstreamReadiness
}

func probeLocalUpstreams(upstreams []agenthttp.ServerlessUpstream, expected agenthttp.ExpectedContainer, actual container.Container) (agenthttp.ServerlessUpstream, []upstreamWaitReason, bool) {
	if len(upstreams) == 0 {
		return agenthttp.ServerlessUpstream{}, nil, false
	}

	check := checkUpstreamReady
	results := make(chan upstreamProbeResult, len(upstreams))
	for _, upstream := range upstreams {
		upstream := upstream
		go func() {
			results <- upstreamProbeResult{
				upstream:  upstream,
				readiness: check(upstream.Url),
			}
		}()
	}

	waitReasons := make([]upstreamWaitReason, 0, len(upstreams))
	for range upstreams {
		result := <-results
		if result.readiness.ready {
			return result.upstream, nil, true
		}
		waitReasons = append(waitReasons, upstreamWaitReason{
			deploymentID: expected.DeploymentID,
			serviceID:    expected.ServiceID,
			containerID:  actual.ID,
			upstreamURL:  result.upstream.Url,
			reason:       "upstream_unreachable",
			state:        actual.State,
			dialLatency:  result.readiness.latency,
			err:          result.readiness.err,
		})
	}
	sortWaitReasons(waitReasons)
	return agenthttp.ServerlessUpstream{}, waitReasons, false
}

func sortWaitReasons(reasons []upstreamWaitReason) {
	sort.Slice(reasons, func(i, j int) bool {
		if reasons[i].deploymentID != reasons[j].deploymentID {
			return reasons[i].deploymentID < reasons[j].deploymentID
		}
		if reasons[i].reason != reasons[j].reason {
			return reasons[i].reason < reasons[j].reason
		}
		return reasons[i].upstreamURL < reasons[j].upstreamURL
	})
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

func retryableProxyRequest(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if r.ContentLength != 0 || (r.Body != nil && r.Body != http.NoBody) {
		return false
	}
	return !headerContainsToken(r.Header, "Connection", "upgrade") && r.Header.Get("Upgrade") == ""
}

func requestCancelled(r *http.Request, err error) bool {
	return r.Context().Err() != nil || errors.Is(err, context.Canceled)
}

func selectRetryUpstream(upstreams []agenthttp.ServerlessUpstream, failedURL string, start int) agenthttp.ServerlessUpstream {
	for offset := range len(upstreams) {
		upstream := upstreams[(start+offset)%len(upstreams)]
		if upstream.Url != failedURL {
			return upstream
		}
	}
	return upstreams[start%len(upstreams)]
}

func headerContainsToken(header http.Header, name string, token string) bool {
	for _, value := range header.Values(name) {
		for part := range strings.SplitSeq(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
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
