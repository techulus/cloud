"use server";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { registryCredentials } from "@/db/schema";
import { requireAdminRole } from "@/lib/auth";
import { encryptRegistryPassword } from "@/lib/crypto";
import {
	calculateRegistryBundleVersion,
	getReservedSystemRegistryHosts,
} from "@/lib/registry-credentials";
import { canonicalizeRegistryHost } from "@/lib/registry-reference";
import { enqueueRegistrySyncForAllRegisteredServers } from "@/lib/work-queue";

export type RegistryCredentialInput = {
	host: string;
	username: string;
	password: string;
	tlsVerify?: boolean;
};

async function requireAdmin() {
	if (!(await requireAdminRole())) throw new Error("Unauthorized");
}

function validateUsername(username: string) {
	const hasControlCharacter = [...username].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
	if (
		!username ||
		username !== username.trim() ||
		username.length > 255 ||
		username.includes(":") ||
		hasControlCharacter
	)
		throw new Error("Registry username is required");
}

async function mutateAndFanout(
	mutation: (
		tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	) => Promise<void>,
) {
	await db.transaction(async (tx) => {
		await mutation(tx);
		const rows = await tx.select().from(registryCredentials);
		await enqueueRegistrySyncForAllRegisteredServers(
			await calculateRegistryBundleVersion(rows),
			tx,
		);
	});
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function createRegistryCredential(input: RegistryCredentialInput) {
	await requireAdmin();
	const host = canonicalizeRegistryHost(input.host);
	validateUsername(input.username);
	if (!input.password) throw new Error("Registry password is required");
	if (getReservedSystemRegistryHosts().has(host))
		throw new Error("This host is reserved by the built-in registry");
	const id = randomUUID();
	const encryptedPassword = await encryptRegistryPassword(
		input.password,
		id,
		host,
	);
	return mutateAndFanout(async (tx) => {
		await tx.insert(registryCredentials).values({
			id,
			host,
			username: input.username,
			encryptedPassword,
			tlsVerify: input.tlsVerify ?? true,
		});
	});
}

export async function updateRegistryCredential(
	id: string,
	input: { username: string; password?: string; tlsVerify: boolean },
) {
	await requireAdmin();
	validateUsername(input.username);
	return mutateAndFanout(async (tx) => {
		const existing = await tx
			.select()
			.from(registryCredentials)
			.where(eq(registryCredentials.id, id))
			.then((rows) => rows[0]);
		if (!existing) throw new Error("Registry credential not found");
		await tx
			.update(registryCredentials)
			.set({
				username: input.username,
				tlsVerify: input.tlsVerify,
				...(input.password
					? {
							encryptedPassword: await encryptRegistryPassword(
								input.password,
								id,
								existing.host,
							),
						}
					: {}),
			})
			.where(eq(registryCredentials.id, id));
	});
}

export async function deleteRegistryCredential(id: string) {
	await requireAdmin();
	return mutateAndFanout(async (tx) => {
		const deleted = await tx
			.delete(registryCredentials)
			.where(eq(registryCredentials.id, id))
			.returning({ id: registryCredentials.id });
		if (!deleted.length) throw new Error("Registry credential not found");
	});
}
