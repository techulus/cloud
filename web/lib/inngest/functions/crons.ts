import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { cron } from "inngest";
import { db } from "@/db";
import { githubRepos, serviceCrons, services } from "@/db/schema";
import {
	cleanupExpiredChallenges,
	renewExpiringCertificates,
} from "@/lib/acme-manager";
import { cleanupOldBackups, runScheduledBackups } from "@/lib/backup-scheduler";
import { checkAndPersistControlPlaneUpdate } from "@/lib/control-plane-updates";
import { cleanupReadNotifications } from "@/lib/notifications";
import { cleanupRegistryArtifactsDaily } from "@/lib/registry-retention";
import { cleanupOldServiceCommands } from "@/lib/service-command-retention";
import {
	checkAndRecoverStaleServers,
	checkAndRunScheduledDeployments,
	cleanupStaleItems,
	failTimedOutAgentUpgrades,
	MAX_AUTOMATIC_RECOVERIES_PER_RUN,
	rebalanceAutomaticServices,
	recoverInvalidAutomaticPlacements,
	runAutoscalingController,
} from "@/lib/scheduler";
import { inngest } from "../client";
import { inngestEvents } from "../events";
import {
	cronEventId,
	latestDueOccurrence,
	nextOccurrenceAfter,
} from "@/lib/service-crons";

export const staleServerCheck = inngest.createFunction(
	{
		id: "cron-stale-server-check",
		triggers: [cron("* * * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		const urgentCreated = await step.run("check-stale-servers", async () => {
			console.log("[cron] running stale server check");
			return checkAndRecoverStaleServers();
		});
		const recoveredCreated = await step.run(
			"recover-invalid-automatic-placements",
			async () => {
				return recoverInvalidAutomaticPlacements(
					Math.max(0, MAX_AUTOMATIC_RECOVERIES_PER_RUN - urgentCreated),
				);
			},
		);
		await step.run("rebalance-automatic-services", async () => {
			await rebalanceAutomaticServices(
				Math.max(
					0,
					MAX_AUTOMATIC_RECOVERIES_PER_RUN - urgentCreated - recoveredCreated,
				),
			);
		});
	},
);

export const autoscalingCheck = inngest.createFunction(
	{
		id: "cron-autoscaling-check",
		triggers: [cron("* * * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("evaluate-autoscaling-services", runAutoscalingController);
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

export const agentUpgradeTimeoutCheck = inngest.createFunction(
	{
		id: "cron-agent-upgrade-timeout-check",
		triggers: [cron("*/5 * * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("fail-timed-out-agent-upgrades", async () => {
			console.log("[cron] checking timed out agent upgrades");
			await failTimedOutAgentUpgrades();
		});
	},
);

export const registryArtifactRetention = inngest.createFunction(
	{
		id: "cron-registry-artifact-retention",
		triggers: [cron("0 5 * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("cleanup-registry-artifacts", async () => {
			console.log("[cron] cleaning up registry artifacts");
			await cleanupRegistryArtifactsDaily();
		});
	},
);

export const notificationRetention = inngest.createFunction(
	{
		id: "cron-notification-retention",
		triggers: [cron("0 6 * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("cleanup-read-notifications", cleanupReadNotifications);
	},
);

export const serviceCommandRetention = inngest.createFunction(
	{
		id: "cron-service-command-retention",
		triggers: [cron("0 7 * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) =>
		step.run("cleanup-service-commands", cleanupOldServiceCommands),
);

export const previewReconciliation = inngest.createFunction(
	{
		id: "cron-preview-reconciliation",
		triggers: [cron("0 1 * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		const serviceCount = await step.run(
			"queue-preview-reconciliation",
			async () => {
				const [enabled, children] = await Promise.all([
					db
						.select({ id: services.id })
						.from(services)
						.innerJoin(githubRepos, eq(githubRepos.serviceId, services.id))
						.where(
							and(
								eq(services.previewDeploymentsEnabled, true),
								eq(services.sourceType, "github"),
								isNull(services.previewOfService),
								isNull(services.deletedAt),
							),
						),
					db
						.select({ id: services.previewOfService })
						.from(services)
						.where(isNotNull(services.previewOfService))
						.groupBy(services.previewOfService),
				]);
				const serviceIds = new Set([
					...enabled.map(({ id }) => id),
					...children.flatMap(({ id }) => (id ? [id] : [])),
				]);
				const day = new Date().toISOString().slice(0, 10);
				if (serviceIds.size > 0) {
					await inngest.send(
						[...serviceIds].map((baseServiceId) =>
							inngestEvents.previewServiceReconcileRequested.create(
								{ baseServiceId },
								{ id: `preview-service-daily:${baseServiceId}:${day}` },
							),
						),
					);
				}
				return serviceIds.size;
			},
		);
		return { serviceCount };
	},
);

export const serviceCronDispatcher = inngest.createFunction(
	{
		id: "cron-service-cron-dispatcher",
		triggers: [cron("* * * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) =>
		step.run("dispatch-service-crons", async () => {
			const now = new Date();
			const rows = await db
				.select({ cron: serviceCrons })
				.from(serviceCrons)
				.innerJoin(
					services,
					and(
						eq(serviceCrons.serviceId, services.id),
						isNull(services.deletedAt),
					),
				)
				.where(lte(serviceCrons.nextScheduledFor, now))
				.orderBy(asc(serviceCrons.nextScheduledFor))
				.limit(100)
				.then((results) => results.map(({ cron }) => cron));
			for (const row of rows) {
				const occurrence = latestDueOccurrence(
					row.schedule,
					new Date(row.nextScheduledFor.getTime() - 1),
					now,
				);
				if (!occurrence) continue;
				await inngest.send({
					id: cronEventId(row.id, occurrence),
					name: "service-cron/execute",
					data: {
						cronId: row.id,
						schedule: row.schedule,
						scheduledFor: occurrence.toISOString(),
						source: "scheduled",
					},
				});
				await db
					.update(serviceCrons)
					.set({
						lastScheduledFor: occurrence,
						nextScheduledFor: nextOccurrenceAfter(row.schedule, now),
					})
					.where(
						and(
							eq(serviceCrons.id, row.id),
							eq(serviceCrons.nextScheduledFor, row.nextScheduledFor),
						),
					);
			}
		}),
);
