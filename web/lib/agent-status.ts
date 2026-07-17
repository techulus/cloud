import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
	type AgentHealth,
	type ContainerHealth,
	deployments,
	type NetworkHealth,
	rollouts,
	servers,
	serviceRevisions,
	services,
	workQueue,
} from "@/db/schema";
import {
	AUTOHEAL_MAX_RECREATES,
	AUTOHEAL_MAX_RESTARTS,
	AUTOHEAL_UNHEALTHY_REPORTS,
	getStartingHealthCheckFailureUpdate,
	getSteadyStateRecreateDecision,
} from "@/lib/autoheal-policy";
import {
	isObservedActiveContainer,
	isObservedReady,
	markDeploymentFailedRemoved,
	type ObservedPhase,
	observedStartingPhases,
	runtimeExpectedStates,
} from "@/lib/deployment-status";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { isRoutingSyncAcknowledgementEligible } from "@/lib/routing-sync";
import { getServerlessWakeFailureUpdate } from "@/lib/serverless-wake-failures";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";
import { ingestRolloutLog } from "@/lib/victoria-logs";
import { enqueueWork } from "@/lib/work-queue";

type ContainerStatus = {
	deploymentId: string;
	containerId: string;
	status: "running" | "stopped" | "failed";
	healthStatus: "none" | "starting" | "healthy" | "unhealthy";
};

type DeploymentError = {
	deploymentId: string;
	message: string;
};

export type ServerlessTransition =
	| { id?: string; type: "sleep"; deploymentId: string; containerId: string }
	| { id?: string; type: "wake_started"; deploymentId: string }
	| { id?: string; type: "wake_failed"; deploymentId: string; error: string };

export type ServerlessTransitionResult = {
	id?: string;
	type?: ServerlessTransition["type"];
	deploymentId?: string;
	outcome: "applied" | "already_applied" | "rejected";
	reason?: string;
};

export function shouldAttachReportedContainer(observedPhase: ObservedPhase) {
	return (observedStartingPhases as readonly ObservedPhase[]).includes(
		observedPhase,
	);
}

export function getStoppedContainerReportUpdate(deployment: {
	runtimeDesiredState: string;
	observedPhase?: string;
}) {
	if (deployment.runtimeDesiredState === "stopped") {
		return {
			containerId: null,
			observedPhase: "sleeping" as const,
			healthStatus: null,
		};
	}
	if (deployment.observedPhase === "waking") {
		return {
			observedPhase: "waking" as const,
			healthStatus: null,
		};
	}

	return {
		observedPhase: "stopped" as const,
		healthStatus: "none" as const,
	};
}

export function getStaleStoppedServerlessReportUpdate({
	hasHealthCheck,
	healthStatus,
}: {
	hasHealthCheck: boolean;
	healthStatus: ContainerStatus["healthStatus"];
}) {
	const recovered = healthStatus === "healthy" || healthStatus === "none";

	return {
		observedPhase: recovered ? ("healthy" as const) : ("starting" as const),
		healthStatus: hasHealthCheck
			? recovered
				? healthStatus
				: ("starting" as const)
			: ("none" as const),
		serverlessWakeFailureCount: 0,
	};
}

function isMigrationTargetStarting(status: string | null | undefined) {
	return status === "deploying_target" || status === "starting";
}

async function getServerLogName(serverId: string) {
	const server = await db
		.select({ name: servers.name })
		.from(servers)
		.where(eq(servers.id, serverId))
		.then((r) => r[0]);

	return server?.name || serverId;
}

async function completeTargetMigration(serviceId: string) {
	await db
		.update(services)
		.set({
			migrationStatus: null,
			migrationTargetServerId: null,
			migrationBackupId: null,
			migrationError: null,
		})
		.where(
			and(
				eq(services.id, serviceId),
				inArray(services.migrationStatus, ["deploying_target", "starting"]),
			),
		);
}

