package agent

import (
	"context"
	"log"
	"time"

	"techulus/cloud-agent/internal/container"
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

	var cleanupTickerC <-chan time.Time
	if a.Builder != nil {
		cleanupTicker := time.NewTicker(BuildCleanupInterval)
		defer cleanupTicker.Stop()
		cleanupTickerC = cleanupTicker.C
	}

	go a.StatusReportLoop(ctx)
	go a.WorkQueueLoop(ctx)

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
		case <-logTickerC:
			a.CollectLogs()
		case <-cleanupTickerC:
			go a.RunBuildCleanup()
		}
	}
}

func (a *Agent) StatusReportLoop(ctx context.Context) {
	a.reportStatus("startup")

	ticker := time.NewTicker(WorkQueueStatusInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.reportStatus("periodic")
		case reason := <-a.statusReportRequested:
			a.reportStatus(reason)
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
	report := a.BuildStatusReport(true)
	if err := a.Client.ReportStatus(report); err != nil {
		log.Printf("[status] failed to report (%s): %v", reason, err)
		return
	}
	log.Printf("[status] reported (%s)", reason)
}

func (a *Agent) WorkQueueLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		a.ProcessWorkQueue()
	}
}
