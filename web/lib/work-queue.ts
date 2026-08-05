import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
	deployments,
	servers,
	serviceCommands,
	volumeBackups,
	workQueue,
} from "@/db/schema";
import type { WorkQueue } from "@/db/types";
import { MINUTE_IN_MILLISECONDS, subtractMilliseconds } from "@/lib/date";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { notifyWorkAvailable } from "@/lib/work-queue-notifications";

export const WORK_QUEUE_MAX_ATTEMPTS = 3;
export const WORK_QUEUE_LEASE_DURATION_MS = 2 * MINUTE_IN_MILLISECONDS;

type WorkQueueTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type WorkQueueStorageConfig = {
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
	command: {
		commandRunId: string;
		deploymentId: string;
		containerId: string;
		command: string;
	};
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
		expectedChecksum: string;
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
	sync_registries: { version: string };
};

export type WorkItemResult = {
	type: "command";
	output?: string;
	exitCode?: number;
	outputTruncated?: boolean;
	timedOut?: boolean;
};

export type CompletedWorkItem = {
	id: string;
	attempt: number;
	status: "completed" | "failed";
	error?: string;
	result?: WorkItemResult;
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
	options: { id?: string; tx?: WorkQueueTransaction } = {},
) {
	const executor = options.tx ?? db;
	await executor
		.insert(workQueue)
		.values({
			id: options.id ?? randomUUID(),
			serverId,
			type,
			payload: JSON.stringify(payload),
		})
		.onConflictDoNothing({ target: workQueue.id });

	try {
		// PostgreSQL delivers transactional notifications only after commit, so the
		// agent cannot wake before the expected-state mutation is durable.
		await notifyWorkAvailable(serverId, executor);
	} catch (error) {
		if (options.tx) throw error;
		console.error("[work-queue] failed to publish notification:", error);
	}
}

export async function enqueueReconcileForAllOnlineServers(
	reason: string,
	tx: WorkQueueTransaction,
) {
	const onlineServers = await tx
		.select({ id: servers.id })
		.from(servers)
		.where(eq(servers.status, "online"));
	for (const server of onlineServers) {
		await enqueueWork(server.id, "reconcile", { reason }, { tx });
	}
}

export async function enqueueRegistrySyncForAllRegisteredServers(
	version: string,
	tx: WorkQueueTransaction,
) {
	const registeredServers = await tx
		.select({ id: servers.id })
		.from(servers)
		.where(isNotNull(servers.signingPublicKey));
	for (const server of registeredServers) {
		await tx
			.insert(workQueue)
			.values({
				id: randomUUID(),
				serverId: server.id,
				type: "sync_registries",
				payload: JSON.stringify({ version }),
			})
			.onConflictDoUpdate({
				target: workQueue.serverId,
				targetWhere: sql`${workQueue.type} = 'sync_registries' AND ${workQueue.status} = 'pending'`,
				set: { payload: JSON.stringify({ version }), createdAt: new Date() },
			});
		await notifyWorkAvailable(server.id, tx);
	}
}

export async function completeWorkItemResults(
	serverId: string,
	results: CompletedWorkItem[],
): Promise<{
	accepted: string[];
	rejected: RejectedWorkItemResult[];
}> {
	const accepted: string[] = [];
	const rejected: RejectedWorkItemResult[] = [];

	for (const result of results) {
		if (!isValidWorkItemResult(result.result)) {
			rejected.push({ id: result.id, reason: "invalid_result" });
			continue;
		}
		let item: WorkQueue | null;
		try {
			item = await db.transaction(async (tx) => {
				const updated = await tx
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

				const item = updated[0];
				if (!item) return null;

				if (result.result && item.type !== result.result.type) {
					throw new WorkItemResultTypeMismatchError();
				}
				if (item.type === "restore_volume") {
					await publishRestoreWorkResult(tx, item, result);
				}
				if (item.type === "command") {
					const commandResult = result.result;
					if (result.status === "completed" && !commandResult) {
						throw new WorkItemResultTypeMismatchError();
					}
					await tx
						.update(serviceCommands)
						.set({
							status: commandResult?.timedOut
								? "timed_out"
								: result.status === "completed" && commandResult?.exitCode === 0
									? "succeeded"
									: "failed",
							output: commandResult?.output ?? "",
							exitCode: commandResult?.exitCode,
							outputTruncated: commandResult?.outputTruncated ?? false,
							errorMessage: result.error ?? null,
							completedAt: new Date(),
						})
						.where(eq(serviceCommands.id, item.id));
				}

				return item;
			});
		} catch (error) {
			if (error instanceof WorkItemResultTypeMismatchError) {
				rejected.push({ id: result.id, reason: "invalid_result" });
				continue;
			}
			throw error;
		}

		if (!item) {
			rejected.push({
				id: result.id,
				reason: await getRejectionReason(serverId, result.id, result.attempt),
			});
			continue;
		}

		accepted.push(result.id);
		if (item.type !== "restore_volume") {
			await runWorkItemCompletionSideEffects(item, result);
		}
	}

	return { accepted, rejected };
}

class WorkItemResultTypeMismatchError extends Error {}