async function applyDeploymentErrors(
	serverId: string,
	errors: DeploymentError[],
) {
	for (const error of errors) {
		if (!error.deploymentId || !error.message?.trim()) continue;

		const deployment = await db
			.select({
				id: deployments.id,
				serviceId: deployments.serviceId,
				rolloutId: deployments.rolloutId,
				observedPhase: deployments.observedPhase,
				serverlessWakeFailureCount: deployments.serverlessWakeFailureCount,
				revisionSpec: serviceRevisions.specification,
				rolloutStatus: rollouts.status,
				serverName: servers.name,
			})
			.from(deployments)
			.innerJoin(servers, eq(deployments.serverId, servers.id))
			.innerJoin(
				serviceRevisions,
				eq(deployments.serviceRevisionId, serviceRevisions.id),
			)
			.leftJoin(rollouts, eq(deployments.rolloutId, rollouts.id))
			.where(
				and(
					eq(deployments.id, error.deploymentId),
					eq(deployments.serverId, serverId),
				),
			)
			.then((rows) => rows[0]);

		if (!deployment) {
			continue;
		}

		const isServerlessWakeDeployment = deployment.observedPhase === "waking";
		const isActiveRolloutDeployment =
			!isServerlessWakeDeployment &&
			deployment.rolloutId &&
			deployment.rolloutStatus === "in_progress";

		if (!isActiveRolloutDeployment && !isServerlessWakeDeployment) {
			continue;
		}

		const updated = await db
			.update(deployments)
			.set(
				isServerlessWakeDeployment
					? getServerlessWakeFailureUpdate({
							serverlessEnabled: deployment.revisionSpec.serverless.enabled,
							currentFailureCount: deployment.serverlessWakeFailureCount,
							failedStage: "serverless_wake",
						})
					: markDeploymentFailedRemoved("deploying"),
			)
			.where(
				and(
					eq(deployments.id, deployment.id),
					inArray(
						deployments.observedPhase,
						isServerlessWakeDeployment
							? ["waking"]
							: ["pending", "pulling", "starting"],
					),
				),
			)
			.returning({ id: deployments.id });

		if (updated.length === 0) continue;

		if (isServerlessWakeDeployment) {
			console.log(
				`[serverless:wake] deployment ${deployment.id} failed on server ${deployment.serverName}: ${formatDeploymentError(error.message)}`,
			);
			await inngest.send(
				inngestEvents.resourceStatusChanged.create({
					type: "deployment",
					id: deployment.id,
					parentType: "service",
					parentId: deployment.serviceId,
				}),
			);
			continue;
		}

		if (!deployment.rolloutId) continue;

		await ingestRolloutLog(
			deployment.rolloutId,
			deployment.serviceId,
			"deploying",
			`Deployment failed on server ${deployment.serverName}: ${formatDeploymentError(error.message)}`,
		);

		await inngest.send(
			inngestEvents.resourceStatusChanged.create({
				type: "deployment",
				id: deployment.id,
				parentType: "rollout",
				parentId: deployment.rolloutId,
			}),
		);
	}
}

