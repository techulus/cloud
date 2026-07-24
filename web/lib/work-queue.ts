import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { deployments, servers, volumeBackups, workQueue } from "@/db/schema";
import type { WorkQueue } from "@/db/types";
import { MINUTE_IN_MILLISECONDS, subtractMilliseconds } from "@/lib/date";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";

export const WORK_QUEUE_MAX_ATTEMPTS = 3;
export const WORK_QUEUE_LEASE_DURATION_MS = 2 * MINUTE_IN_MILLISECONDS;

export type WorkQueueStorageConfig = {
	provider: string;
	bucket: string;
	region: string;
	endpoint: string;
	accessKey: string;
	secretKey: string;
};

type ReconcileWorkPayload = {
	reason: string;
	deploymentId?: string;
};

export type WorkPayloadByType = {
	deploy: ReconcileWorkPayload;
	reconcile: ReconcileWorkPayload;
	stop: { deploymentId: string; containerId: string | null };
	restart: {
		deploymentId: string;
		containerId: string | null;
		reason?: string;
	};
	force_cleanup: {
		serviceId: string;
		containerIds: string[];
		reason?: string;
		deploymentId?: string;
	};
	cleanup_volumes: { serviceId: string };
	build: { buildId: string };
	backup_volume: {
		backupId: string;
		serviceId: string;
		containerId: string | null;
		volumeName: string;
		storagePath: string;
		storageConfig: WorkQueueStorageConfig;
	};
	restore_volume: {
		backupId: string;
		serviceId: string;
		containerId?: string | null;
		volumeName: string;
		storagePath: string;
		expectedChecksum: string | null;
		isMigrationRestore: boolean;
		storageConfig: WorkQueueStorageConfig;
	};
	create_manifest: {
		images: string[];
		finalImageUri: string;
		serviceId: string;
		serviceRevisionId: string;
		buildGroupId: string;
	};
	upgrade_agent: { targetVersion: string; expectedSha256: string };
};

export type WorkItemResult = {
	id: string;
	attempt: number;
	status: "completed" | "failed";
	error?: string;
	output?: unknown;
};

export type ActiveWorkItem = {
	id: string;
	attempt: number;
};

export type LeasedWorkItem = {
	id: string;
	type: WorkQueue["type"];
	payload: string;
	attempt: number;
};

export type RejectedWorkItemResult = {
	id: string;
	reason: string;
};

export type RejectedActiveWorkItem = {
	id: string;
	reason: string;
};

export async function enqueueWork<T extends WorkQueue["type"]>(
	serverId: string,
	type: T,
	payload: WorkPayloadByType[T],
	options: { id?: string } = {},
) {
	await db
		.insert(workQueue)
		.values({
			id: options.id ?? randomUUID(),
			serverId,
			type,
			payload: JSON.stringify(payload),
		})
		.onConflictDoNothing({ target: workQueue.id });
}

export async function completeWorkItemResults(
	serverId: string,
	results: WorkItemResult[],
): Promise<{
	accepted: string[];
	rejected: RejectedWorkItemResult[];
}> {
	const accepted: string[] = [];
	const rejected: RejectedWorkItemResult[] = [];

	for (const result of results) {
		const updated = await db
			.update(workQueue)
			.set({ status: result.status })
			.where(
				and(
					eq(workQueue.id, result.id),
					eq(workQueue.serverId, serverId),
					eq(workQueue.status, "processing"),
					eq(workQueue.attempts, result.attempt),
				),
			)
			.returning();

		if (updated.length === 0) {
			rejected.push({
				id: result.id,
				reason: await getRejectionReason(serverId, result.id, result.attempt),
			});
			continue;
		}

		accepted.push(result.id);
		await runWorkItemCompletionSideEffects(updated[0], result);
	}

	return { accepted, rejected };
}

