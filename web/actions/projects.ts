"use server";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
	deployments,
	projects,
	servers,
	services,
	workQueue,
} from "@/db/schema";

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
	port: number,
) {
	const id = randomUUID();

	await db.insert(services).values({
		id,
		projectId,
		name,
		image,
		port,
	});

	revalidatePath(`/dashboard/projects/${projectId}`);
	return { id, name, image, port };
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

const PORT_RANGE_START = 30000;
const PORT_RANGE_END = 32767;

async function getNextAvailablePort(serverId: string): Promise<number> {
	const existingDeployments = await db
		.select({ port: deployments.port })
		.from(deployments)
		.where(eq(deployments.serverId, serverId));

	const usedPorts = new Set(
		existingDeployments.map((d) => d.port).filter((p) => p !== null),
	);

	for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
		if (!usedPorts.has(port)) {
			return port;
		}
	}

	throw new Error("No available ports on this server");
}

export async function deployService(serviceId: string) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
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

	const hostPort = await getNextAvailablePort(server.id);

	const deploymentId = randomUUID();
	await db.insert(deployments).values({
		id: deploymentId,
		serviceId,
		serverId: server.id,
		status: "pending",
		wireguardIp: server.wireguardIp,
		port: hostPort,
	});

	await db.insert(workQueue).values({
		id: randomUUID(),
		serverId: server.id,
		type: "deploy",
		payload: JSON.stringify({
			deploymentId,
			serviceId,
			image: normalizeImage(service.image),
			port: service.port,
			hostPort,
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