async function applyServerlessTransitions(
	serverId: string,
	transitions: unknown[],
): Promise<ServerlessTransitionResult[]> {
	const results: ServerlessTransitionResult[] = [];

	for (const transitionValue of transitions) {
		const resultBase = getServerlessTransitionResultBase(transitionValue);
		if (!isValidServerlessTransition(transitionValue)) {
			console.log(`[serverless:status] rejected malformed transition`);
			results.push({
				...resultBase,
				outcome: "rejected",
				reason: "malformed transition",
			});
			continue;
		}
		const transition = transitionValue;

		const validResultBase = {
			id: transition.id,
			type: transition.type,
			deploymentId: transition.deploymentId,
		};

		const deployment = await db
			.select({
				id: deployments.id,
				serviceId: deployments.serviceId,
				serverId: deployments.serverId,
				containerId: deployments.containerId,
				runtimeDesiredState: deployments.runtimeDesiredState,
				trafficState: deployments.trafficState,
				observedPhase: deployments.observedPhase,
				serverlessWakeFailureCount: deployments.serverlessWakeFailureCount,
				revisionSpec: serviceRevisions.specification,
				serverIsProxy: servers.isProxy,
				serverName: servers.name,
			})
			.from(deployments)
			.innerJoin(
				serviceRevisions,
				eq(deployments.serviceRevisionId, serviceRevisions.id),
			)
			.innerJoin(servers, eq(deployments.serverId, servers.id))
			.where(eq(deployments.id, transition.deploymentId))
			.then((rows) => rows[0]);

		const invalidReason = getInvalidServerlessTransitionReason({
			serverId,
			transition,
			deployment,
		});
		if (invalidReason || !deployment) {
			console.log(
				`[serverless:status] rejected ${transition.type} for deployment ${transition.deploymentId}: ${invalidReason}`,
			);
			results.push({
				...validResultBase,
				outcome: isAlreadyAppliedServerlessTransition(transition, deployment)
					? "already_applied"
					: "rejected",
				reason: invalidReason ?? "deployment not found",
			});
			continue;
		}

		if (transition.type === "sleep") {
			const updated = await db
				.update(deployments)
				.set({
					runtimeDesiredState: "stopped",
					observedPhase: "sleeping",
					containerId: null,
					healthStatus: null,
					failedStage: null,
				})
				.where(
					and(
						eq(deployments.id, transition.deploymentId),
						eq(deployments.serverId, serverId),
						eq(deployments.containerId, transition.containerId),
						eq(deployments.runtimeDesiredState, "running"),
						inArray(deployments.observedPhase, ["healthy", "running"]),
					),
				)
				.returning({ id: deployments.id });

			if (updated.length > 0) {
				console.log(
					`[serverless:status] deployment ${transition.deploymentId} slept on proxy ${deployment.serverName}`,
				);
				await emitDeploymentStatusChanged(
					transition.deploymentId,
					deployment.serviceId,
				);
				results.push({ ...validResultBase, outcome: "applied" });
			} else {
				const outcome = isAlreadyAppliedServerlessTransition(
					transition,
					deployment,
				)
					? "already_applied"
					: "rejected";
				const reason =
					outcome === "already_applied"
						? "sleep already applied"
						: "sleep update matched zero rows";
				console.log(
					`[serverless:status] ${outcome} ${transition.type} for deployment ${transition.deploymentId}: ${reason}`,
				);
				results.push({ ...validResultBase, outcome, reason });
			}
			continue;
		}

		if (transition.type === "wake_started") {
			const updated = await db
				.update(deployments)
				.set({
					runtimeDesiredState: "running",
					observedPhase: "waking",
					containerId: null,
					healthStatus: null,
					failedStage: null,
				})
				.where(
					and(
						eq(deployments.id, transition.deploymentId),
						eq(deployments.serverId, serverId),
						eq(deployments.runtimeDesiredState, "stopped"),
						eq(deployments.observedPhase, "sleeping"),
					),
				)
				.returning({ id: deployments.id });

			if (updated.length > 0) {
				console.log(
					`[serverless:status] deployment ${transition.deploymentId} wake started on proxy ${deployment.serverName}`,
				);
				await emitDeploymentStatusChanged(
					transition.deploymentId,
					deployment.serviceId,
				);
				results.push({ ...validResultBase, outcome: "applied" });
			} else {
				const outcome = isAlreadyAppliedServerlessTransition(
					transition,
					deployment,
				)
					? "already_applied"
					: "rejected";
				const reason =
					outcome === "already_applied"
						? "wake already applied"
						: "wake update matched zero rows";
				console.log(
					`[serverless:status] ${outcome} ${transition.type} for deployment ${transition.deploymentId}: ${reason}`,
				);
				results.push({ ...validResultBase, outcome, reason });
			}
			continue;
		}

		const updated = await db
			.update(deployments)
			.set(
				getServerlessWakeFailureUpdate({
					serverlessEnabled: deployment.revisionSpec.serverless.enabled,
					currentFailureCount: deployment.serverlessWakeFailureCount,
					failedStage: "serverless_wake",
				}),
			)
			.where(
				and(
					eq(deployments.id, transition.deploymentId),
					eq(deployments.serverId, serverId),
					inArray(deployments.runtimeDesiredState, runtimeExpectedStates),
					inArray(deployments.observedPhase, ["sleeping", "waking"]),
				),
			)
			.returning({ id: deployments.id });

		if (updated.length > 0) {
			console.log(
				`[serverless:status] deployment ${transition.deploymentId} wake failed on proxy ${deployment.serverName}: ${formatDeploymentError(transition.error)}`,
			);
			await emitDeploymentStatusChanged(
				transition.deploymentId,
				deployment.serviceId,
			);
			results.push({ ...validResultBase, outcome: "applied" });
		} else {
			const outcome = isAlreadyAppliedServerlessTransition(
				transition,
				deployment,
			)
				? "already_applied"
				: "rejected";
			const reason =
				outcome === "already_applied"
					? "wake failure already applied"
					: "wake_failed update matched zero rows";
			console.log(
				`[serverless:status] ${outcome} ${transition.type} for deployment ${transition.deploymentId}: ${reason}`,
			);
			results.push({ ...validResultBase, outcome, reason });
		}
	}

	return results;
}

function getServerlessTransitionResultBase(
	transition: unknown,
): Omit<ServerlessTransitionResult, "outcome" | "reason"> {
	if (!transition || typeof transition !== "object") {
		return {};
	}
	const candidate = transition as Record<string, unknown>;
	return {
		id: typeof candidate.id === "string" ? candidate.id : undefined,
		type: isServerlessTransitionType(candidate.type)
			? candidate.type
			: undefined,
		deploymentId:
			typeof candidate.deploymentId === "string"
				? candidate.deploymentId
				: undefined,
	};
}

