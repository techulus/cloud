import { db } from "@/db";
import { servers, workQueue, deployments, rollouts, services } from "@/db/schema";
import { eq, and, ne, isNotNull, isNull, lt, inArray } from "drizzle-orm";
import { getWireGuardPeers } from "@/lib/wireguard";
import { randomUUID } from "node:crypto";
import { checkRolloutProgress, handleRolloutFailure } from "./work";

interface ContainerHealth {
  container_id: string;
  health_status: string;
  deployment_id: string;
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

  const reportedDeploymentIds = (status.container_health || [])
    .map((ch) => ch.deployment_id)
    .filter((id) => id !== "");
  await reconcileDeployments(serverId, reportedDeploymentIds);

  if (status.container_health && status.container_health.length > 0) {
    await updateContainerHealth(status.container_health, serverId);
  }
}

async function reconcileDeployments(
  serverId: string,
  reportedDeploymentIds: string[]
): Promise<void> {
  const activeStatuses = [
    "starting",
    "healthy",
    "dns_updating",
    "caddy_updating",
    "stopping_old",
    "running",
    "stopping",
  ] as const;

  const activeDeployments = await db
    .select({ id: deployments.id, containerId: deployments.containerId })
    .from(deployments)
    .where(
      and(
        eq(deployments.serverId, serverId),
        isNotNull(deployments.containerId),
        inArray(deployments.status, activeStatuses)
      )
    );

  for (const dep of activeDeployments) {
    if (!reportedDeploymentIds.includes(dep.id)) {
      await db
        .update(deployments)
        .set({ status: "stopped", healthStatus: null })
        .where(eq(deployments.id, dep.id));
      console.log(`[reconcile] deployment ${dep.id} marked stopped (container gone)`);
    }
  }
}

async function updateContainerHealth(
  containerHealthList: ContainerHealth[],
  serverId: string
): Promise<void> {
  for (const ch of containerHealthList) {
    const healthStatus = ch.health_status as
      | "none"
      | "starting"
      | "healthy"
      | "unhealthy";

    let [deployment] = ch.deployment_id
      ? await db
          .select()
          .from(deployments)
          .where(eq(deployments.id, ch.deployment_id))
      : await db
          .select()
          .from(deployments)
          .where(eq(deployments.containerId, ch.container_id));

    if (!deployment && ch.deployment_id) {
      continue;
    }

    if (!deployment) {
      const stuckStatuses = ["pending", "pulling"] as const;
      const [stuckDeployment] = await db
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.serverId, serverId),
            isNull(deployments.containerId),
            inArray(deployments.status, stuckStatuses)
          )
        );

      if (stuckDeployment) {
        console.log(`[health:recover] found stuck deployment ${stuckDeployment.id}, attaching container ${ch.container_id}`);

        const service = await db
          .select()
          .from(services)
          .where(eq(services.id, stuckDeployment.serviceId))
          .then((r) => r[0]);

        const hasHealthCheck = service?.healthCheckCmd != null;
        const newStatus = hasHealthCheck ? "starting" : "healthy";

        await db
          .update(deployments)
          .set({
            containerId: ch.container_id,
            status: newStatus,
            healthStatus: hasHealthCheck ? "starting" : "none",
          })
          .where(eq(deployments.id, stuckDeployment.id));

        deployment = { ...stuckDeployment, status: newStatus, containerId: ch.container_id };

        if (!hasHealthCheck && deployment.rolloutId) {
          await checkRolloutProgress(deployment.rolloutId);
          continue;
        }
      } else {
        continue;
      }
    }

    const updateFields: Record<string, unknown> = { healthStatus };
    if (deployment.containerId !== ch.container_id) {
      updateFields.containerId = ch.container_id;
    }

    if (deployment.status === "unknown") {
      const newStatus = healthStatus === "healthy" || healthStatus === "none" ? "running" : "starting";
      updateFields.status = newStatus;
      console.log(`[health:restore] deployment ${deployment.id} restored from unknown to ${newStatus}`);
    }

    await db
      .update(deployments)
      .set(updateFields)
      .where(eq(deployments.id, deployment.id));

    if (deployment.status === "starting" && (healthStatus === "healthy" || healthStatus === "none")) {
      console.log(`[health] deployment ${deployment.id} is now healthy (healthStatus=${healthStatus})`);

      await db
        .update(deployments)
        .set({ status: "healthy" })
        .where(eq(deployments.id, deployment.id));

      if (deployment.rolloutId) {
        await checkRolloutProgress(deployment.rolloutId);
      }
    }

    if (deployment.status === "starting" && healthStatus === "unhealthy") {
      console.log(`[health] deployment ${deployment.id} failed health check`);

      await db
        .update(deployments)
        .set({ status: "failed", failedAt: "health_check" })
        .where(eq(deployments.id, deployment.id));

      if (deployment.rolloutId) {
        await handleRolloutFailure(deployment.rolloutId, "health_check");
      }
    }
  }
}

export async function markServerOffline(serverId: string): Promise<void> {
  await db
    .update(servers)
    .set({ status: "offline" })
    .where(eq(servers.id, serverId));

  const activeStatuses = [
    "pending",
    "pulling",
    "starting",
    "healthy",
    "dns_updating",
    "caddy_updating",
    "stopping_old",
    "running",
    "stopping",
  ] as const;

  await db
    .update(deployments)
    .set({ status: "unknown", healthStatus: null })
    .where(
      and(
        eq(deployments.serverId, serverId),
        inArray(deployments.status, activeStatuses)
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
