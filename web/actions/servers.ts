"use server";

import { db } from "@/db";
import { servers } from "@/db/schema";
import { eq, and, lt, ne } from "drizzle-orm";
import { randomBytes } from "crypto";
import { broadcastWireGuardUpdate } from "@/lib/wireguard";
import { revalidatePath } from "next/cache";

const OFFLINE_THRESHOLD_MS = 60 * 1000;

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

export async function listServers() {
  return db.select().from(servers).orderBy(servers.createdAt);
}

export async function getServer(id: string) {
  const results = await db.select().from(servers).where(eq(servers.id, id));
  return results[0] || null;
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
  revalidatePath("/dashboard");
  return count;
}

export async function refreshServerStatuses() {
  const threshold = new Date(Date.now() - OFFLINE_THRESHOLD_MS);

  await db
    .update(servers)
    .set({ status: "offline" })
    .where(
      and(
        eq(servers.status, "online"),
        lt(servers.lastHeartbeat, threshold)
      )
    );

  revalidatePath("/dashboard");
}
