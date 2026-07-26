import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { deployments, servers, workQueue } from "@/db/schema";
import type { WorkQueue } from "@/db/types";
import { bumpAgentGeneration } from "@/lib/agent-generation";
import { MINUTE_IN_MILLISECONDS, subtractMilliseconds } from "@/lib/date";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { finalizeManifestBuild } from "@/lib/manifest-finalization";

export const WORK_QUEUE_MAX_ATTEMPTS = 3;
export const WORK_QUEUE_LEASE_DURATION_MS = 2 * MINUTE_IN_MILLISECONDS;

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

export type RolloutReconcileStage = "deploy" | "routing" | "cleanup";

export function buildRolloutReconcileWorkItem({
	rolloutId,
	stage,
	serverId,
}: {
	rolloutId: string;
	stage: RolloutReconcileStage;
	serverId: string;
}) {
	return {
		id: `reconcile:${rolloutId}:${stage}:${serverId}`,
		serverId,
		type: "reconcile" as const,
		payload: JSON.stringify({ reason: `rollout_${stage}` }),
	};
}

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
};

export type WorkItemResult = {
	id: string;
	attempt: number;
	status: "completed" | "failed";
	error?: string;
};

export type ActiveWorkItem = {
	id: string;
	type: WorkQueue["type"];
	attempt: number;
};

export type WorkLane = "runtime" | "build" | "exclusive";

export function classifyWorkType(type: WorkQueue["type"]): WorkLane {
	switch (type) {
		case "deploy":
		case "reconcile":
		case "stop":
		case "restart":
			return "runtime";
		case "build":
		case "create_manifest":
			return "build";
		case "force_cleanup":
		case "cleanup_volumes":
		case "backup_volume":
		case "restore_volume":
		case "upgrade_agent":
			return "exclusive";
		default: {
			const exhaustive: never = type;
			return exhaustive;
		}
	}
}

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
	await db.transaction(async (tx) => {
		const inserted = await tx
			.insert(workQueue)
			.values({
				id: options.id ?? randomUUID(),
				serverId,
				type,
				payload: JSON.stringify(payload),
			})
			.onConflictDoNothing({ target: workQueue.id })
			.returning({ id: workQueue.id });
		if (inserted.length) await bumpAgentGeneration(tx, serverId);
	});
}

export async function enqueueRolloutReconcile(
	rolloutId: string,
	stage: RolloutReconcileStage,
	serverIds: Iterable<string>,
) {
	const items = [...new Set(serverIds)].map((serverId) =>
		buildRolloutReconcileWorkItem({ rolloutId, stage, serverId }),
	);
	if (items.length === 0) return;

	await db.transaction(async (tx) => {
		const inserted = await tx
			.insert(workQueue)
			.values(items)
			.onConflictDoNothing({ target: workQueue.id })
			.returning({ serverId: workQueue.serverId });
		for (const serverId of new Set(inserted.map((item) => item.serverId))) {
			await bumpAgentGeneration(tx, serverId);
		}
	});
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
			.set({ status: result.status, completedAt: new Date() })
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
			const terminalManifest = await getRetryableCompletedManifest(
				serverId,
				result,
			);
			if (terminalManifest) {
				await runWorkItemCompletionSideEffects(terminalManifest, result);
				accepted.push(result.id);
				continue;
			}
			rejected.push({
				id: result.id,
				reason: await getRejectionReason(serverId, result.id, result.attempt),
			});
			continue;
		}

		await runWorkItemCompletionSideEffects(updated[0], result);
		accepted.push(result.id);
	}

	return { accepted, rejected };
}

