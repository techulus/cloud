"use server";

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { enqueueAgentUpgrade } from "@/lib/agent-upgrades";
import { requireDeveloperRole, verifyDeleteConfirmation } from "@/lib/auth";
import { nameSchema } from "@/lib/schemas";
import type { DeleteConfirmation } from "@/lib/two-factor";
import { getZodErrorMessage } from "@/lib/utils";

export async function createServer(name: string) {
	await requireDeveloperRole();
	try {
		const validatedName = nameSchema.parse(name);
		const id = randomBytes(12).toString("hex");
		const agentToken = randomBytes(32).toString("hex");
		const now = new Date();

		await db.insert(servers).values({
			id,
			name: validatedName,
			agentToken,
			tokenCreatedAt: now,
			createdAt: now,
		});

		return {
			id,
			name: validatedName,
			agentToken,
		};
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(getZodErrorMessage(error, "Invalid server name"));
		}
		throw error;
	}
}

export async function deleteServer(
	id: string,
	confirmation?: DeleteConfirmation,
) {
	const session = await requireDeveloperRole();
	await verifyDeleteConfirmation(session, confirmation, "server");
	await db.delete(servers).where(eq(servers.id, id));
}

export async function updateServerName(id: string, name: string) {
	await requireDeveloperRole();
	try {
		const validatedName = nameSchema.parse(name);
		await db
			.update(servers)
			.set({ name: validatedName })
			.where(eq(servers.id, id));
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(getZodErrorMessage(error, "Invalid server name"));
		}
		throw error;
	}
}

export async function upgradeAgent(serverId: string, targetVersion: string) {
	await requireDeveloperRole();
	const result = await enqueueAgentUpgrade(serverId, targetVersion);
	revalidatePath("/dashboard/servers");
	revalidatePath(`/dashboard/servers/${serverId}`);
	return result;
}
