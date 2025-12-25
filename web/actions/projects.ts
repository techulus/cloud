"use server";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	projects,
	secrets,
	servers,
	servicePorts,
	services,
	workQueue,
} from "@/db/schema";
import { syncServiceRoute, deleteRoute } from "@/lib/caddy";
import { selectBestServer } from "@/lib/placement";

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function normalizeImage(image: string): string {
	if (!image.includes("/")) {
		return `docker.io/library/${image}`;
	}
	if (!image.includes(".") && image.split("/").length === 2) {
		return `docker.io/${image}`;
	}
	return image;
}

export async function createProject(name: string) {
	const id = randomUUID();
	const slug = slugify(name);

	await db.insert(projects).values({
		id,
		name,
		slug,
	});

	revalidatePath("/dashboard");
	return { id, name, slug };
}

export async function listProjects() {
	return db.select().from(projects).orderBy(projects.createdAt);
}

export async function getProject(id: string) {
	const results = await db.select().from(projects).where(eq(projects.id, id));
	return results[0] || null;
}

export async function deleteProject(id: string) {
	await db.delete(projects).where(eq(projects.id, id));
	revalidatePath("/dashboard");
}

export async function createService(
	projectId: string,
	name: string,
	image: string,
	ports: number[],
) {
	const id = randomUUID();

	await db.insert(services).values({
		id,
		projectId,
		name,
		image,
	});

	for (const port of ports) {
		await db.insert(servicePorts).values({
			id: randomUUID(),
			serviceId: id,
			port,
		});
	}

	revalidatePath(`/dashboard/projects/${projectId}`);
	return { id, name, image, ports };
}

export async function listServices(projectId: string) {
	return db
		.select()
		.from(services)
		.where(eq(services.projectId, projectId))
		.orderBy(services.createdAt);
}

export async function getService(id: string) {
	const results = await db.select().from(services).where(eq(services.id, id));
	return results[0] || null;
}

export async function deleteService(serviceId: string) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	const activeDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const hasActiveDeployments = activeDeployments.some(
		(d) => d.status === "running" || d.status === "stopping" || d.status === "pulling"
	);

	if (hasActiveDeployments) {
		throw new Error("Stop all deployments before deleting the service");
	}

	for (const deployment of activeDeployments) {
		await db.delete(deploymentPorts).where(eq(deploymentPorts.deploymentId, deployment.id));
	}
	await db.delete(deployments).where(eq(deployments.serviceId, serviceId));
	await db.delete(secrets).where(eq(secrets.serviceId, serviceId));
	await db.delete(services).where(eq(services.id, serviceId));

	revalidatePath(`/dashboard/projects/${service.projectId}`);
	return { success: true };
}

export async function getServicePorts(serviceId: string) {
	return db
		.select()
		.from(servicePorts)
		.where(eq(servicePorts.serviceId, serviceId))
		.orderBy(servicePorts.port);
}

type PortChange = {
	action: "add" | "remove";
	portId?: string;
	port?: number;
	isPublic?: boolean;
	subdomain?: string;
};

export async function updateServicePorts(serviceId: string, changes: PortChange[]) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	for (const change of changes) {
		if (change.action === "remove" && change.portId) {
			const [portToRemove] = await db
				.select()
				.from(servicePorts)
				.where(eq(servicePorts.id, change.portId));

			if (portToRemove?.isPublic && portToRemove.subdomain) {
				await deleteRoute(portToRemove.subdomain);
			}

			await db.delete(deploymentPorts).where(eq(deploymentPorts.servicePortId, change.portId));
			await db.delete(servicePorts).where(eq(servicePorts.id, change.portId));
		} else if (change.action === "add" && change.port) {
			const existing = await db
				.select()
				.from(servicePorts)
				.where(eq(servicePorts.serviceId, serviceId));

			if (existing.some((p) => p.port === change.port)) {
				throw new Error(`Port ${change.port} already exists`);
			}

			if (change.isPublic) {
				if (!change.subdomain) {
					throw new Error("Subdomain is required for public ports");
				}

				const slug = slugify(change.subdomain);
				if (!slug) {
					throw new Error("Invalid subdomain");
				}

				const existingSubdomain = await db
					.select()
					.from(servicePorts)
					.where(eq(servicePorts.subdomain, slug));

				if (existingSubdomain.length > 0) {
					throw new Error("Subdomain already in use");
				}

				await db.insert(servicePorts).values({
					id: randomUUID(),
					serviceId,
					port: change.port,
					isPublic: true,
					subdomain: slug,
				});
			} else {
				await db.insert(servicePorts).values({
					id: randomUUID(),
					serviceId,
					port: change.port,
					isPublic: false,
				});
			}
		}
	}

	const existingDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const hasRunningDeployment = existingDeployments.some(
		(d) => d.status === "running"
	);

	if (hasRunningDeployment) {
		await deployService(serviceId);
	}

	revalidatePath(`/dashboard/projects/${service.projectId}`);
	return { success: true, redeployed: hasRunningDeployment };
}

export async function getDeploymentPorts(deploymentId: string) {
	return db
		.select({
			id: deploymentPorts.id,
			hostPort: deploymentPorts.hostPort,
			containerPort: servicePorts.port,
		})
		.from(deploymentPorts)
		.innerJoin(servicePorts, eq(deploymentPorts.servicePortId, servicePorts.id))
		.where(eq(deploymentPorts.deploymentId, deploymentId));
}

const PORT_RANGE_START = 30000;
const PORT_RANGE_END = 32767;