async function getRetryableCompletedManifest(
	serverId: string,
	result: WorkItemResult,
) {
	if (result.status !== "completed") return null;
	return db
		.select()
		.from(workQueue)
		.where(
			and(
				eq(workQueue.id, result.id),
				eq(workQueue.serverId, serverId),
				eq(workQueue.type, "create_manifest"),
				eq(workQueue.status, "completed"),
				eq(workQueue.attempts, result.attempt),
			),
		)
		.then((rows) => rows[0] ?? null);
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

export async function claimWorkItems(
	serverId: string,
	activeItems: ActiveWorkItem[],
): Promise<LeasedWorkItem[]> {
	const activeLanes = new Set(
		activeItems.map((item) => classifyWorkType(item.type)),
	);
	if (activeLanes.has("exclusive")) return [];

	const runtimeAvailable = !activeLanes.has("runtime");
	const buildAvailable = !activeLanes.has("build");
	if (!runtimeAvailable && !buildAvailable) return [];

	const staleThreshold = subtractMilliseconds(
		new Date(),
		WORK_QUEUE_LEASE_DURATION_MS,
	);

	const result = await db.execute(sql`
		WITH eligible AS (
			SELECT
				id,
				type,
				status,
				created_at,
				CASE
					WHEN type IN ('deploy', 'reconcile', 'stop', 'restart') THEN 'runtime'
					WHEN type IN ('build', 'create_manifest') THEN 'build'
					ELSE 'exclusive'
				END AS lane
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
			FOR UPDATE SKIP LOCKED
		),
		oldest AS (
			SELECT id, lane
			FROM eligible
			ORDER BY (status = 'pending') DESC, created_at ASC
			LIMIT 1
		),
		claimable AS (
			SELECT id
			FROM (
				SELECT
					id,
					lane,
					created_at,
					ROW_NUMBER() OVER (PARTITION BY lane ORDER BY created_at ASC) AS lane_position
				FROM eligible
			) ranked
			WHERE
				(
					${activeItems.length === 0}
					AND (SELECT lane FROM oldest) = 'exclusive'
					AND id = (SELECT id FROM oldest)
				)
				OR (
					NOT (${activeItems.length === 0} AND (SELECT lane FROM oldest) = 'exclusive')
					AND lane_position = 1
					AND (
						(lane = 'runtime' AND ${runtimeAvailable})
						OR (lane = 'build' AND ${buildAvailable})
					)
				)
		)
		UPDATE work_queue
		SET
			status = 'processing',
			started_at = NOW(),
			claimed_at = COALESCE(claimed_at, NOW()),
			completed_at = NULL,
			result_image_uri = NULL,
			duration_ms = NULL,
			attempts = attempts + 1
		WHERE id IN (SELECT id FROM claimable)
		RETURNING id, type, payload, attempts
	`);

	const rows = result.rows as Array<{
		id: string;
		type: WorkQueue["type"];
		payload: string;
		attempts: number;
	}>;

	await Promise.all(
		rows
			.filter((row) => row.type === "upgrade_agent")
			.map((row) => markAgentUpgradeStarted(serverId, row.payload)),
	);

	return rows.map((row) => ({
		id: row.id,
		type: row.type,
		payload: row.payload,
		attempt: row.attempts,
	}));
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
				const finalization = await finalizeManifestBuild({
					serviceId: payload.serviceId,
					serviceRevisionId: payload.serviceRevisionId,
					buildGroupId: payload.buildGroupId,
				});
				if (finalization?.status !== "completed") {
					throw new Error(
						"Completed manifest work item could not be finalized",
					);
				}
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
		if (result.status === "completed") throw error;
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
		const deploymentId = payload.deploymentId;

		await db.transaction(async (tx) => {
			const updated = await tx
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
						eq(deployments.id, deploymentId),
						eq(deployments.observedPhase, "failed"),
						eq(deployments.failedStage, "autoheal_recreate"),
					),
				)
				.returning({ serverId: deployments.serverId });
			for (const serverId of new Set(updated.map((row) => row.serverId))) {
				await bumpAgentGeneration(tx, serverId);
			}
		});
	} catch (error) {
		console.error(
			"[work-queue] failed to run force cleanup completion side effects:",
			error,
		);
	}
}
