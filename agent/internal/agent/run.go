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

	go a.HeartbeatLoop(ctx)
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
		case <-logTickerC:
			a.CollectLogs()
		case <-cleanupTickerC:
			go a.RunBuildCleanup()
		}
	}
}

func (a *Agent) WorkQueueLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
			a.ProcessWorkQueue()
		}
	}
}
