import {
	cleanupExpiredChallenges,
	renewExpiringCertificates,
} from "@/lib/acme-manager";
import { cleanupOldBackups, runScheduledBackups } from "@/lib/backup-scheduler";
import {
	checkAndRecoverStaleServers,
	checkAndRunScheduledDeployments,
	cleanupStaleItems,
} from "@/lib/scheduler";
import { inngest } from "../client";

export const staleServerCheck = inngest.createFunction(
	{ id: "cron-stale-server-check" },
	{ cron: "*/5 * * * *" },
	async ({ step }) => {
		await step.run("check-stale-servers", async () => {
			console.log("[cron] running stale server check");
			await checkAndRecoverStaleServers();
		});
	},
);

export const scheduledDeploymentsCheck = inngest.createFunction(
	{ id: "cron-scheduled-deployments" },
	{ cron: "*/15 * * * *" },
	async ({ step }) => {
		await step.run("check-scheduled-deployments", async () => {
			console.log("[cron] checking scheduled deployments");
			await checkAndRunScheduledDeployments();
		});
	},
);

export const certificateRenewal = inngest.createFunction(
	{ id: "cron-certificate-renewal" },
	{ cron: "0 2 * * *" },
	async ({ step }) => {
		await step.run("renew-certificates", async () => {
			console.log("[cron] checking for expiring certificates");
			await renewExpiringCertificates();
		});
	},
);

export const challengeCleanup = inngest.createFunction(
	{ id: "cron-challenge-cleanup" },
	{ cron: "*/10 * * * *" },
	async ({ step }) => {
		await step.run("cleanup-challenges", async () => {
			await cleanupExpiredChallenges();
		});
	},
);

export const scheduledBackupsCheck = inngest.createFunction(
	{ id: "cron-scheduled-backups" },
	{ cron: "*/15 * * * *" },
	async ({ step }) => {
		await step.run("check-scheduled-backups", async () => {
			console.log("[cron] checking scheduled backups");
			await runScheduledBackups();
		});
	},
);

export const oldBackupsCleanup = inngest.createFunction(
	{ id: "cron-old-backups-cleanup" },
	{ cron: "0 3 * * *" },
	async ({ step }) => {
		await step.run("cleanup-old-backups", async () => {
			console.log("[cron] cleaning up old backups");
			await cleanupOldBackups();
		});
	},
);

export const staleItemsCleanup = inngest.createFunction(
	{ id: "cron-stale-items-cleanup" },
	{ cron: "*/5 * * * *" },
	async ({ step }) => {
		await step.run("cleanup-stale-items", async () => {
			console.log("[cron] cleaning up stale items");
			await cleanupStaleItems();
		});
	},
);