function isValidWorkItemResult(result: WorkItemResult | undefined): boolean {
	if (result === undefined) return true;
	return (
		result.type === "command" &&
		(result.output === undefined ||
			(typeof result.output === "string" &&
				Buffer.byteLength(result.output) <= 65536)) &&
		(result.exitCode === undefined ||
			(Number.isInteger(result.exitCode) && result.exitCode >= -1)) &&
		(result.outputTruncated === undefined ||
			typeof result.outputTruncated === "boolean") &&
		(result.timedOut === undefined || typeof result.timedOut === "boolean")
	);
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
	const claimable = claimableWorkCondition(serverId, staleThreshold);

	const result = await db.execute(sql`
		UPDATE work_queue
		SET
			status = 'processing',
			started_at = NOW(),
			attempts = attempts + 1
		WHERE id = (
			SELECT id
			FROM work_queue
			WHERE ${claimable}
			ORDER BY
				CASE WHEN type = 'sync_registries' THEN 0 ELSE 1 END,
				created_at ASC
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
	if (row.type === "command") {
		await db
			.update(serviceCommands)
			.set({ status: "running", startedAt: new Date() })
			.where(eq(serviceCommands.id, row.id));
	}
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

export async function hasClaimableWork(serverId: string): Promise<boolean> {
	const staleThreshold = subtractMilliseconds(
		new Date(),
		WORK_QUEUE_LEASE_DURATION_MS,
	);
	const result = await db.execute(sql`
		SELECT EXISTS (
			SELECT 1
			FROM work_queue
			WHERE ${claimableWorkCondition(serverId, staleThreshold)}
		) AS available
	`);
	return result.rows[0]?.available === true;
}

function claimableWorkCondition(serverId: string, staleThreshold: Date) {
	return sql`
		server_id = ${serverId}
		AND (
			status = 'pending'
			OR (
				status = 'processing'
				AND type <> 'command'
				AND started_at < ${staleThreshold}
				AND attempts < ${WORK_QUEUE_MAX_ATTEMPTS}
			)
		)
	`;
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

async function publishRestoreWorkResult(
	tx: WorkQueueTransaction,
	item: WorkQueue,
	result: CompletedWorkItem,
): Promise<void> {
	let value: unknown;
	try {
		value = JSON.parse(item.payload);
	} catch {
		console.error("[work-queue] skipping restore result publication:", {
			workItemId: item.id,
			reason: "invalid JSON payload",
		});
		return;
	}

	if (!value || typeof value !== "object") {
		console.error("[work-queue] skipping restore result publication:", {
			workItemId: item.id,
			reason: "invalid payload",
		});
		return;
	}

	const payload = value as Partial<WorkPayloadByType["restore_volume"]>;
	if (
		typeof payload.backupId !== "string" ||
		payload.backupId.length === 0 ||
		typeof payload.serviceId !== "string" ||
		payload.serviceId.length === 0 ||
		typeof payload.isMigrationRestore !== "boolean"
	) {
		console.error("[work-queue] skipping restore result publication:", {
			workItemId: item.id,
			reason: "invalid restore context",
		});
		return;
	}

	const backup = await tx
		.select({
			volumeId: volumeBackups.volumeId,
			serviceId: volumeBackups.serviceId,
		})
		.from(volumeBackups)
		.where(eq(volumeBackups.id, payload.backupId))
		.then((rows) => rows[0]);

	if (!backup) {
		console.error("[work-queue] skipping restore result publication:", {
			workItemId: item.id,
			reason: "missing backup",
		});
		return;
	}
	if (backup.serviceId !== payload.serviceId) {
		console.error("[work-queue] skipping restore result publication:", {
			workItemId: item.id,
			reason: "mismatched service context",
		});
		return;
	}

	if (payload.isMigrationRestore) {
		await inngest.send(
			inngestEvents.migrationRestoreFinished.create(
				{
					backupId: payload.backupId,
					serviceId: payload.serviceId,
					status: result.status,
					...(result.status === "failed"
						? { error: result.error || "Restore failed" }
						: {}),
				},
				{
					id: `migration-restore-${result.status}-${item.id}`,
				},
			),
		);
		return;
	}

	if (result.status === "completed") {
		await inngest.send(
			inngestEvents.restoreCompleted.create(
				{
					backupId: payload.backupId,
					volumeId: backup.volumeId,
					serviceId: payload.serviceId,
					isMigrationRestore: false,
				},
				{ id: `restore-completed-${item.id}` },
			),
		);
		return;
	}

	await inngest.send(
		inngestEvents.restoreFailed.create(
			{
				backupId: payload.backupId,
				volumeId: backup.volumeId,
				serviceId: payload.serviceId,
				error: result.error || "Restore failed",
				isMigrationRestore: false,
			},
			{ id: `restore-failed-${item.id}` },
		),
	);
}

async function runWorkItemCompletionSideEffects(
	item: WorkQueue,
	result: CompletedWorkItem,
): Promise<void> {
	if (item.type === "force_cleanup" && item.payload) {
		await runForceCleanupCompletionSideEffects(item, result);
		return;
	}

	if (item.type === "upgrade_agent" && item.payload) {
		await runAgentUpgradeCompletionSideEffects(item, result);
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
	result: CompletedWorkItem,
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

async function runForceCleanupCompletionSideEffects(
	item: WorkQueue,
	result: CompletedWorkItem,
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
