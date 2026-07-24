import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import type { WorkCompletionOutboxEvent } from "@/db/schema";
import {
	deployments,
	servers,
	volumeBackups,
	workCompletionOutbox,
	workQueue,
} from "@/db/schema";
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

export type WorkOutputByType = {
	deploy: undefined;
	reconcile: undefined;
	stop: undefined;
	restart: undefined;
	force_cleanup: undefined;
	cleanup_volumes: undefined;
	build: undefined;
	backup_volume: { sizeBytes: number; checksum: string };
	restore_volume: undefined;
	create_manifest: undefined;
	upgrade_agent: undefined;
};

export type WorkItemResult = {
	id: string;
	attempt: number;
	status: "completed" | "failed";
	error?: string;
	output?: WorkOutputByType[WorkQueue["type"]];
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

export type RetryableWorkItemResult = {
	id: string;
	reason: string;
};

type CompletionSource = "agent_status" | "legacy_callback" | "system";
type CreatedCompletionEvent = Omit<WorkCompletionOutboxEvent, "id"> & {
	id?: string;
};

const TYPED_WORK_RESULTS_CAPABILITY = "typed_work_results_v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export async function enqueueWork<T extends WorkQueue["type"]>(
	serverId: string,
	type: T,
	payload: WorkPayloadByType[T],
	options: { id?: string } = {},
) {
	const id = options.id ?? randomUUID();
	await db
		.insert(workQueue)
		.values({
			id,
			serverId,
			type,
			payload: JSON.stringify(payload),
		})
		.onConflictDoNothing({ target: workQueue.id });
	return id;
}

