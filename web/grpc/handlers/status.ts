import { db } from "@/db";
import { servers, workQueue, deployments } from "@/db/schema";
import { eq, and, ne, isNotNull, lt, inArray } from "drizzle-orm";
import { getWireGuardPeers } from "@/lib/wireguard";
import { randomUUID } from "node:crypto";

interface ContainerHealth {
  container_id: string;
  health_status: string;
}

interface StatusUpdate {
  resources?: {
    cpu_cores?: number;
    memory_total_mb?: number;
    disk_total_gb?: number;
  };
  public_ip?: string;
  container_health?: ContainerHealth[];
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

  const reportedContainerIds = (status.container_health || []).map(
    (ch) => ch.container_id
  );
  await reconcileDeployments(serverId, reportedContainerIds);

  if (status.container_health && status.container_health.length > 0) {
    await updateContainerHealth(status.container_health);
  }
}

async function reconcileDeployments(
  serverId: string,
  reportedContainerIds: string[]
): Promise<void> {
  const activeDeployments = await db
    .select({ id: deployments.id, containerId: deployments.containerId })
    .from(deployments)
    .where(
      and(
        eq(deployments.serverId, serverId),
        isNotNull(deployments.containerId),
        inArray(deployments.status, ["running", "stopping"])
      )
    );

  for (const dep of activeDeployments) {
    if (dep.containerId && !reportedContainerIds.includes(dep.containerId)) {
      await db
        .update(deployments)
        .set({ status: "stopped", healthStatus: null })
        .where(eq(deployments.id, dep.id));
      console.log(`[reconcile] deployment ${dep.id} marked stopped (container gone)`);
    }
  }
}

async function updateContainerHealth(
  containerHealthList: ContainerHealth[]
): Promise<void> {
  for (const ch of containerHealthList) {
    const healthStatus = ch.health_status as
      | "none"
      | "starting"
      | "healthy"
      | "unhealthy";
    await db
      .update(deployments)
      .set({ healthStatus })
      .where(eq(deployments.containerId, ch.container_id));
  }
}

export async function markServerOffline(serverId: string): Promise<void> {
  await db
    .update(servers)
    .set({ status: "offline" })
    .where(eq(servers.id, serverId));

  const result = await db
    .update(deployments)
    .set({ status: "stopped", healthStatus: null })
    .where(
      and(
        eq(deployments.serverId, serverId),
        inArray(deployments.status, ["running", "stopping", "pulling", "pending"])
      )
    );

  console.log(`[server:${serverId}] marked offline`);
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

const HEARTBEAT_STALE_THRESHOLD_MS = 30 * 1000;
const HEARTBEAT_CHECK_INTERVAL_MS = 10 * 1000;
let heartbeatCheckInterval: NodeJS.Timeout | null = null;

async function checkStaleHeartbeats(): Promise<void> {
  const staleThreshold = new Date(Date.now() - HEARTBEAT_STALE_THRESHOLD_MS);

  const staleServers = await db
    .select({ id: servers.id, name: servers.name })
    .from(servers)
    .where(
      and(
        eq(servers.status, "online"),
        lt(servers.lastHeartbeat, staleThreshold)
      )
    );

  for (const server of staleServers) {
    await markServerOffline(server.id);
    console.log(`[heartbeat] server ${server.name} marked offline (stale heartbeat)`);
  }
}

export function startHeartbeatChecker(): void {
  if (heartbeatCheckInterval) return;

  heartbeatCheckInterval = setInterval(() => {
    checkStaleHeartbeats().catch((err) => {
      console.error("[heartbeat] check failed:", err);
    });
  }, HEARTBEAT_CHECK_INTERVAL_MS);

  console.log("[heartbeat] checker started");
}

export function stopHeartbeatChecker(): void {
  if (heartbeatCheckInterval) {
    clearInterval(heartbeatCheckInterval);
    heartbeatCheckInterval = null;
    console.log("[heartbeat] checker stopped");
  }
}
