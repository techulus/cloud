import { cron } from "inngest";
import {
	cleanupExpiredChallenges,
	renewExpiringCertificates,
} from "@/lib/acme-manager";
import { cleanupOldBackups, runScheduledBackups } from "@/lib/backup-scheduler";
import { checkAndPersistControlPlaneUpdate } from "@/lib/control-plane-updates";
import {
	checkAndRecoverStaleServers,
	checkAndRunScheduledDeployments,
	cleanupStaleItems,
} from "@/lib/scheduler";
import { inngest } from "../client";

export const staleServerCheck = inngest.createFunction(
	{
		id: "cron-stale-server-check",
		triggers: [cron("*/5 * * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("check-stale-servers", async () => {
			console.log("[cron] running stale server check");
			await checkAndRecoverStaleServers();
		});
	},
);

export const scheduledDeploymentsCheck = inngest.createFunction(
	{
		id: "cron-scheduled-deployments",
		triggers: [cron("*/15 * * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("check-scheduled-deployments", async () => {
			console.log("[cron] checking scheduled deployments");
			await checkAndRunScheduledDeployments();
		});
	},
);

export const certificateRenewal = inngest.createFunction(
	{
		id: "cron-certificate-renewal",
		triggers: [cron("0 2 * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("renew-certificates", async () => {
			console.log("[cron] checking for expiring certificates");
			await renewExpiringCertificates();
		});
	},
);

export const challengeCleanup = inngest.createFunction(
	{
		id: "cron-challenge-cleanup",
		triggers: [cron("0 * * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("cleanup-challenges", async () => {
			await cleanupExpiredChallenges();
		});
	},
);

export const scheduledBackupsCheck = inngest.createFunction(
	{
		id: "cron-scheduled-backups",
		triggers: [cron("*/15 * * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("check-scheduled-backups", async () => {
			console.log("[cron] checking scheduled backups");
			await runScheduledBackups();
		});
	},
);

export const oldBackupsCleanup = inngest.createFunction(
	{
		id: "cron-old-backups-cleanup",
		triggers: [cron("0 3 * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("cleanup-old-backups", async () => {
			console.log("[cron] cleaning up old backups");
			await cleanupOldBackups();
		});
	},
);

export const controlPlaneUpdateCheck = inngest.createFunction(
	{
		id: "cron-control-plane-update-check",
		triggers: [cron("0 4 * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("check-control-plane-updates", async () => {
			console.log("[cron] checking control plane updates");
			await checkAndPersistControlPlaneUpdate();
		});
	},
);

export const staleItemsCleanup = inngest.createFunction(
	{
		id: "cron-stale-items-cleanup",
		triggers: [cron("*/15 * * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("cleanup-stale-items", async () => {
			console.log("[cron] cleaning up stale items");
			await cleanupStaleItems();
		});
	},
);