export async function completeWorkItemResults(
	serverId: string,
	results: WorkItemResult[],
	options: {
		source?: CompletionSource;
		processingStartedBefore?: Date;
	} = {},
): Promise<{
	accepted: string[];
	rejected: RejectedWorkItemResult[];
	retryable: RetryableWorkItemResult[];
}> {
	const accepted: string[] = [];
	const rejected: RejectedWorkItemResult[] = [];
	const retryable: RetryableWorkItemResult[] = [];
	const outboxIds: string[] = [];

	for (const result of results) {
		try {
			const outcome = await db.transaction(async (tx) => {
				const item = await tx
					.select()
					.from(workQueue)
					.where(eq(workQueue.id, result.id))
					.for("update")
					.then((rows) => rows[0]);

				const rejectionReason = getRejectionReason(
					item,
					serverId,
					result.attempt,
				);
				if (rejectionReason) {
					return { kind: "rejected" as const, reason: rejectionReason };
				}
				if (
					options.processingStartedBefore &&
					(!item.startedAt || item.startedAt >= options.processingStartedBefore)
				) {
					return { kind: "rejected" as const, reason: "not_stale" };
				}

				if (
					(options.source ?? "agent_status") === "agent_status" &&
					(item.type === "backup_volume" || item.type === "restore_volume")
				) {
					const server = await tx
						.select({ agentHealth: servers.agentHealth })
						.from(servers)
						.where(eq(servers.id, serverId))
						.then((rows) => rows[0]);
					if (
						!server?.agentHealth?.capabilities?.includes(
							TYPED_WORK_RESULTS_CAPABILITY,
						)
					) {
						return {
							kind: "rejected" as const,
							reason: "legacy_callback_required",
						};
					}
				}

				const outputError = validateWorkItemResultOutput(item.type, result);
				if (outputError) {
					return { kind: "rejected" as const, reason: outputError };
				}

				const terminalStatus = result.status;
				let revalidateProjects = false;
				const events: CreatedCompletionEvent[] = [];

				if (item.type === "backup_volume") {
					const payload = parseWorkPayload(item, "backup_volume");
					if (!payload.backupId || !payload.serviceId) {
						return { kind: "rejected" as const, reason: "invalid_payload" };
					}

					const backup = await tx
						.select()
						.from(volumeBackups)
						.where(eq(volumeBackups.id, payload.backupId))
						.for("update")
						.then((rows) => rows[0]);
					if (
						!backup ||
						backup.serverId !== serverId ||
						backup.serviceId !== payload.serviceId
					) {
						return { kind: "rejected" as const, reason: "backup_mismatch" };
					}

					if (backup.status === "completed" || backup.status === "failed") {
						if (backup.status !== result.status) {
							return {
								kind: "rejected" as const,
								reason: "conflicting_terminal_state",
							};
						}
						if (result.status === "completed") {
							const output = result.output as WorkOutputByType["backup_volume"];
							if (
								backup.sizeBytes !== output.sizeBytes ||
								backup.checksum?.toLowerCase() !== output.checksum.toLowerCase()
							) {
								return {
									kind: "rejected" as const,
									reason: "conflicting_terminal_state",
								};
							}
						}
					} else if (result.status === "completed") {
						const output = result.output as WorkOutputByType["backup_volume"];
						await tx
							.update(volumeBackups)
							.set({
								status: "completed",
								sizeBytes: output.sizeBytes,
								checksum: output.checksum.toLowerCase(),
								completedAt: new Date(),
								errorMessage: null,
							})
							.where(eq(volumeBackups.id, backup.id));
					} else {
						await tx
							.update(volumeBackups)
							.set({
								status: "failed",
								errorMessage: result.error || "Backup failed",
							})
							.where(eq(volumeBackups.id, backup.id));
					}

					events.push(
						inngestEvents.resourceStatusChanged.create(
							{
								type: "backup",
								id: payload.backupId,
								parentType: "service",
								parentId: backup.serviceId,
							},
							{
								id: completionEventId(item.id, "resource-status-changed"),
							},
						),
					);
					revalidateProjects = true;
				} else if (item.type === "restore_volume") {
					const payload = parseWorkPayload(item, "restore_volume");
					if (
						!payload.backupId ||
						!payload.serviceId ||
						typeof payload.isMigrationRestore !== "boolean"
					) {
						return { kind: "rejected" as const, reason: "invalid_payload" };
					}

					const backup = await tx
						.select({
							volumeId: volumeBackups.volumeId,
							serviceId: volumeBackups.serviceId,
						})
						.from(volumeBackups)
						.where(eq(volumeBackups.id, payload.backupId))
						.then((rows) => rows[0]);
					if (!backup || backup.serviceId !== payload.serviceId) {
						return { kind: "rejected" as const, reason: "backup_mismatch" };
					}

					const eventData = {
						workItemId: item.id,
						backupId: payload.backupId,
						volumeId: backup.volumeId,
						serviceId: backup.serviceId,
						isMigrationRestore: payload.isMigrationRestore,
					};
					if (result.status === "completed") {
						events.push(
							inngestEvents.restoreCompleted.create(eventData, {
								id: completionEventId(item.id, "restore-completed"),
							}),
						);
						if (payload.isMigrationRestore) {
							events.push(
								inngestEvents.migrationRestoreCompleted.create(
									{
										workItemId: item.id,
										backupId: payload.backupId,
										serviceId: backup.serviceId,
									},
									{
										id: completionEventId(
											item.id,
											"migration-restore-completed",
										),
									},
								),
								inngestEvents.migrationRestoreFinished.create(
									{
										workItemId: item.id,
										backupId: payload.backupId,
										serviceId: backup.serviceId,
										status: "completed",
									},
									{
										id: completionEventId(
											item.id,
											"migration-restore-finished",
										),
									},
								),
							);
						}
					} else {
						const message = result.error || "Restore failed";
						events.push(
							inngestEvents.restoreFailed.create(
								{ ...eventData, error: message },
								{
									id: completionEventId(item.id, "restore-failed"),
								},
							),
						);
						if (payload.isMigrationRestore) {
							events.push(
								inngestEvents.migrationRestoreFailed.create(
									{
										workItemId: item.id,
										backupId: payload.backupId,
										serviceId: backup.serviceId,
										error: message,
									},
									{
										id: completionEventId(item.id, "migration-restore-failed"),
									},
								),
								inngestEvents.migrationRestoreFinished.create(
									{
										workItemId: item.id,
										backupId: payload.backupId,
										serviceId: backup.serviceId,
										status: "failed",
										error: message,
									},
									{
										id: completionEventId(
											item.id,
											"migration-restore-finished",
										),
									},
								),
							);
						}
					}
					revalidateProjects = true;
				} else if (item.type === "create_manifest") {
					const payload = parseWorkPayload(item, "create_manifest");
					if (
						!payload.serviceId ||
						!payload.serviceRevisionId ||
						!payload.buildGroupId ||
						!payload.finalImageUri
					) {
						return { kind: "rejected" as const, reason: "invalid_payload" };
					}
					if (result.status === "completed") {
						events.push(
							inngestEvents.manifestCompleted.create(
								{
									serviceId: payload.serviceId,
									serviceRevisionId: payload.serviceRevisionId,
									buildGroupId: payload.buildGroupId,
									imageUri: payload.finalImageUri,
								},
								{
									id: completionEventId(item.id, "manifest-completed"),
								},
							),
						);
					} else {
						events.push(
							inngestEvents.manifestFailed.create(
								{
									serviceId: payload.serviceId,
									serviceRevisionId: payload.serviceRevisionId,
									buildGroupId: payload.buildGroupId,
									error: result.error || "Manifest creation failed",
								},
								{
									id: completionEventId(item.id, "manifest-failed"),
								},
							),
						);
					}
				} else if (item.type === "force_cleanup") {
					const payload = parseWorkPayload(item, "force_cleanup");
					if (
						result.status === "completed" &&
						payload.reason === "autoheal_recreate" &&
						payload.deploymentId
					) {
						await tx
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
					}
				} else if (item.type === "upgrade_agent") {
					const payload = parseWorkPayload(item, "upgrade_agent");
					if (!payload.targetVersion) {
						return { kind: "rejected" as const, reason: "invalid_payload" };
					}
					if (result.status === "failed") {
						await tx
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
					} else {
						const server = await tx
							.select({ agentHealth: servers.agentHealth })
							.from(servers)
							.where(eq(servers.id, item.serverId))
							.then((rows) => rows[0]);
						await tx
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
					}
				}

				await tx
					.update(workQueue)
					.set({ status: terminalStatus })
					.where(eq(workQueue.id, item.id));

				if (events.length > 0) {
					await tx.insert(workCompletionOutbox).values({
						workItemId: item.id,
						events: events.map(requireCompletionEventId),
						revalidateProjects,
					});
				}

				return {
					kind: "accepted" as const,
					outbox: events.length > 0,
					revalidateProjects,
				};
			});

			if (outcome.kind === "rejected") {
				rejected.push({ id: result.id, reason: outcome.reason });
				continue;
			}

			accepted.push(result.id);
			if (outcome.outbox) outboxIds.push(result.id);
		} catch (error) {
			console.error(
				`[work-queue] failed to durably complete ${result.id}:`,
				error,
			);
			retryable.push({ id: result.id, reason: "completion_failed" });
		}
	}

	for (const id of outboxIds) {
		try {
			await dispatchWorkCompletionOutbox(id);
		} catch (error) {
			console.error(`[work-queue] deferred event dispatch for ${id}:`, error);
		}
	}

	return { accepted, rejected, retryable };
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
			const current = await db
				.select()
				.from(workQueue)
				.where(eq(workQueue.id, item.id))
				.then((rows) => rows[0]);
			rejected.push({
				id: item.id,
				reason:
					getRejectionReason(current, serverId, item.attempt) ?? "unknown",
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

function getRejectionReason(
	item: WorkQueue | undefined,
	serverId: string,
	attempt: number,
): string | null {
	if (!item) return "not_found";
	if (item.serverId !== serverId) return "server_mismatch";
	if (item.status === "completed" || item.status === "failed") {
		return "already_terminal";
	}
	if (item.status !== "processing") return "not_processing";
	if (item.attempts !== attempt) return "attempt_mismatch";
	return null;
}

export function validateWorkItemResultOutput(
	type: WorkQueue["type"],
	result: WorkItemResult,
): string | null {
	if (type !== "backup_volume" || result.status !== "completed") {
		return result.output === undefined ? null : "invalid_output";
	}
	const output = result.output;
	if (
		!output ||
		typeof output !== "object" ||
		Array.isArray(output) ||
		!Number.isSafeInteger(output.sizeBytes) ||
		output.sizeBytes < 0 ||
		typeof output.checksum !== "string" ||
		!SHA256_PATTERN.test(output.checksum)
	) {
		return "invalid_output";
	}
	return null;
}

function parseWorkPayload<T extends WorkQueue["type"]>(
	item: WorkQueue,
	type: T,
): Partial<WorkPayloadByType[T]> {
	if (item.type !== type) throw new Error("work item type mismatch");
	const payload: unknown = JSON.parse(item.payload);
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("invalid work item payload");
	}
	return payload as Partial<WorkPayloadByType[T]>;
}

function requireCompletionEventId(
	event: CreatedCompletionEvent,
): WorkCompletionOutboxEvent {
	if (!event.id) throw new Error("completion event is missing an id");
	return { ...event, id: event.id };
}

function completionEventId(workItemId: string, kind: string) {
	return `work-completion:${workItemId}:${kind}`;
}

export async function dispatchWorkCompletionOutbox(workItemId: string) {
	const row = await db
		.select()
		.from(workCompletionOutbox)
		.where(eq(workCompletionOutbox.workItemId, workItemId))
		.then((rows) => rows[0]);
	if (!row || row.processedAt) return;

	await inngest.send(row.events as Parameters<typeof inngest.send>[0]);
	if (row.revalidateProjects) revalidatePath("/dashboard/projects");
	await db
		.update(workCompletionOutbox)
		.set({ processedAt: new Date() })
		.where(
			and(
				eq(workCompletionOutbox.workItemId, workItemId),
				isNull(workCompletionOutbox.processedAt),
			),
		);
}

export async function retryPendingWorkCompletions() {
	const rows = await db
		.select({ workItemId: workCompletionOutbox.workItemId })
		.from(workCompletionOutbox)
		.where(isNull(workCompletionOutbox.processedAt))
		.orderBy(asc(workCompletionOutbox.createdAt))
		.limit(100);

	for (const row of rows) {
		try {
			await dispatchWorkCompletionOutbox(row.workItemId);
		} catch (error) {
			console.error(
				`[work-queue] failed to retry completion events for ${row.workItemId}:`,
				error,
			);
		}
	}
}

export async function completeLegacyVolumeWorkItem(
	serverId: string,
	type: "backup_volume" | "restore_volume",
	backupId: string,
	result: Pick<WorkItemResult, "status" | "error" | "output">,
): Promise<"completed" | "pending" | "conflict" | "not_found"> {
	const matches = await db
		.select()
		.from(workQueue)
		.where(
			and(
				eq(workQueue.serverId, serverId),
				eq(workQueue.type, type),
				eq(workQueue.status, "processing"),
				sql`${workQueue.payload}::jsonb ->> 'backupId' = ${backupId}`,
			),
		)
		.orderBy(desc(workQueue.createdAt))
		.limit(2);

	if (matches.length > 1) return "conflict";
	const item = matches[0];
	if (item) {
		const completion = await completeWorkItemResults(
			item.serverId,
			[{ ...result, id: item.id, attempt: item.attempts }],
			{ source: "legacy_callback" },
		);
		if (completion.accepted.includes(item.id)) {
			return "completed";
		}
		if (completion.retryable.some((retryable) => retryable.id === item.id)) {
			return "pending";
		}
		if (
			!completion.rejected.some(
				(rejected) =>
					rejected.id === item.id && rejected.reason === "already_terminal",
			)
		) {
			return "conflict";
		}
	}

	const terminal = await db
		.select({ status: workQueue.status })
		.from(workQueue)
		.where(
			and(
				eq(workQueue.serverId, serverId),
				eq(workQueue.type, type),
				inArray(workQueue.status, ["completed", "failed"]),
				sql`${workQueue.payload}::jsonb ->> 'backupId' = ${backupId}`,
			),
		)
		.orderBy(desc(workQueue.createdAt))
		.limit(1)
		.then((rows) => rows[0]);

	if (terminal?.status !== result.status) return "not_found";
	if (type !== "backup_volume" || result.status !== "completed") {
		return "completed";
	}

	const output = result.output as WorkOutputByType["backup_volume"] | undefined;
	if (!output) return "not_found";
	const backup = await db
		.select({
			sizeBytes: volumeBackups.sizeBytes,
			checksum: volumeBackups.checksum,
		})
		.from(volumeBackups)
		.where(
			and(eq(volumeBackups.id, backupId), eq(volumeBackups.serverId, serverId)),
		)
		.then((rows) => rows[0]);

	return backup?.sizeBytes === output.sizeBytes &&
		backup.checksum?.toLowerCase() === output.checksum.toLowerCase()
		? "completed"
		: "not_found";
}
