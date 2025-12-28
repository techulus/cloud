"use server";

import { db } from "@/db";
import { servers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { broadcastWireGuardUpdate } from "@/lib/wireguard";

function generateId(): string {
  return randomBytes(12).toString("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export async function createServer(name: string) {
  const id = generateId();
  const agentToken = generateToken();
  const now = new Date();

  await db.insert(servers).values({
    id,
    name,
    agentToken,
    tokenCreatedAt: now,
    createdAt: now,
  });

  return {
    id,
    name,
    agentToken,
  };
}

export async function deleteServer(id: string) {
  await db.delete(servers).where(eq(servers.id, id));
}

export async function approveServer(id: string) {
  await db
    .update(servers)
    .set({ status: "pending" })
    .where(eq(servers.id, id));
}

export async function syncWireGuard() {
  const count = await broadcastWireGuardUpdate();
  return count;
}
