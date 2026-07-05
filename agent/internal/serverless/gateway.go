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

	agenthttp "techulus/cloud-agent/internal/http"
)

const (
	GatewayPort      = 18080
	upstreamCacheTTL = 10 * time.Second
)

var (
	activityFinishDebounceInterval = 30 * time.Second
	activityHeartbeatInterval      = 60 * time.Second
)

type Gateway struct {
	client     controlPlaneClient
	counter    uint64
	server     *http.Server
	mu         sync.Mutex
	activityMu sync.Mutex

	upstreamCache map[string]cachedUpstreams
	wakeCalls     map[string]*wakeCall
	activities    map[string]*activityState
}

type cachedUpstreams struct {
	upstreams []agenthttp.ServerlessUpstream
	expiresAt time.Time
}

type wakeCall struct {
	done   chan struct{}
	result *agenthttp.ServerlessWakeResult
	err    error
}

type controlPlaneClient interface {
	WakeServerlessService(host string) (*agenthttp.ServerlessWakeResult, error)
	RecordServerlessActivity(host, event string) error
}

type activityState struct {
	mu             sync.Mutex
	activeRequests int
	started        bool
	finishTimer    *time.Timer
	stopHeartbeat  chan struct{}
}

func NewGateway(client controlPlaneClient) *Gateway {
	return &Gateway{
		client:        client,
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
		log.Printf("[serverless-gateway] no upstreams for host %s after wake", host)
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}

	if err := g.beginActivity(host); err != nil {
		log.Printf("[serverless-gateway] failed to record activity start for %s: %v", host, err)
	}
	defer func() {
		g.endActivity(host)
	}()

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
			result, err := g.client.WakeServerlessService(host)
			g.finishWake(host, call, result, err)
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
	if call.result == nil || len(call.result.Upstreams) == 0 {
		status := ""
		if call.result != nil {
			status = call.result.Status
		}
		return nil, fmt.Errorf("no upstreams returned after wake (status=%s)", status)
	}

	return cloneUpstreams(call.result.Upstreams), nil
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

func (g *Gateway) finishWake(host string, call *wakeCall, result *agenthttp.ServerlessWakeResult, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	call.result = result
	call.err = err
	if err == nil && result != nil && len(result.Upstreams) > 0 {
		g.upstreamCache[host] = cachedUpstreams{
			upstreams: cloneUpstreams(result.Upstreams),
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

func (g *Gateway) beginActivity(host string) error {
	activity := g.activity(host)
	activity.mu.Lock()
	defer activity.mu.Unlock()

	if activity.finishTimer != nil {
		activity.finishTimer.Stop()
		activity.finishTimer = nil
	}

	activity.activeRequests += 1
	if activity.started {
		return nil
	}

	activity.started = true
	activity.stopHeartbeat = make(chan struct{})
	go g.recordActivityHeartbeats(host, activity.stopHeartbeat)

	return g.client.RecordServerlessActivity(host, "start")
}

func (g *Gateway) endActivity(host string) {
	activity := g.activity(host)
	activity.mu.Lock()
	defer activity.mu.Unlock()

	if activity.activeRequests > 0 {
		activity.activeRequests -= 1
	}
	if activity.activeRequests > 0 || !activity.started {
		return
	}

	if activity.finishTimer != nil {
		activity.finishTimer.Stop()
	}
	activity.finishTimer = time.AfterFunc(activityFinishDebounceInterval, func() {
		g.finishActivity(host, activity)
	})
}

func (g *Gateway) finishActivity(host string, activity *activityState) {
	var err error

	activity.mu.Lock()
	if activity.activeRequests > 0 || !activity.started {
		activity.mu.Unlock()
		return
	}

	activity.finishTimer = nil
	if activity.stopHeartbeat != nil {
		close(activity.stopHeartbeat)
		activity.stopHeartbeat = nil
	}
	activity.started = false
	err = g.client.RecordServerlessActivity(host, "finish")
	activity.mu.Unlock()

	if err != nil {
		log.Printf("[serverless-gateway] failed to record activity finish for %s: %v", host, err)
	}
}

func (g *Gateway) stopAllActivities() {
	g.activityMu.Lock()
	activities := make(map[string]*activityState, len(g.activities))
	for host, activity := range g.activities {
		activities[host] = activity
	}
	g.activityMu.Unlock()

	for host, activity := range activities {
		g.finishActivity(host, activity)
	}
}

func (g *Gateway) recordActivityHeartbeats(host string, done <-chan struct{}) {
	ticker := time.NewTicker(activityHeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if err := g.client.RecordServerlessActivity(host, "heartbeat"); err != nil {
				log.Printf("[serverless-gateway] failed to record request heartbeat for %s: %v", host, err)
			}
		case <-done:
			return
		}
	}
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
