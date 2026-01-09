import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { deployments, servers, services, rollouts } from "@/db/schema";
import { eq, and, inArray, isNotNull, isNull } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";

type ContainerStatus = {
	deploymentId: string;
	containerId: string;
	status: "running" | "stopped" | "failed";
	healthStatus: "none" | "starting" | "healthy" | "unhealthy";
};

type StatusReport = {
	resources?: {
		cpuCores: number;
		memoryMb: number;
		diskGb: number;
	};
	publicIp?: string;
	privateIp?: string;
	containers: ContainerStatus[];
};

async function checkRolloutProgress(rolloutId: string): Promise<void> {
	const rolloutDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.rolloutId, rolloutId));

	const newDeployments = rolloutDeployments.filter(
		(d) =>
			d.status !== "running" &&
			d.status !== "stopped" &&
			d.status !== "rolled_back",
	);

	if (newDeployments.length === 0) return;

	const allHealthy = newDeployments.every((d) => d.status === "healthy");

	if (allHealthy) {
		console.log(
			`[rollout:${rolloutId}] all healthy → running, completing rollout`,
		);

		await db
			.update(deployments)
			.set({ status: "running" })
			.where(
				and(
					eq(deployments.rolloutId, rolloutId),
					eq(deployments.status, "healthy"),
				),
			);

		await db
			.update(rollouts)
			.set({
				status: "completed",
				currentStage: "completed",
				completedAt: new Date(),
			})
			.where(eq(rollouts.id, rolloutId));
	}
}

async function handleRolloutFailure(
	rolloutId: string,
	failedStage: string,
): Promise<void> {
	await db
		.update(rollouts)
		.set({ status: "failed", currentStage: failedStage })
		.where(eq(rollouts.id, rolloutId));

	const rolloutDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.rolloutId, rolloutId));

	const newDeployments = rolloutDeployments.filter(
		(d) => d.status !== "running" && d.status !== "stopped",
	);

	for (const dep of newDeployments) {
		await db
			.update(deployments)
			.set({ status: "rolled_back", failedStage: failedStage })
			.where(eq(deployments.id, dep.id));
	}

	await db
		.update(rollouts)
		.set({ status: "rolled_back", completedAt: new Date() })
		.where(eq(rollouts.id, rolloutId));
}

