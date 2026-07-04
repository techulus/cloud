package serverless

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	agenthttp "techulus/cloud-agent/internal/http"
)

const (
	GatewayPort               = 18080
	activityHeartbeatInterval = 60 * time.Second
)

type Gateway struct {
	client  *agenthttp.Client
	counter uint64
	server  *http.Server
}

func NewGateway(client *agenthttp.Client) *Gateway {
	return &Gateway{client: client}
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

	wakeResult, err := g.client.WakeServerlessService(host)
	if err != nil {
		log.Printf("[serverless-gateway] wake failed for host %s: %v", host, err)
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}

	if len(wakeResult.Upstreams) == 0 {
		log.Printf("[serverless-gateway] no upstreams for host %s after wake (status=%s)", host, wakeResult.Status)
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}

	if err := g.client.RecordServerlessActivity(host, "start"); err != nil {
		log.Printf("[serverless-gateway] failed to record request start for %s: %v", host, err)
	}
	activityDone := make(chan struct{})
	go g.recordActivityHeartbeats(host, activityDone)
	defer func() {
		close(activityDone)
		if err := g.client.RecordServerlessActivity(host, "finish"); err != nil {
			log.Printf("[serverless-gateway] failed to record request finish for %s: %v", host, err)
		}
	}()

	upstream := wakeResult.Upstreams[g.nextIndex(len(wakeResult.Upstreams))]
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
		http.Error(w, "bad gateway", http.StatusBadGateway)
	}
	proxy.ServeHTTP(w, r)
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
