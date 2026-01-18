"use server";

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { ZodError } from "zod";
import { db } from "@/db";
import { secrets, services } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { secretItemArraySchema } from "@/lib/schemas";
import { getZodErrorMessage } from "@/lib/utils";

export async function createSecretsBatch(
	serviceId: string,
	items: { key: string; value: string }[],
) {
	if (items.length === 0) {
		return { created: 0, updated: 0 };
	}

	try {
		const validatedItems = secretItemArraySchema.parse(items);

		const service = await db
			.select()
			.from(services)
			.where(eq(services.id, serviceId));

		if (!service[0]) {
			throw new Error("Service not found");
		}

		const keys = validatedItems.map((item) => item.key);
		const existing = await db
			.select()
			.from(secrets)
			.where(and(eq(secrets.serviceId, serviceId), inArray(secrets.key, keys)));

		const existingByKey = new Map(existing.map((s) => [s.key, s]));

		const toInsert: (typeof secrets.$inferInsert)[] = [];
		const toUpdate: { id: string; encryptedValue: string }[] = [];

		for (const item of validatedItems) {
			const existingSecret = existingByKey.get(item.key);
			if (existingSecret) {
				toUpdate.push({
					id: existingSecret.id,
					encryptedValue: encryptSecret(item.value),
				});
			} else {
				toInsert.push({
					id: randomUUID(),
					serviceId,
					key: item.key,
					encryptedValue: encryptSecret(item.value),
				});
			}
		}

		if (toInsert.length > 0) {
			await db.insert(secrets).values(toInsert);
		}

		for (const update of toUpdate) {
			await db
				.update(secrets)
				.set({ encryptedValue: update.encryptedValue, updatedAt: new Date() })
				.where(eq(secrets.id, update.id));
		}

		return { created: toInsert.length, updated: toUpdate.length };
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(getZodErrorMessage(error, "Invalid secret data"));
		}
		throw error;
	}
}

export async function deleteSecretsBatch(secretIds: string[]) {
	if (secretIds.length === 0) {
		return { deleted: 0 };
	}

	await db.delete(secrets).where(inArray(secrets.id, secretIds));
	return { deleted: secretIds.length };
}
