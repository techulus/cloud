import { db } from "@/db";
import { servers, workQueue } from "@/db/schema";
import { eq, and, ne, isNotNull } from "drizzle-orm";
import { getWireGuardPeers } from "@/lib/wireguard";
import { randomUUID } from "node:crypto";

interface StatusUpdate {
  resources?: {
    cpu_cores?: number;
    memory_total_mb?: number;
    disk_total_gb?: number;
  };
  public_ip?: string;
}

export async function handleStatusUpdate(
  serverId: string,
  status: StatusUpdate
): Promise<void> {
  const serverResults = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId));

  const server = serverResults[0];
  if (!server) {
    throw new Error("Server not found");
  }

  const updateData: Record<string, unknown> = {
    lastHeartbeat: new Date(),
    status: "online",
  };

  if (status.resources) {
    if (status.resources.cpu_cores !== undefined) {
      updateData.resourcesCpu = status.resources.cpu_cores;
    }
    if (status.resources.memory_total_mb !== undefined) {
      updateData.resourcesMemory = status.resources.memory_total_mb;
    }
    if (status.resources.disk_total_gb !== undefined) {
      updateData.resourcesDisk = status.resources.disk_total_gb;
    }
  }

  const publicIpChanged =
    status.public_ip && status.public_ip !== server.publicIp;
  if (status.public_ip) {
    updateData.publicIp = status.public_ip;
  }

  await db.update(servers).set(updateData).where(eq(servers.id, serverId));

  if (publicIpChanged) {
    await handlePublicIpChange(serverId);
  }
}

async function handlePublicIpChange(serverId: string): Promise<void> {
  const otherServers = await db
    .select({ id: servers.id })
    .from(servers)
    .where(
      and(
        ne(servers.id, serverId),
        eq(servers.status, "online"),
        isNotNull(servers.subnetId)
      )
    );

  for (const otherServer of otherServers) {
    const peers = await getWireGuardPeers(otherServer.id);
    await db.insert(workQueue).values({
      id: randomUUID(),
      serverId: otherServer.id,
      type: "update_wireguard",
      payload: JSON.stringify({ peers }),
    });
  }
}
