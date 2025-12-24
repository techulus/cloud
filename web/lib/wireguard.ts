import { db } from "@/db";
import { servers, workQueue } from "@/db/schema";
import { eq, isNotNull } from "drizzle-orm";
import { randomUUID } from "crypto";

const WIREGUARD_SUBNET = "10.100";

export async function assignWireGuardIp(): Promise<string> {
  const existingServers = await db
    .select({ wireguardIp: servers.wireguardIp })
    .from(servers)
    .where(isNotNull(servers.wireguardIp));

  const usedIps = new Set(existingServers.map((s) => s.wireguardIp));

  for (let third = 0; third <= 255; third++) {
    for (let fourth = 1; fourth <= 254; fourth++) {
      const ip = `${WIREGUARD_SUBNET}.${third}.${fourth}`;
      if (!usedIps.has(ip)) {
        return ip;
      }
    }
  }

  throw new Error("No available WireGuard IPs");
}

export async function getWireGuardPeers(excludeServerId?: string) {
  const allServers = await db
    .select({
      id: servers.id,
      wireguardIp: servers.wireguardIp,
      wireguardPublicKey: servers.wireguardPublicKey,
      publicIp: servers.publicIp,
    })
    .from(servers)
    .where(isNotNull(servers.wireguardPublicKey));

  return allServers
    .filter((s) => s.id !== excludeServerId)
    .map((s) => ({
      publicKey: s.wireguardPublicKey!,
      allowedIps: `${s.wireguardIp}/32`,
      endpoint: s.publicIp ? `${s.publicIp}:51820` : null,
    }));
}

export async function broadcastWireGuardUpdate() {
  const onlineServers = await db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.status, "online"));

  for (const server of onlineServers) {
    const peers = await getWireGuardPeers(server.id);
    await db.insert(workQueue).values({
      id: randomUUID(),
      serverId: server.id,
      type: "update_wireguard",
      payload: JSON.stringify({ peers }),
    });
  }

  return onlineServers.length;
}
