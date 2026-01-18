"use server";

import { db } from "@/db";
import { servers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { ZodError } from "zod";
import { nameSchema } from "@/lib/schemas";
import { getZodErrorMessage } from "@/lib/utils";

function generateId(): string {
	return randomBytes(12).toString("hex");
}

function generateToken(): string {
	return randomBytes(32).toString("hex");
}

export async function createServer(name: string) {
	try {
		const validatedName = nameSchema.parse(name);
		const id = generateId();
		const agentToken = generateToken();
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

export async function deleteServer(id: string) {
	await db.delete(servers).where(eq(servers.id, id));
}

export async function approveServer(id: string) {
	await db.update(servers).set({ status: "pending" }).where(eq(servers.id, id));
}

export async function updateServerName(id: string, name: string) {
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
