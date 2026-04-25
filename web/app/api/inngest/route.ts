import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import {
	backupWorkflow,
	buildTriggerWorkflow,
	buildWorkflow,
	certificateRenewal,
	challengeCleanup,
	migrationWorkflow,
	oldBackupsCleanup,
	onBackupFailed,
	onDeploymentFailed,
	onRestoreFailed,
	restoreTriggerWorkflow,
	restoreWorkflow,
	rolloutWorkflow,
	scheduledBackupsCheck,
	scheduledDeploymentsCheck,
	staleItemsCleanup,
	staleServerCheck,
} from "@/lib/inngest/functions";

export const { GET, POST, PUT } = serve({
	client: inngest,
	functions: [
		rolloutWorkflow,
		onDeploymentFailed,
		staleServerCheck,
		scheduledDeploymentsCheck,
		certificateRenewal,
		challengeCleanup,
		scheduledBackupsCheck,
		oldBackupsCleanup,
		staleItemsCleanup,
		migrationWorkflow,
		backupWorkflow,
		onBackupFailed,
		restoreWorkflow,
		onRestoreFailed,
		buildWorkflow,
		buildTriggerWorkflow,
		restoreTriggerWorkflow,
	],
});
