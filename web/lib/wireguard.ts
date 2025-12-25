import { db } from "@/db";
import { servers, workQueue } from "@/db/schema";
import { eq, isNotNull, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  WIREGUARD_SUBNET_PREFIX,
  WIREGUARD_SUBNET_CIDR,
  PROXY_WIREGUARD_IP,
} from "./constants";

export function isProxyServer(wireguardIp: string | null): boolean {
  return wireguardIp === PROXY_WIREGUARD_IP;
}

export async function assignWireGuardIp(): Promise<string> {
  const existingServers = await db
    .select({ wireguardIp: servers.wireguardIp })
    .from(servers)
    .where(isNotNull(servers.wireguardIp));

  const usedIps = new Set(existingServers.map((s) => s.wireguardIp));

  for (let third = 0; third <= 255; third++) {
    for (let fourth = 1; fourth <= 254; fourth++) {
      const ip = `${WIREGUARD_SUBNET_PREFIX}.${third}.${fourth}`;
      if (!usedIps.has(ip)) {
        return ip;
      }
    }
  }

  throw new Error("No available WireGuard IPs");
}

export async function getWireGuardPeers(
  excludeServerId: string,
  callerWireguardIp: string
) {
  const allServers = await db
    .select({
      id: servers.id,
      wireguardIp: servers.wireguardIp,
      wireguardPublicKey: servers.wireguardPublicKey,
      publicIp: servers.publicIp,
    })
    .from(servers)
    .where(isNotNull(servers.wireguardPublicKey));

  const callerIsProxy = isProxyServer(callerWireguardIp);

  return allServers
    .filter((s) => {
      if (s.id === excludeServerId) return false;
      if (callerIsProxy) {
        return !isProxyServer(s.wireguardIp);
      }
      return isProxyServer(s.wireguardIp);
    })
    .map((s) => ({
      publicKey: s.wireguardPublicKey!,
      allowedIps: isProxyServer(s.wireguardIp)
        ? WIREGUARD_SUBNET_CIDR
        : `${s.wireguardIp}/32`,
      endpoint: s.publicIp ? `${s.publicIp}:51820` : null,
    }));
}

export async function broadcastWireGuardUpdate() {
  const proxyServer = await db
    .select({ id: servers.id, wireguardIp: servers.wireguardIp })
    .from(servers)
    .where(
      and(
        eq(servers.status, "online"),
        eq(servers.wireguardIp, PROXY_WIREGUARD_IP)
      )
    )
    .then((r) => r[0]);

  if (!proxyServer) {
    return 0;
  }

  const peers = await getWireGuardPeers(proxyServer.id, proxyServer.wireguardIp!);
  await db.insert(workQueue).values({
    id: randomUUID(),
    serverId: proxyServer.id,
    type: "update_wireguard",
    payload: JSON.stringify({ peers }),
  });

  return 1;
}
