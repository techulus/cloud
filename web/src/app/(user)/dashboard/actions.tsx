"use server";

import { randomUUID } from "node:crypto";
import db from "@/db";
import { project, service } from "@/db/schema";
import { getOwner } from "@/lib/user";
import { tasks } from "@trigger.dev/sdk/v3";
import type { deployServiceJob } from "@/trigger/deploy-service";

export async function createProject({ name }: { name: string }) {
	try {
		const { orgId } = await getOwner();

		await db.insert(project).values({
			id: randomUUID(),
			name: name ?? "Untitled Project",
			organizationId: orgId,
			createdAt: new Date(),
		});
	} catch (error) {
		console.error(error);
		return { error: "Failed to create project" };
	}
}

export async function createService({
	name,
	image,
	tag,
	projectId,
	type,
}: {
	name: string;
	image: string;
	tag: string;
	projectId: string;
	type: string;
}) {
	try {
		await db.insert(service).values({
			id: randomUUID(),
			name: name ?? "Untitled Service",
			projectId,
			configuration: JSON.stringify({
				type,
				image,
				tag,
			}),
			createdAt: new Date(),
		});
	} catch (error) {
		console.error(error);
		return { error: "Failed to create project" };
	}
}

export async function deployService({
	serviceId,
}: {
	serviceId: string;
}) {
	try {
		const handle = await tasks.trigger<typeof deployServiceJob>(
			"deploy-service",
			{
				serviceId,
			},
		);

		return handle;
	} catch (error) {
		console.error(error);
	}
}

export async function createSecret({
	serviceId,
	key,
	value,
}: {
	serviceId: string;
	key: string;
	value: string;
}) {
	console.log(serviceId, key, value);
}
