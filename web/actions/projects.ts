"use server";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	projects,
	servers,
	servicePorts,
	services,
	workQueue,
} from "@/db/schema";
import { syncServiceRoute } from "@/lib/caddy";

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

function generateSubdomain(): string {
	return randomUUID().replace(/-/g, "").slice(0, 8);
}

export async function createService(
	projectId: string,
	name: string,
	image: string,
	ports: number[],
) {
	const id = randomUUID();
	const subdomain = generateSubdomain();

	await db.insert(services).values({
		id,
		projectId,
		name,
		image,
		exposedDomain: `${subdomain}.techulus.app`,
	});

	for (const port of ports) {
		await db.insert(servicePorts).values({
			id: randomUUID(),
			serviceId: id,
			port,
		});
	}

	revalidatePath(`/dashboard/projects/${projectId}`);
	return { id, name, image, ports, exposedDomain: `${subdomain}.techulus.app` };
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

export async function getServicePorts(serviceId: string) {
	return db
		.select()
		.from(servicePorts)
		.where(eq(servicePorts.serviceId, serviceId))
		.orderBy(servicePorts.port);
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

	const servicePortsList = await db
		.select()
		.from(servicePorts)
		.where(eq(servicePorts.serviceId, serviceId));

	if (servicePortsList.length === 0) {
		throw new Error("Service has no ports defined");
	}

	const onlineServers = await db
		.select()
		.from(servers)
		.where(eq(servers.status, "online"));

	if (onlineServers.length === 0) {
		throw new Error("No online servers available");
	}

	const server = onlineServers[0];

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
