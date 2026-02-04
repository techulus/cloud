package agent

import (
	"log"
	"time"
)

const (
	LongPollTimeout         = 30 * time.Second
	WorkQueueStatusInterval = 60 * time.Second
)

func (a *Agent) ProcessWorkQueue() {
	items, err := a.Client.GetWorkQueue(LongPollTimeout)
	if err != nil {
		log.Printf("[work-queue] failed to get work queue: %v", err)
		time.Sleep(5 * time.Second)
		return
	}

	for _, item := range items {
		log.Printf("[work-queue] processing item %s (type=%s)", Truncate(item.ID, 8), item.Type)

		var processErr error
		switch item.Type {
		case "restart":
			processErr = a.ProcessRestart(item)
		case "stop":
			processErr = a.ProcessStop(item)
		case "deploy":
			log.Printf("[work-queue] deploy handled via expected state reconciliation, marking complete")
		case "force_cleanup":
			processErr = a.ProcessForceCleanup(item)
		case "cleanup_volumes":
			processErr = a.ProcessCleanupVolumes(item)
		case "build":
			processErr = a.ProcessBuild(item)
		case "backup_volume":
			processErr = a.ProcessBackupVolume(item)
		case "restore_volume":
			processErr = a.ProcessRestoreVolume(item)
		case "create_manifest":
			processErr = a.ProcessCreateManifest(item)
		default:
			log.Printf("[work-queue] unknown work item type: %s", item.Type)
			continue
		}

		if processErr != nil {
			log.Printf("[work-queue] item %s failed: %v", Truncate(item.ID, 8), processErr)
			if err := a.Client.CompleteWorkItem(item.ID, "failed", processErr.Error()); err != nil {
				log.Printf("[work-queue] failed to mark item as failed: %v", err)
			}
		} else {
			log.Printf("[work-queue] item %s completed", Truncate(item.ID, 8))
			if err := a.Client.CompleteWorkItem(item.ID, "completed", ""); err != nil {
				log.Printf("[work-queue] failed to mark item as completed: %v", err)
			}
		}
	}
}