export async function renewActiveWorkItems(
	serverId: string,
	items: ActiveWorkItem[],
): Promise<RejectedActiveWorkItem[]> {
	if (items.length === 0) return [];

	const rejected: RejectedActiveWorkItem[] = [];

	for (const item of items) {
		const updated = await db
			.update(workQueue)
			.set({ startedAt: new Date() })
			.where(
				and(
					eq(workQueue.id, item.id),
					eq(workQueue.serverId, serverId),
					eq(workQueue.status, "processing"),
					eq(workQueue.attempts, item.attempt),
				),
			)
			.returning({ id: workQueue.id });

		if (updated.length === 0) {
			rejected.push({
				id: item.id,
				reason: await getRejectionReason(serverId, item.id, item.attempt),
			});
		}
	}

	return rejected;
}

export async function claimNextWorkItem(
	serverId: string,
): Promise<LeasedWorkItem | null> {
	const staleThreshold = subtractMilliseconds(
		new Date(),
		WORK_QUEUE_LEASE_DURATION_MS,
	);

	const result = await db.execute(sql`
		UPDATE work_queue
		SET
			status = 'processing',
			started_at = NOW(),
			attempts = attempts + 1
		WHERE id = (
			SELECT id
			FROM work_queue
			WHERE server_id = ${serverId}
				AND (
					status = 'pending'
					OR (
						status = 'processing'
						AND started_at < ${staleThreshold}
						AND attempts < ${WORK_QUEUE_MAX_ATTEMPTS}
					)
				)
			ORDER BY created_at ASC
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		RETURNING id, type, payload, attempts
	`);

	const rows = result.rows as Array<{
		id: string;
		type: WorkQueue["type"];
		payload: string;
		attempts: number;
	}>;

	const row = rows[0];
	if (!row) return null;
	if (row.type === "upgrade_agent") {
		await markAgentUpgradeStarted(serverId, row.payload);
	}

	return {
		id: row.id,
		type: row.type,
		payload: row.payload,
		attempt: row.attempts,
	};
}

async function markAgentUpgradeStarted(serverId: string, payloadText: string) {
	try {
		const payload = JSON.parse(payloadText) as { targetVersion?: string };
		if (!payload.targetVersion) return;
		await db
			.update(servers)
			.set({
				agentUpgradeStatus: "upgrading",
				agentUpgradeStartedAt: new Date(),
				agentUpgradeError: null,
			})
			.where(
				and(
					eq(servers.id, serverId),
					eq(servers.agentUpgradeTargetVersion, payload.targetVersion),
					inArray(servers.agentUpgradeStatus, ["queued", "upgrading"]),
				),
			);
	} catch (error) {
		console.error("[work-queue] failed to mark agent upgrade started:", error);
	}
}

async function getRejectionReason(
	serverId: string,
	id: string,
	attempt: number,
): Promise<string> {
	const item = await db
		.select({
			serverId: workQueue.serverId,
			status: workQueue.status,
			attempts: workQueue.attempts,
		})
		.from(workQueue)
		.where(eq(workQueue.id, id))
		.then((rows) => rows[0]);

	if (!item) return "not_found";
	if (item.serverId !== serverId) return "server_mismatch";
	if (item.status === "completed" || item.status === "failed") {
		return "already_terminal";
	}
	if (item.status !== "processing") return "not_processing";
	if (item.attempts !== attempt) return "attempt_mismatch";
	return "unknown";
}

