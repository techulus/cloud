"use server";

import { db } from "@/db";
import { servers, serverContainers } from "@/db/schema";
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
  return count;
}

export async function getServerWithContainers(id: string) {
  const serverResults = await db
    .select({
      id: servers.id,
      name: servers.name,
      publicIp: servers.publicIp,
      wireguardIp: servers.wireguardIp,
      status: servers.status,
      lastHeartbeat: servers.lastHeartbeat,
      resourcesCpu: servers.resourcesCpu,
      resourcesMemory: servers.resourcesMemory,
      resourcesDisk: servers.resourcesDisk,
      createdAt: servers.createdAt,
    })
    .from(servers)
    .where(eq(servers.id, id));

  const server = serverResults[0];
  if (!server) {
    return null;
  }

  const containers = await db
    .select()
    .from(serverContainers)
    .where(eq(serverContainers.serverId, id));

  return {
    ...server,
    containers,
  };
}