function isServerlessTransitionType(
	value: unknown,
): value is ServerlessTransition["type"] {
	return (
		value === "sleep" || value === "wake_started" || value === "wake_failed"
	);
}

export function getSleepTransitionDeploymentIds(
	transitions: unknown[],
): Set<string> {
	return new Set(
		transitions
			.filter(isValidServerlessTransition)
			.filter((transition) => transition.type === "sleep")
			.map((transition) => transition.deploymentId),
	);
}

function isAlreadyAppliedServerlessTransition(
	transition: ServerlessTransition,
	deployment:
		| {
				runtimeDesiredState: string;
				observedPhase: string;
		  }
		| undefined,
) {
	if (!deployment) return false;
	if (transition.type === "sleep") {
		return (
			deployment.runtimeDesiredState === "stopped" &&
			deployment.observedPhase === "sleeping"
		);
	}
	if (transition.type === "wake_started") {
		return (
			deployment.runtimeDesiredState === "running" &&
			["waking", "starting", "healthy", "running"].includes(
				deployment.observedPhase,
			)
		);
	}
	if (transition.type === "wake_failed") {
		return ["sleeping", "failed"].includes(deployment.observedPhase);
	}
	return false;
}

function isValidServerlessTransition(
	transition: unknown,
): transition is ServerlessTransition {
	if (!transition || typeof transition !== "object") return false;
	const candidate = transition as ServerlessTransition;
	if (typeof candidate.deploymentId !== "string" || !candidate.deploymentId) {
		return false;
	}
	if (candidate.type === "sleep") {
		return typeof candidate.containerId === "string" && !!candidate.containerId;
	}
	if (candidate.type === "wake_started") {
		return true;
	}
	if (candidate.type === "wake_failed") {
		return typeof candidate.error === "string" && !!candidate.error.trim();
	}
	return false;
}

function getInvalidServerlessTransitionReason({
	serverId,
	transition,
	deployment,
}: {
	serverId: string;
	transition: ServerlessTransition;
	deployment:
		| {
				serverId: string;
				containerId: string | null;
				runtimeDesiredState: string;
				trafficState: string;
				observedPhase: string;
				revisionSpec: ServiceRevisionSpec;
				serverIsProxy: boolean;
		  }
		| undefined;
}) {
	if (!deployment) return "deployment not found";
	if (deployment.serverId !== serverId)
		return "deployment belongs to another server";
	if (!deployment.serverIsProxy) return "server is not a proxy";
	if (!deployment.revisionSpec.serverless.enabled) {
		return "service is not serverless";
	}
	if (deployment.runtimeDesiredState === "removed") {
		return "deployment is removed";
	}

	if (transition.type === "sleep") {
		if (deployment.runtimeDesiredState !== "running") {
			return `deployment is not expected running (${deployment.runtimeDesiredState})`;
		}
		if (!["healthy", "running"].includes(deployment.observedPhase)) {
			return `deployment is not sleepable from ${deployment.observedPhase}`;
		}
		if (deployment.containerId !== transition.containerId) {
			return "stale containerId";
		}
	}

	if (
		transition.type === "wake_started" &&
		deployment.observedPhase !== "sleeping"
	) {
		return `deployment is not sleeping (${deployment.observedPhase})`;
	}

	if (
		transition.type === "wake_failed" &&
		!["sleeping", "waking"].includes(deployment.observedPhase)
	) {
		return `deployment is not waking or sleeping (${deployment.observedPhase})`;
	}

	return null;
}

async function emitDeploymentStatusChanged(
	deploymentId: string,
	serviceId: string,
) {
	await inngest.send(
		inngestEvents.resourceStatusChanged.create({
			type: "deployment",
			id: deploymentId,
			parentType: "service",
			parentId: serviceId,
		}),
	);
}

function formatDeploymentError(message: string): string {
	return message.trim().replace(/\s+/g, " ").slice(0, 1000);
}

export type StatusReport = {
	resources?: {
		cpuCores: number;
		memoryMb: number;
		diskGb: number;
	};
	publicIp?: string;
	privateIp?: string;
	meta?: Record<string, string>;
	containers: ContainerStatus[];
	routingSyncedRolloutIds?: string[];
	networkHealth?: NetworkHealth;
	containerHealth?: ContainerHealth;
	agentHealth?: AgentHealth;
	deploymentErrors?: DeploymentError[];
};