async function runWorkItemCompletionSideEffects(
	item: WorkQueue,
	result: WorkItemResult,
): Promise<void> {
	if (item.type === "force_cleanup" && item.payload) {
		await runForceCleanupCompletionSideEffects(item, result);
		return;
	}

	if (item.type === "upgrade_agent" && item.payload) {
		await runAgentUpgradeCompletionSideEffects(item, result);
		return;
	}

	if (item.type === "backup_volume" && item.payload) {
		await runBackupVolumeCompletionSideEffects(item, result);
		return;
	}

	if (item.type === "restore_volume" && item.payload) {
		await runRestoreVolumeCompletionSideEffects(item, result);
		return;
	}

	if (item.type !== "create_manifest" || !item.payload) {
		return;
	}

	try {
		const payload = JSON.parse(item.payload) as Partial<
			WorkPayloadByType["create_manifest"]
		>;

		if (result.status === "completed") {
			if (
				payload.serviceId &&
				payload.serviceRevisionId &&
				payload.buildGroupId &&
				payload.finalImageUri
			) {
				await inngest.send(
					inngestEvents.manifestCompleted.create(
						{
							serviceId: payload.serviceId,
							serviceRevisionId: payload.serviceRevisionId,
							buildGroupId: payload.buildGroupId,
							imageUri: payload.finalImageUri,
						},
						{
							id: `manifest-completed-${payload.buildGroupId}`,
						},
					),
				);
			}
		} else if (
			payload.serviceId &&
			payload.serviceRevisionId &&
			payload.buildGroupId
		) {
			await inngest.send(
				inngestEvents.manifestFailed.create(
					{
						serviceId: payload.serviceId,
						serviceRevisionId: payload.serviceRevisionId,
						buildGroupId: payload.buildGroupId,
						error: result.error || "Manifest creation failed",
					},
					{
						id: `manifest-failed-${payload.buildGroupId}`,
					},
				),
			);
		}
	} catch (error) {
		console.error("[work-queue] failed to run completion side effects:", error);
	}
}

async function runAgentUpgradeCompletionSideEffects(
	item: WorkQueue,
	result: WorkItemResult,
): Promise<void> {
	try {
		const payload = JSON.parse(item.payload) as { targetVersion?: string };
		if (!payload.targetVersion) return;

		if (result.status === "failed") {
			await db
				.update(servers)
				.set({
					agentUpgradeStatus: "failed",
					agentUpgradeError: result.error || "Agent upgrade failed",
				})
				.where(
					and(
						eq(servers.id, item.serverId),
						eq(servers.agentUpgradeTargetVersion, payload.targetVersion),
					),
				);
			return;
		}

		const [server] = await db
			.select({ agentHealth: servers.agentHealth })
			.from(servers)
			.where(eq(servers.id, item.serverId))
			.limit(1);

		await db
			.update(servers)
			.set({
				agentUpgradeStatus:
					server?.agentHealth?.version === payload.targetVersion
						? "succeeded"
						: "upgrading",
				agentUpgradeStartedAt: item.startedAt ?? new Date(),
				agentUpgradeError: null,
			})
			.where(
				and(
					eq(servers.id, item.serverId),
					eq(servers.agentUpgradeTargetVersion, payload.targetVersion),
				),
			);
	} catch (error) {
		console.error(
			"[work-queue] failed to run agent upgrade completion side effects:",
			error,
		);
	}
}

async function runBackupVolumeCompletionSideEffects(
	item: WorkQueue,
	result: WorkItemResult,
): Promise<void> {
	try {
		const payload = JSON.parse(item.payload) as Partial<
			WorkPayloadByType["backup_volume"]
		>;
		if (!payload.backupId) return;

		const output =
			result.output && typeof result.output === "object"
				? (result.output as { sizeBytes?: number; checksum?: string })
				: {};

		const updateValues =
			result.status === "completed" && typeof output.checksum === "string"
				? {
						status: "completed" as const,
						sizeBytes:
							typeof output.sizeBytes === "number" ? output.sizeBytes : null,
						checksum: output.checksum,
						completedAt: new Date(),
					}
				: {
						status: "failed" as const,
						errorMessage: result.error || "Backup failed",
					};

		// Only transition non-terminal backups so a stale attempt can't
		// clobber the final state.
		const updated = await db
			.update(volumeBackups)
			.set(updateValues)
			.where(
				and(
					eq(volumeBackups.id, payload.backupId),
					eq(volumeBackups.serverId, item.serverId),
					notInArray(volumeBackups.status, ["completed", "failed"]),
				),
			)
			.returning({ serviceId: volumeBackups.serviceId });

		if (updated.length === 0) return;

		revalidatePath("/dashboard/projects");
		await inngest.send(
			inngestEvents.resourceStatusChanged.create({
				type: "backup",
				id: payload.backupId,
				parentType: "service",
				parentId: updated[0].serviceId,
			}),
		);
	} catch (error) {
		console.error(
			"[work-queue] failed to run backup completion side effects:",
			error,
		);
	}
}