export async function POST(request: NextRequest) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	const { serverId } = auth;
	console.log(`[status:${serverId.slice(0, 8)}] received status report`);

	let report: StatusReport;
	try {
		report = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	console.log(
		`[status:${serverId.slice(0, 8)}] containers reported: ${report.containers.length}`,
	);

	const updateData: Record<string, unknown> = {
		lastHeartbeat: new Date(),
		status: "online",
	};
	console.log(
		`[status:${serverId.slice(0, 8)}] setting server status to ONLINE`,
	);

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

	await db.update(servers).set(updateData).where(eq(servers.id, serverId));

	const reportedDeploymentIds = report.containers
		.map((c) => c.deploymentId)
		.filter((id) => id !== "");

	const activeStatuses = [
		"starting",
		"healthy",
		"running",
		"stopping",
	] as const;

	const activeDeployments = await db
		.select({
			id: deployments.id,
			containerId: deployments.containerId,
			status: deployments.status,
		})
		.from(deployments)
		.where(
			and(
				eq(deployments.serverId, serverId),
				isNotNull(deployments.containerId),
				inArray(deployments.status, activeStatuses),
			),
		);

	console.log(
		`[status:${serverId.slice(0, 8)}] active deployments on this server: ${activeDeployments.length}, reported: ${reportedDeploymentIds.length}`,
	);

	for (const dep of activeDeployments) {
		if (!reportedDeploymentIds.includes(dep.id)) {
			if (dep.status === "stopping") {
				console.log(
					`[status:${serverId.slice(0, 8)}] deployment ${dep.id.slice(0, 8)} was stopping and container gone, marking STOPPED`,
				);
				await db
					.update(deployments)
					.set({ status: "stopped", healthStatus: null, containerId: null })
					.where(eq(deployments.id, dep.id));
			} else {
				console.log(
					`[status:${serverId.slice(0, 8)}] deployment ${dep.id.slice(0, 8)} NOT reported, marking UNKNOWN`,
				);
				await db
					.update(deployments)
					.set({ status: "unknown", healthStatus: null })
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
			const stuckStatuses = ["pending", "pulling"] as const;
			const [stuckDeployment] = await db
				.select()
				.from(deployments)
				.where(
					and(
						eq(deployments.serverId, serverId),
						isNull(deployments.containerId),
						inArray(deployments.status, stuckStatuses),
					),
				);

			if (stuckDeployment) {
				console.log(
					`[health:recover] found stuck deployment ${stuckDeployment.id}, attaching container ${container.containerId}`,
				);

				const service = await db
					.select()
					.from(services)
					.where(eq(services.id, stuckDeployment.serviceId))
					.then((r) => r[0]);

				const hasHealthCheck = service?.healthCheckCmd != null;
				const newStatus = hasHealthCheck ? "starting" : "healthy";

				await db
					.update(deployments)
					.set({
						containerId: container.containerId,
						status: newStatus,
						healthStatus: hasHealthCheck ? "starting" : "none",
					})
					.where(eq(deployments.id, stuckDeployment.id));

				deployment = {
					...stuckDeployment,
					status: newStatus,
					containerId: container.containerId,
				};

				if (!hasHealthCheck && deployment.rolloutId) {
					await checkRolloutProgress(deployment.rolloutId);
					continue;
				}
			} else {
				continue;
			}
		}

		const updateFields: Record<string, unknown> = { healthStatus };
		if (deployment.containerId !== container.containerId) {
			updateFields.containerId = container.containerId;
		}

		if (deployment.status === "pending" || deployment.status === "pulling") {
			const service = await db
				.select()
				.from(services)
				.where(eq(services.id, deployment.serviceId))
				.then((r) => r[0]);

			const hasHealthCheck = service?.healthCheckCmd != null;
			const newStatus = hasHealthCheck ? "starting" : "healthy";
			updateFields.status = newStatus;
			if (hasHealthCheck) {
				updateFields.healthStatus = "starting";
			}
			console.log(
				`[health:attach] deployment ${deployment.id} transitioning from ${deployment.status} to ${newStatus}`,
			);

			if (!hasHealthCheck && deployment.rolloutId) {
				await db
					.update(deployments)
					.set(updateFields)
					.where(eq(deployments.id, deployment.id));
				await checkRolloutProgress(deployment.rolloutId);
				continue;
			}
		}

		if (deployment.status === "unknown") {
			const newStatus =
				healthStatus === "healthy" || healthStatus === "none"
					? "running"
					: "starting";
			updateFields.status = newStatus;
			console.log(
				`[health:restore] deployment ${deployment.id} restored from unknown to ${newStatus}`,
			);
		}

		await db
			.update(deployments)
			.set(updateFields)
			.where(eq(deployments.id, deployment.id));

		if (
			deployment.status === "starting" &&
			(healthStatus === "healthy" || healthStatus === "none")
		) {
			console.log(
				`[health] deployment ${deployment.id} is now healthy (healthStatus=${healthStatus})`,
			);

			await db
				.update(deployments)
				.set({ status: "healthy" })
				.where(eq(deployments.id, deployment.id));

			if (deployment.rolloutId) {
				await checkRolloutProgress(deployment.rolloutId);
			}
		}

		if (deployment.status === "starting" && healthStatus === "unhealthy") {
			console.log(`[health] deployment ${deployment.id} failed health check`);

			await db
				.update(deployments)
				.set({ status: "failed", failedStage: "health_check" })
				.where(eq(deployments.id, deployment.id));

			if (deployment.rolloutId) {
				await handleRolloutFailure(deployment.rolloutId, "health_check");
			}
		}
	}

	const activeRollouts = await db
		.select({ id: rollouts.id })
		.from(rollouts)
		.where(eq(rollouts.status, "in_progress"));

	for (const rollout of activeRollouts) {
		await checkRolloutProgress(rollout.id);
	}

	return NextResponse.json({ ok: true });
}