export async function applyStatusReport(
	serverId: string,
	report: StatusReport,
	serverlessTransitions: unknown[] = [],
) {
	const updateData: Record<string, unknown> = {
		lastHeartbeat: new Date(),
		status: "online",
	};
	let completedAgentUpgradeTarget: string | null = null;

	if (report.resources) {
		if (report.resources.cpuCores !== undefined) {
			updateData.resourcesCpu = report.resources.cpuCores;
		}
		if (report.resources.memoryMb !== undefined) {
			updateData.resourcesMemory = report.resources.memoryMb;
		}
		if (report.resources.diskGb !== undefined) {
			updateData.resourcesDisk = report.resources.diskGb;
		}
	}

	if (report.publicIp) {
		updateData.publicIp = report.publicIp;
	}

	updateData.privateIp = report.privateIp || null;

	if (report.meta) {
		updateData.meta = report.meta;
	}

	if (report.networkHealth) {
		updateData.networkHealth = report.networkHealth;
	}
	if (report.containerHealth) {
		updateData.containerHealth = report.containerHealth;
	}
	if (report.agentHealth) {
		updateData.agentHealth = report.agentHealth;

		const [server] = await db
			.select({
				agentUpgradeTargetVersion: servers.agentUpgradeTargetVersion,
				agentUpgradeStatus: servers.agentUpgradeStatus,
			})
			.from(servers)
			.where(eq(servers.id, serverId))
			.limit(1);

		if (
			server?.agentUpgradeTargetVersion === report.agentHealth.version &&
			server.agentUpgradeStatus !== "succeeded" &&
			server.agentUpgradeStatus !== "idle"
		) {
			updateData.agentUpgradeStatus = "succeeded";
			updateData.agentUpgradeError = null;
			completedAgentUpgradeTarget = report.agentHealth.version;
		}
	}

	await db.update(servers).set(updateData).where(eq(servers.id, serverId));
	if (completedAgentUpgradeTarget) {
		await db
			.update(workQueue)
			.set({ status: "completed" })
			.where(
				and(
					eq(workQueue.serverId, serverId),
					eq(workQueue.type, "upgrade_agent"),
					inArray(workQueue.status, ["pending", "processing"]),
				),
			);
	}

	let serverLogName: string | undefined;
	const getCurrentServerLogName = async () => {
		serverLogName ??= await getServerLogName(serverId);
		return serverLogName;
	};

	await applyDeploymentErrors(serverId, report.deploymentErrors || []);
	const serverlessTransitionResults = await applyServerlessTransitions(
		serverId,
		serverlessTransitions,
	);
	const sleepTransitionDeploymentIds = getSleepTransitionDeploymentIds(
		serverlessTransitions,
	);

	const reportedDeploymentIds = report.containers
		.map((c) => c.deploymentId)
		.filter((id) => id !== "");

	const trackedDeployments = await db
		.select({
			id: deployments.id,
			containerId: deployments.containerId,
			runtimeDesiredState: deployments.runtimeDesiredState,
			observedPhase: deployments.observedPhase,
		})
		.from(deployments)
		.where(
			and(
				eq(deployments.serverId, serverId),
				or(
					isNotNull(deployments.containerId),
					eq(deployments.runtimeDesiredState, "removed"),
				),
			),
		);

	for (const dep of trackedDeployments) {
		if (!reportedDeploymentIds.includes(dep.id)) {
			if (dep.runtimeDesiredState === "removed") {
				console.log(
					`[status:${serverId.slice(0, 8)}] deployment ${dep.id.slice(0, 8)} was removed and container gone, deleting`,
				);
				await db.delete(deployments).where(eq(deployments.id, dep.id));
			} else if (
				isObservedActiveContainer(dep.observedPhase) &&
				!sleepTransitionDeploymentIds.has(dep.id)
			) {
				console.log(
					`[status:${serverId.slice(0, 8)}] deployment ${dep.id.slice(0, 8)} NOT reported, marking UNKNOWN`,
				);
				await db
					.update(deployments)
					.set({ observedPhase: "unknown", healthStatus: null })
					.where(eq(deployments.id, dep.id));
			}
		}
	}

	for (const container of report.containers) {
		const healthStatus = container.healthStatus;

		let [deployment] = container.deploymentId
			? await db
					.select()
					.from(deployments)
					.where(eq(deployments.id, container.deploymentId))
			: await db
					.select()
					.from(deployments)
					.where(eq(deployments.containerId, container.containerId));

		if (!deployment && container.deploymentId) {
			continue;
		}

		if (!deployment) {
			const [stuckDeployment] = await db
				.select()
				.from(deployments)
				.where(
					and(
						eq(deployments.serverId, serverId),
						isNull(deployments.containerId),
						inArray(deployments.observedPhase, observedStartingPhases),
					),
				);

			if (stuckDeployment) {
				console.log(
					`[health:recover] found stuck deployment ${stuckDeployment.id}, attaching container ${container.containerId}`,
				);

				const [service, revision] = await Promise.all([
					db
						.select()
						.from(services)
						.where(eq(services.id, stuckDeployment.serviceId))
						.then((r) => r[0]),
					db
						.select({ specification: serviceRevisions.specification })
						.from(serviceRevisions)
						.where(eq(serviceRevisions.id, stuckDeployment.serviceRevisionId))
						.then((r) => r[0]),
				]);

				const hasHealthCheck = revision?.specification.healthCheck != null;
				const newStatus = hasHealthCheck ? "starting" : "healthy";

				await db
					.update(deployments)
					.set({
						containerId: container.containerId,
						observedPhase: newStatus,
						healthStatus: hasHealthCheck ? "starting" : "none",
						serverlessWakeFailureCount: 0,
					})
					.where(eq(deployments.id, stuckDeployment.id));

				deployment = {
					...stuckDeployment,
					observedPhase: newStatus,
					containerId: container.containerId,
					healthStatus: hasHealthCheck ? "starting" : "none",
				};

				if (!hasHealthCheck) {
					if (deployment.rolloutId) {
						await inngest.send(
							inngestEvents.resourceStatusChanged.create({
								type: "deployment",
								id: deployment.id,
								parentType: "rollout",
								parentId: deployment.rolloutId,
							}),
						);
					}

					if (isMigrationTargetStarting(service?.migrationStatus)) {
						console.log(
							`[migration] target service ${service.id} healthy, promoting`,
						);
						await completeTargetMigration(service.id);
					}
				}
			}
		}

		if (!deployment) {
			continue;
		}

		const updateFields: Record<string, unknown> = { healthStatus };
		let autohealRestartPayload: Record<string, unknown> | null = null;
		let autohealRecreatePayload: Record<string, unknown> | null = null;
		let autohealFailed = false;

		if (deployment.containerId !== container.containerId) {
			updateFields.containerId = container.containerId;
		}

		if (container.status === "stopped") {
			Object.assign(updateFields, getStoppedContainerReportUpdate(deployment));
			await db
				.update(deployments)
				.set(updateFields)
				.where(eq(deployments.id, deployment.id));
			continue;
		}

		if (container.status === "failed") {
			updateFields.observedPhase = "failed";
			updateFields.healthStatus = null;
			updateFields.failedStage ??= "container_failed";
			await db
				.update(deployments)
				.set(updateFields)
				.where(eq(deployments.id, deployment.id));
			if (deployment.rolloutId) {
				await inngest.send(
					inngestEvents.resourceStatusChanged.create({
						type: "deployment",
						id: deployment.id,
						parentType: "rollout",
						parentId: deployment.rolloutId,
					}),
				);
			}
			continue;
		}

		if (
			container.status === "running" &&
			deployment.runtimeDesiredState === "running" &&
			["sleeping", "stopped"].includes(deployment.observedPhase)
		) {
			const revision = await db
				.select({ specification: serviceRevisions.specification })
				.from(serviceRevisions)
				.where(eq(serviceRevisions.id, deployment.serviceRevisionId))
				.then((r) => r[0]);

			if (revision?.specification.serverless.enabled) {
				Object.assign(
					updateFields,
					getStaleStoppedServerlessReportUpdate({
						hasHealthCheck: revision.specification.healthCheck != null,
						healthStatus,
					}),
				);
				console.log(
					`[health:restore] serverless deployment ${deployment.id} restored from ${deployment.observedPhase} to ${updateFields.observedPhase}`,
				);
			}
		}

		if (shouldAttachReportedContainer(deployment.observedPhase)) {
			if (container.status !== "running") {
				continue;
			}

			const [revision, service] = await Promise.all([
				db
					.select({ specification: serviceRevisions.specification })
					.from(serviceRevisions)
					.where(eq(serviceRevisions.id, deployment.serviceRevisionId))
					.then((r) => r[0]),
				db
					.select({ migrationStatus: services.migrationStatus })
					.from(services)
					.where(eq(services.id, deployment.serviceId))
					.then((r) => r[0]),
			]);

			const hasHealthCheck = revision?.specification.healthCheck != null;
			const newStatus = hasHealthCheck ? "starting" : "healthy";
			updateFields.observedPhase = newStatus;
			if (deployment.observedPhase === "waking") {
				updateFields.serverlessWakeFailureCount = 0;
			}
			if (hasHealthCheck) {
				updateFields.healthStatus = "starting";
			}
			console.log(
				`[health:attach] deployment ${deployment.id} transitioning from ${deployment.observedPhase} to ${newStatus}`,
			);

			if (deployment.rolloutId) {
				const currentServerName = await getCurrentServerLogName();
				await ingestRolloutLog(
					deployment.rolloutId,
					deployment.serviceId,
					"deploying",
					`Starting container on server ${currentServerName}`,
				);
			}

			if (!hasHealthCheck) {
				await db
					.update(deployments)
					.set(updateFields)
					.where(eq(deployments.id, deployment.id));

				if (deployment.rolloutId) {
					await inngest.send(
						inngestEvents.resourceStatusChanged.create({
							type: "deployment",
							id: deployment.id,
							parentType: "rollout",
							parentId: deployment.rolloutId,
						}),
					);
				}

				if (isMigrationTargetStarting(service?.migrationStatus)) {
					console.log(
						`[migration] deployment ${deployment.id} healthy (no health check), promoting`,
					);
					await completeTargetMigration(deployment.serviceId);
				}
				continue;
			}
		}

		if (deployment.observedPhase === "unknown") {
			const newStatus =
				healthStatus === "healthy" || healthStatus === "none"
					? "running"
					: "starting";
			updateFields.observedPhase = newStatus;
			console.log(
				`[health:restore] deployment ${deployment.id} restored from unknown to ${newStatus}`,
			);
		}

		const canAutoheal =
			container.status === "running" &&
			isObservedReady(deployment.observedPhase);
		const healthRecovered =
			healthStatus === "healthy" || healthStatus === "none";
		if (canAutoheal && healthRecovered) {
			await completeTargetMigration(deployment.serviceId);
		}

		if (canAutoheal && healthStatus === "unhealthy") {
			const unhealthyReportCount = (deployment.unhealthyReportCount ?? 0) + 1;
			updateFields.unhealthyReportCount = unhealthyReportCount;

			if (unhealthyReportCount >= AUTOHEAL_UNHEALTHY_REPORTS) {
				const restartCount = deployment.autohealRestartCount ?? 0;

				if (restartCount >= AUTOHEAL_MAX_RESTARTS) {
					const rollout = deployment.rolloutId
						? await db
								.select({ status: rollouts.status })
								.from(rollouts)
								.where(eq(rollouts.id, deployment.rolloutId))
								.then((r) => r[0])
						: null;
					const isRolloutDeployment = rollout?.status === "in_progress";

					if (isRolloutDeployment) {
						console.log(
							`[autoheal] rollout deployment ${deployment.id} exceeded restart limit`,
						);
						Object.assign(
							updateFields,
							markDeploymentFailedRemoved("autoheal"),
						);
						autohealFailed = true;
					} else {
						autohealRecreatePayload = prepareAutohealRecreatePayload({
							deployment,
							containerId: container.containerId,
							updateFields,
						});
					}
				} else {
					console.log(
						`[autoheal] restarting unhealthy deployment ${deployment.id} (${restartCount + 1}/${AUTOHEAL_MAX_RESTARTS})`,
					);
					updateFields.unhealthyReportCount = 0;
					updateFields.autohealRestartCount = restartCount + 1;
					autohealRestartPayload = {
						deploymentId: deployment.id,
						containerId: container.containerId,
						reason: "autoheal_unhealthy",
					};
				}
			}
		} else if (healthRecovered) {
			updateFields.unhealthyReportCount = 0;
			updateFields.autohealRecreateCount = 0;
		}

		await db
			.update(deployments)
			.set(updateFields)
			.where(eq(deployments.id, deployment.id));

		if (autohealRestartPayload) {
			await enqueueWork(serverId, "restart", autohealRestartPayload);
		}
		if (autohealRecreatePayload) {
			await enqueueWork(serverId, "force_cleanup", autohealRecreatePayload);
		}

		if (autohealFailed && deployment.rolloutId) {
			const currentServerName = await getCurrentServerLogName();
			await ingestRolloutLog(
				deployment.rolloutId,
				deployment.serviceId,
				"autoheal",
				`Container exceeded autoheal restart limit on server ${currentServerName}`,
			);
			await inngest.send(
				inngestEvents.resourceStatusChanged.create({
					type: "deployment",
					id: deployment.id,
					parentType: "rollout",
					parentId: deployment.rolloutId,
				}),
			);
		}

		if (
			deployment.observedPhase === "starting" &&
			container.status === "running" &&
			(healthStatus === "healthy" || healthStatus === "none")
		) {
			console.log(
				`[health] deployment ${deployment.id} is now healthy (healthStatus=${healthStatus})`,
			);

			await db
				.update(deployments)
				.set({
					observedPhase: "healthy",
					autohealRestartCount: 0,
					autohealRecreateCount: 0,
					serverlessWakeFailureCount: 0,
				})
				.where(eq(deployments.id, deployment.id));

			if (deployment.rolloutId) {
				const currentServerName = await getCurrentServerLogName();
				await ingestRolloutLog(
					deployment.rolloutId,
					deployment.serviceId,
					"health_check",
					`Container is healthy on server ${currentServerName}`,
				);
				await inngest.send(
					inngestEvents.resourceStatusChanged.create({
						type: "deployment",
						id: deployment.id,
						parentType: "rollout",
						parentId: deployment.rolloutId,
					}),
				);
			}

			const deployedService = await db
				.select({ migrationStatus: services.migrationStatus })
				.from(services)
				.where(eq(services.id, deployment.serviceId))
				.then((r) => r[0]);

			if (isMigrationTargetStarting(deployedService?.migrationStatus)) {
				console.log(
					`[migration] deployment ${deployment.id} healthy, promoting`,
				);
				await completeTargetMigration(deployment.serviceId);
			}
		}

		if (
			deployment.observedPhase === "starting" &&
			healthStatus === "unhealthy"
		) {
			console.log(`[health] deployment ${deployment.id} failed health check`);
			const rollout = deployment.rolloutId
				? await db
						.select({ status: rollouts.status })
						.from(rollouts)
						.where(eq(rollouts.id, deployment.rolloutId))
						.then((r) => r[0])
				: null;
			const isRolloutDeployment = rollout?.status === "in_progress";
			const recreateCount = deployment.autohealRecreateCount ?? 0;
			const { update, recreateLimitReached } =
				getStartingHealthCheckFailureUpdate({
					isRolloutDeployment,
					recreateCount,
				});

			await db
				.update(deployments)
				.set(update)
				.where(eq(deployments.id, deployment.id));

			if (isRolloutDeployment && deployment.rolloutId) {
				const currentServerName = await getCurrentServerLogName();
				await ingestRolloutLog(
					deployment.rolloutId,
					deployment.serviceId,
					"health_check",
					`Container failed health check on server ${currentServerName}`,
				);
				await inngest.send(
					inngestEvents.resourceStatusChanged.create({
						type: "deployment",
						id: deployment.id,
						parentType: "rollout",
						parentId: deployment.rolloutId,
					}),
				);
			}

			if (!isRolloutDeployment && !recreateLimitReached) {
				await enqueueWork(serverId, "force_cleanup", {
					reason: "autoheal_recreate",
					deploymentId: deployment.id,
					serviceId: deployment.serviceId,
					containerIds: [container.containerId],
				});
			} else if (recreateLimitReached) {
				console.log(
					`[autoheal] deployment ${deployment.id} exceeded recreate limit`,
				);
			}
		}
	}

	const routingSyncRolloutIds = [
		...new Set(report.routingSyncedRolloutIds || []),
	].filter(Boolean);
	if (routingSyncRolloutIds.length > 0) {
		const reportedRollouts = await db
			.select({
				id: rollouts.id,
				serviceId: rollouts.serviceId,
				status: rollouts.status,
				currentStage: rollouts.currentStage,
				routingTargets: rollouts.routingTargets,
			})
			.from(rollouts)
			.where(inArray(rollouts.id, routingSyncRolloutIds));
		const currentServerName = await getCurrentServerLogName();

		for (const rollout of reportedRollouts) {
			if (!isRoutingSyncAcknowledgementEligible(rollout, serverId)) continue;

			await ingestRolloutLog(
				rollout.id,
				rollout.serviceId,
				"dns_sync",
				`Routing synced on server ${currentServerName}`,
			);
			await inngest.send(
				inngestEvents.serverDnsSynced.create({
					serverId,
					rolloutId: rollout.id,
				}),
			);
		}
	}

	return { serverlessTransitionResults };
}

function prepareAutohealRecreatePayload({
	deployment,
	containerId,
	updateFields,
}: {
	deployment: typeof deployments.$inferSelect;
	containerId: string;
	updateFields: Record<string, unknown>;
}): Record<string, unknown> | null {
	const decision = getSteadyStateRecreateDecision({ deployment, containerId });
	Object.assign(updateFields, decision.updateFields);

	if (decision.limitReached) {
		console.log(
			`[autoheal] deployment ${deployment.id} exceeded recreate limit`,
		);
		return null;
	}

	console.log(
		`[autoheal] recreating steady-state deployment ${deployment.id} after restart limit (${(deployment.autohealRecreateCount ?? 0) + 1}/${AUTOHEAL_MAX_RECREATES})`,
	);
	return decision.cleanupPayload;
}