async function runRestoreVolumeCompletionSideEffects(
	item: WorkQueue,
	result: WorkItemResult,
): Promise<void> {
	try {
		const payload = JSON.parse(item.payload) as Partial<
			WorkPayloadByType["restore_volume"]
		>;
		if (!payload.backupId) return;
		const backupId = payload.backupId;

		const backup = await db
			.select({
				volumeId: volumeBackups.volumeId,
				serviceId: volumeBackups.serviceId,
				isMigrationBackup: volumeBackups.isMigrationBackup,
			})
			.from(volumeBackups)
			.where(eq(volumeBackups.id, backupId))
			.then((r) => r[0]);

		if (!backup) return;

		const isMigrationRestore =
			payload.isMigrationRestore ?? backup.isMigrationBackup ?? false;

		revalidatePath("/dashboard/projects");

		if (result.status === "completed") {
			await inngest.send(
				inngestEvents.restoreCompleted.create({
					backupId,
					volumeId: backup.volumeId,
					serviceId: backup.serviceId,
					isMigrationRestore,
				}),
			);

			if (isMigrationRestore) {
				await inngest.send(
					inngestEvents.migrationRestoreCompleted.create({
						backupId,
						serviceId: backup.serviceId,
					}),
				);
				await inngest.send(
					inngestEvents.migrationRestoreFinished.create({
						backupId,
						serviceId: backup.serviceId,
						status: "completed",
					}),
				);
			}
			return;
		}

		const message = result.error || "Restore failed";
		await inngest.send(
			inngestEvents.restoreFailed.create({
				backupId,
				volumeId: backup.volumeId,
				serviceId: backup.serviceId,
				error: message,
				isMigrationRestore,
			}),
		);

		if (isMigrationRestore) {
			await inngest.send(
				inngestEvents.migrationRestoreFailed.create({
					backupId,
					serviceId: backup.serviceId,
					error: message,
				}),
			);
			await inngest.send(
				inngestEvents.migrationRestoreFinished.create({
					backupId,
					serviceId: backup.serviceId,
					status: "failed",
					error: message,
				}),
			);
		}
	} catch (error) {
		console.error(
			"[work-queue] failed to run restore completion side effects:",
			error,
		);
	}
}

async function runForceCleanupCompletionSideEffects(
	item: WorkQueue,
	result: WorkItemResult,
): Promise<void> {
	try {
		const payload = JSON.parse(item.payload) as {
			reason?: string;
			deploymentId?: string;
		};

		if (
			payload.reason !== "autoheal_recreate" ||
			!payload.deploymentId ||
			result.status !== "completed"
		) {
			return;
		}

		await db
			.update(deployments)
			.set({
				containerId: null,
				runtimeDesiredState: "running",
				observedPhase: "pending",
				healthStatus: null,
				unhealthyReportCount: 0,
				autohealRestartCount: 0,
				failedStage: null,
			})
			.where(
				and(
					eq(deployments.id, payload.deploymentId),
					eq(deployments.observedPhase, "failed"),
					eq(deployments.failedStage, "autoheal_recreate"),
				),
			);
	} catch (error) {
		console.error(
			"[work-queue] failed to run force cleanup completion side effects:",
			error,
		);
	}
}
