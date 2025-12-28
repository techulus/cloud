"use server";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { secrets, services } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";

export async function createSecret(
  serviceId: string,
  key: string,
  value: string
) {
  if (!key || !value) {
    throw new Error("Key and value are required");
  }

  const service = await db
    .select()
    .from(services)
    .where(eq(services.id, serviceId));

  if (!service[0]) {
    throw new Error("Service not found");
  }

  const existing = await db
    .select()
    .from(secrets)
    .where(and(eq(secrets.serviceId, serviceId), eq(secrets.key, key)));

  if (existing.length > 0) {
    await db
      .update(secrets)
      .set({ encryptedValue: encryptSecret(value) })
      .where(eq(secrets.id, existing[0].id));

    return { id: existing[0].id, key };
  }

  const id = randomUUID();
  await db.insert(secrets).values({
    id,
    serviceId,
    key,
    encryptedValue: encryptSecret(value),
  });

  return { id, key };
}

export async function deleteSecret(secretId: string) {
  await db.delete(secrets).where(eq(secrets.id, secretId));
  return { success: true };
}