async function getUsedPorts(serverId: string): Promise<Set<number>> {
	const existingPorts = await db
		.select({ hostPort: deploymentPorts.hostPort })
		.from(deploymentPorts)
		.innerJoin(deployments, eq(deploymentPorts.deploymentId, deployments.id))
		.where(eq(deployments.serverId, serverId));

	return new Set(existingPorts.map((p) => p.hostPort));
}

async function allocateHostPorts(
	serverId: string,
	count: number,
): Promise<number[]> {
	const usedPorts = await getUsedPorts(serverId);
	const allocated: number[] = [];

	for (let port = PORT_RANGE_START; port <= PORT_RANGE_END && allocated.length < count; port++) {
		if (!usedPorts.has(port)) {
			allocated.push(port);
		}
	}

	if (allocated.length < count) {
		throw new Error("Not enough available ports on this server");
	}

	return allocated;
}

export async function deployService(serviceId: string) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	const existingDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const hasInProgressDeployment = existingDeployments.some(
		(d) => d.status === "pending" || d.status === "pulling" || d.status === "stopping"
	);

	if (hasInProgressDeployment) {
		throw new Error("A deployment is already in progress");
	}

	for (const dep of existingDeployments) {
		if (dep.containerId && dep.status === "running") {
			await db.insert(workQueue).values({
				id: randomUUID(),
				serverId: dep.serverId,
				type: "stop",
				payload: JSON.stringify({
					deploymentId: dep.id,
					containerId: dep.containerId,
				}),
			});
		}
		await db.delete(deploymentPorts).where(eq(deploymentPorts.deploymentId, dep.id));
		await db.delete(deployments).where(eq(deployments.id, dep.id));
	}

	const servicePortsList = await db
		.select()
		.from(servicePorts)
		.where(eq(servicePorts.serviceId, serviceId));

	const onlineServers = await db
		.select()
		.from(servers)
		.where(eq(servers.status, "online"));

	if (onlineServers.length === 0) {
		throw new Error("No online servers available");
	}

	const server = await selectBestServer(onlineServers);

	if (!server) {
		throw new Error("No suitable server available");
	}

	if (!server.wireguardIp) {
		throw new Error("Server has no WireGuard IP");
	}

	const hostPorts = await allocateHostPorts(server.id, servicePortsList.length);

	const deploymentId = randomUUID();
	await db.insert(deployments).values({
		id: deploymentId,
		serviceId,
		serverId: server.id,
		status: "pending",
	});

	const portMappings: { containerPort: number; hostPort: number }[] = [];
	for (let i = 0; i < servicePortsList.length; i++) {
		const sp = servicePortsList[i];
		const hostPort = hostPorts[i];

		await db.insert(deploymentPorts).values({
			id: randomUUID(),
			deploymentId,
			servicePortId: sp.id,
			hostPort,
		});

		portMappings.push({ containerPort: sp.port, hostPort });
	}

	await db.insert(workQueue).values({
		id: randomUUID(),
		serverId: server.id,
		type: "deploy",
		payload: JSON.stringify({
			deploymentId,
			serviceId,
			image: normalizeImage(service.image),
			portMappings,
			wireguardIp: server.wireguardIp,
			name: service.name,
		}),
	});

	revalidatePath(`/dashboard/projects/${service.projectId}`);
	return { deploymentId, serverId: server.id };
}

export async function listDeployments(serviceId: string) {
	return db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId))
		.orderBy(deployments.createdAt);
}

export async function deleteDeployment(deploymentId: string) {
	const deployment = await db
		.select()
		.from(deployments)
		.where(eq(deployments.id, deploymentId));

	if (!deployment[0]) {
		throw new Error("Deployment not found");
	}

	const dep = deployment[0];

	if (dep.status === "running" || dep.status === "pulling") {
		throw new Error("Stop the deployment before deleting");
	}

	await db.delete(deployments).where(eq(deployments.id, deploymentId));

	const service = await getService(dep.serviceId);
	if (service) {
		revalidatePath(`/dashboard/projects/${service.projectId}`);
	}

	return { success: true };
}

export async function stopDeployment(deploymentId: string) {
	const deployment = await db
		.select()
		.from(deployments)
		.where(eq(deployments.id, deploymentId));

	if (!deployment[0]) {
		throw new Error("Deployment not found");
	}

	const dep = deployment[0];

	if (!dep.containerId) {
		throw new Error("No container to stop");
	}

	await db
		.update(deployments)
		.set({ status: "stopping" })
		.where(eq(deployments.id, deploymentId));

	await db.insert(workQueue).values({
		id: randomUUID(),
		serverId: dep.serverId,
		type: "stop",
		payload: JSON.stringify({
			deploymentId: dep.id,
			containerId: dep.containerId,
		}),
	});

	const service = await getService(dep.serviceId);
	if (service) {
		revalidatePath(`/dashboard/projects/${service.projectId}`);
	}

	return { success: true };
}

export async function syncDeploymentRoute(deploymentId: string) {
	const [dep] = await db
		.select()
		.from(deployments)
		.where(eq(deployments.id, deploymentId));

	if (!dep) {
		throw new Error("Deployment not found");
	}

	if (dep.status !== "running") {
		throw new Error("Deployment is not running");
	}

	await syncServiceRoute(dep.serviceId);

	const service = await getService(dep.serviceId);
	if (service) {
		revalidatePath(`/dashboard/projects/${service.projectId}`);
	}

	return { success: true };
}
