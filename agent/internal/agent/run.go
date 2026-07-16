package agent

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/serverless"
)

const (
	traefikMetricsURL      = "http://127.0.0.1:9100/metrics"
	traefikMetricsInterval = 15 * time.Second
	traefikMetricsMaxBytes = 8 * 1024 * 1024
)

func (a *Agent) Run(ctx context.Context) {
	if a.Config.RegistryURL != "" && a.Config.RegistryUsername != "" && a.Config.RegistryPassword != "" {
		if err := container.Login(a.Config.RegistryURL, a.Config.RegistryUsername, a.Config.RegistryPassword, a.Config.RegistryInsecure); err != nil {
			log.Printf("[registry] login failed: %v", err)
		} else {
			log.Printf("[registry] logged in to %s", a.Config.RegistryURL)
		}
	}

	ticker := time.NewTicker(TickInterval)
	defer ticker.Stop()

	var logTickerC <-chan time.Time
	if a.LogCollector != nil {
		a.LogCollector.Start()
		logTicker := time.NewTicker(5 * time.Second)
		defer logTicker.Stop()
		logTickerC = logTicker.C
	}

	if a.IsProxy && a.TraefikLogCollector != nil {
		a.TraefikLogCollector.Start()
	}

	if a.IsProxy && a.MetricsSender != nil {
		go a.TraefikMetricsLoop(ctx)
	}

	if a.IsProxy {
		gateway := serverless.NewGateway(a)
		if err := gateway.Start(ctx); err != nil {
			log.Printf("[serverless-gateway] failed to start: %v", err)
		} else {
			a.serverlessGatewayRunning.Store(true)
		}
	}

	var cleanupTickerC <-chan time.Time
	if a.Builder != nil {
		go a.RunBuildCleanup()
		cleanupTicker := time.NewTicker(BuildCleanupInterval)
		defer cleanupTicker.Stop()
		cleanupTickerC = cleanupTicker.C
	}

	go a.StatusReportLoop(ctx)

	a.Tick()

	for {
		select {
		case <-ctx.Done():
			if a.LogCollector != nil {
				a.LogCollector.Stop()
			}
			if a.IsProxy && a.TraefikLogCollector != nil {
				a.TraefikLogCollector.Stop()
			}
			return
		case <-ticker.C:
			a.Tick()
		case <-a.reconcileRequested:
			if a.GetState() == StateProcessing {
				a.requestExpectedStateRefresh()
			} else {
				a.consumeExpectedStateRefresh()
			}
			a.Tick()
		case <-a.continueProcessing:
			a.Tick()
		case <-logTickerC:
			a.CollectLogs()
		case <-cleanupTickerC:
			go a.RunBuildCleanup()
		}
	}
}

func (a *Agent) TraefikMetricsLoop(ctx context.Context) {
	ticker := time.NewTicker(traefikMetricsInterval)
	defer ticker.Stop()

	if err := a.ForwardTraefikMetrics(ctx); err != nil {
		log.Printf("[traefik-metrics] initial scrape failed: %v", err)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := a.ForwardTraefikMetrics(ctx); err != nil {
				log.Printf("[traefik-metrics] scrape failed: %v", err)
			}
		}
	}
}

func (a *Agent) ForwardTraefikMetrics(ctx context.Context) error {
	if a.MetricsSender == nil {
		return nil
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, traefikMetricsURL, nil)
	if err != nil {
		return err
	}

	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d", response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, traefikMetricsMaxBytes))
	if err != nil {
		return err
	}

	return a.MetricsSender.SendPrometheusMetrics(body, map[string]string{
		"job":       "traefik",
		"server_id": a.Config.ServerID,
	})
}

func (a *Agent) StatusReportLoop(ctx context.Context) {
	a.reportStatus("startup")

	timer := time.NewTimer(nextStatusReportDelay())
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			a.reportStatus("periodic")
			timer.Reset(nextStatusReportDelay())
		case reason := <-a.statusReportRequested:
			a.reportStatus(reason)
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(nextStatusReportDelay())
		}
	}
}

func (a *Agent) RequestStatusReport(reason string) {
	log.Printf("[status] immediate report requested: %s", reason)
	select {
	case a.statusReportRequested <- reason:
	default:
		log.Printf("[status] immediate report already queued, dropping reason: %s", reason)
	}
}

func (a *Agent) reportStatus(reason string) {
	startedAt := time.Now()
	report := a.BuildStatusReport(true)
	reportedDeploymentErrorCount := len(report.DeploymentErrors)
	completed, active := a.SnapshotWorkStatus()
	serverlessTransitions := a.SnapshotServerlessTransitions()
	response, err := a.Client.ReportStatus(report, completed, active, serverlessTransitions)
	if err != nil {
		log.Printf("[status] failed to report (%s) latency=%s: %v", reason, time.Since(startedAt).Round(time.Millisecond), err)
		return
	}
	a.ClearReportedDeploymentErrors(reportedDeploymentErrorCount)
	a.AcknowledgeServerlessTransitions(response.ServerlessTransitionResults, len(serverlessTransitions))
	a.AcknowledgeWorkResults(response.AcceptedWorkItemResults, response.RejectedWorkItemResults)
	a.LogRejectedActiveWorkItems(response.RejectedActiveWorkItems)
	a.AcceptLeasedWorkItems(response.WorkItems)
	log.Printf("[status] reported (%s) latency=%s", reason, time.Since(startedAt).Round(time.Millisecond))
}

func nextStatusReportDelay() time.Duration {
	jitter := time.Duration(time.Now().UnixNano() % int64(5*time.Second))
	return StatusReportInterval + jitter
}
