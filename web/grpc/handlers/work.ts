import { db } from "@/db";
import { workQueue, deployments, servers, rollouts, services } from "@/db/schema";
import { eq, and, lt, inArray } from "drizzle-orm";
import { connectionStore } from "../store/connections";
import type { WorkComplete, ConfigAck } from "../generated/proto/agent";
import { pushCaddyConfigToAll } from "./caddy";
import { pushDnsConfigToAll } from "./dns";

/**
 * Push DNS and Caddy configs in correct order with optional acknowledgment-based waiting.
 * Ensures DNS records are available on agents before Caddy routes are pushed.
 *
 * Future enhancement: Wait for agent acknowledgments instead of timeout.
 * For now, uses a 1-second delay as fallback while ack system is being implemented.
 */
async function pushConfigsInOrder(): Promise<void> {
  // Push DNS config first (includes service DNS records)
  await pushDnsConfigToAll();

  // Small delay to ensure DNS config is received and applied by agents
  // TODO: Replace with acknowledgment-based waiting once implemented:
  // const dnsAcks = await connectionStore.waitForConfigAcks("dns", 10000);
  // if (!dnsAcks.all) { /* handle partial failures */ }
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Now push Caddy routes (guaranteed DNS is ready)
  await pushCaddyConfigToAll();

  // TODO: Optional: Wait for Caddy acks too
  // const caddyAcks = await connectionStore.waitForConfigAcks("caddy", 10000);
}

const WORK_TIMEOUT_MINUTES = 5;
const MAX_ATTEMPTS = 3;

export async function handleWorkComplete(
  serverId: string,
  workComplete: WorkComplete
): Promise<void> {
  const { work_id: workId, status, logs } = workComplete;

  console.log(`[work:complete] work_id=${workId} server=${serverId} status=${status}`);

  if (status !== "completed" && status !== "failed") {
    throw new Error("Invalid status, must be 'completed' or 'failed'");
  }

  const workResults = await db
    .select()
    .from(workQueue)
    .where(
      and(
        eq(workQueue.id, workId),
        eq(workQueue.serverId, serverId),
        eq(workQueue.status, "processing")
      )
    );

  const work = workResults[0];
  if (!work) {
    const [anyWork] = await db
      .select()
      .from(workQueue)
      .where(eq(workQueue.id, workId));

    if (anyWork) {
      console.error(`[work:complete] work_id=${workId} found but status=${anyWork.status} (expected processing), server=${anyWork.serverId}`);
    } else {
      console.error(`[work:complete] work_id=${workId} not found in database`);
    }
    throw new Error("Work item not found or not processing");
  }

  console.log(`[work:complete] work_id=${workId} type=${work.type} marking as ${status}`);
  await db.update(workQueue).set({ status }).where(eq(workQueue.id, workId));

  if (work.type === "deploy") {
    const payload = JSON.parse(work.payload);
    const deploymentId = payload.deploymentId;

    if (deploymentId) {
      if (status === "completed") {
        const [deployment] = await db
          .select()
          .from(deployments)
          .where(eq(deployments.id, deploymentId));

        if (!deployment) {
          console.error(`[work:deploy] deployment=${deploymentId} not found in database`);
          return;
        }

        console.log(`[work:deploy] deployment=${deploymentId} deploy completed, waiting for container status`);

        await db
          .update(deployments)
          .set({
            status: "starting",
            healthStatus: "starting",
          })
          .where(eq(deployments.id, deploymentId));
      } else {
        console.log(`[work:deploy] deployment=${deploymentId} failed`);
        await db
          .update(deployments)
          .set({ status: "failed", failedAt: "deploy" })
          .where(eq(deployments.id, deploymentId));

        const [deployment] = await db
          .select()
          .from(deployments)
          .where(eq(deployments.id, deploymentId));

        if (deployment?.rolloutId) {
          await handleRolloutFailure(deployment.rolloutId, "deploy");
        }
      }
    }
  }

  if (work.type === "stop") {
    const payload = JSON.parse(work.payload);
    const deploymentId = payload.deploymentId;
    const rolloutId = payload.rolloutId;

    console.log(`[work:stop] deployment=${deploymentId} rolloutId=${rolloutId || "none"} status=${status}`);

    if (deploymentId && status === "completed") {
      await db
        .update(deployments)
        .set({ status: "stopped" })
        .where(eq(deployments.id, deploymentId));

      if (rolloutId) {
        await checkOldDeploymentsStopped(rolloutId);
      } else {
        await pushConfigsInOrder();
      }
    }
  }
}

export async function checkRolloutProgress(rolloutId: string): Promise<void> {
  console.log(`[rollout:${rolloutId}] checking progress`);

  const rolloutDeployments = await db
    .select()
    .from(deployments)
    .where(eq(deployments.rolloutId, rolloutId));

  const newDeployments = rolloutDeployments.filter(
    (d) => d.status !== "running" && d.status !== "stopped"
  );

  const statusCounts = newDeployments.reduce((acc, d) => {
    acc[d.status] = (acc[d.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log(`[rollout:${rolloutId}] deployment statuses: ${JSON.stringify(statusCounts)}`);

  const allHealthy = newDeployments.every((d) => d.status === "healthy");

  if (allHealthy && newDeployments.length > 0) {
    console.log(`[rollout:${rolloutId}] all ${newDeployments.length} deployments healthy, updating DNS`);

    await db
      .update(deployments)
      .set({ status: "dns_updating" })
      .where(
        and(
          eq(deployments.rolloutId, rolloutId),
          eq(deployments.status, "healthy")
        )
      );

    await db
      .update(rollouts)
      .set({ currentStage: "dns_updating" })
      .where(eq(rollouts.id, rolloutId));

    await pushDnsConfigToAll();
  }
}

export async function handleRolloutFailure(rolloutId: string, failedStage: string): Promise<void> {
  console.log(`[rollout:${rolloutId}] Failed at stage: ${failedStage}, initiating rollback`);

  await db
    .update(rollouts)
    .set({ status: "failed", currentStage: failedStage })
    .where(eq(rollouts.id, rolloutId));

  const rolloutDeployments = await db
    .select()
    .from(deployments)
    .where(eq(deployments.rolloutId, rolloutId));

  const newDeployments = rolloutDeployments.filter(
    (d) => d.status !== "running" && d.status !== "stopped"
  );

  for (const dep of newDeployments) {
    if (dep.containerId) {
      await db.insert(workQueue).values({
        id: crypto.randomUUID(),
        serverId: dep.serverId,
        type: "stop",
        payload: JSON.stringify({
          deploymentId: dep.id,
          containerId: dep.containerId,
        }),
      });
    }

    await db
      .update(deployments)
      .set({ status: "rolled_back", failedAt: failedStage })
      .where(eq(deployments.id, dep.id));
  }

  await db
    .update(rollouts)
    .set({ status: "rolled_back", completedAt: new Date() })
    .where(eq(rollouts.id, rolloutId));

  await pushDnsConfigToAll();
  await pushCaddyConfigToAll();
}

async function checkOldDeploymentsStopped(rolloutId: string): Promise<void> {
  const [rollout] = await db
    .select()
    .from(rollouts)
    .where(eq(rollouts.id, rolloutId));

  if (!rollout) return;

  const serviceDeployments = await db
    .select()
    .from(deployments)
    .where(eq(deployments.serviceId, rollout.serviceId));

  const oldDeployments = serviceDeployments.filter(
    (d) => !d.rolloutId || d.rolloutId !== rolloutId
  );

  const allStopped = oldDeployments.every(
    (d) => d.status === "stopped" || d.status === "failed" || d.status === "rolled_back"
  );

  if (allStopped) {
    console.log(`[rollout:${rolloutId}] All old deployments stopped, completing rollout`);

    await db
      .update(deployments)
      .set({ status: "running" })
      .where(
        and(
          eq(deployments.rolloutId, rolloutId),
          eq(deployments.status, "stopping_old")
        )
      );

    await db
      .update(rollouts)
      .set({ status: "completed", completedAt: new Date(), currentStage: "completed" })
      .where(eq(rollouts.id, rolloutId));

    await pushDnsConfigToAll();

    const [service] = await db
      .select()
      .from(services)
      .where(eq(services.id, rollout.serviceId));

    if (service?.stateful && !service.lockedServerId) {
      const newDeployments = serviceDeployments.filter(
        (d) => d.rolloutId === rolloutId
      );
      if (newDeployments.length > 0) {
        const lockedServerId = newDeployments[0].serverId;
        await db
          .update(services)
          .set({ lockedServerId })
          .where(eq(services.id, rollout.serviceId));
        console.log(`[rollout:${rolloutId}] Locked stateful service ${rollout.serviceId} to server ${lockedServerId}`);
      }
    }

    for (const dep of oldDeployments) {
      await db.delete(deployments).where(eq(deployments.id, dep.id));
    }

    await pushCaddyConfigToAll();
  }
}

async function progressToCaddyUpdate(rolloutId: string): Promise<void> {
  console.log(`[rollout:${rolloutId}] DNS updated, updating Caddy`);

  await db
    .update(deployments)
    .set({ status: "caddy_updating" })
    .where(
      and(
        eq(deployments.rolloutId, rolloutId),
        eq(deployments.status, "dns_updating")
      )
    );

  await db
    .update(rollouts)
    .set({ currentStage: "caddy_updating" })
    .where(eq(rollouts.id, rolloutId));

  await pushCaddyConfigToAll();
}

async function progressToStoppingOld(rolloutId: string): Promise<void> {
  console.log(`[rollout:${rolloutId}] Caddy updated, stopping old deployments`);

  await db
    .update(deployments)
    .set({ status: "stopping_old" })
    .where(
      and(
        eq(deployments.rolloutId, rolloutId),
        eq(deployments.status, "caddy_updating")
      )
    );

  await db
    .update(rollouts)
    .set({ currentStage: "stopping_old" })
    .where(eq(rollouts.id, rolloutId));

  const [rollout] = await db
    .select()
    .from(rollouts)
    .where(eq(rollouts.id, rolloutId));

  if (!rollout) return;

  const serviceDeployments = await db
    .select()
    .from(deployments)
    .where(eq(deployments.serviceId, rollout.serviceId));

  const oldDeployments = serviceDeployments.filter(
    (d) => d.status === "running" && (!d.rolloutId || d.rolloutId !== rolloutId)
  );

  if (oldDeployments.length === 0) {
    await checkOldDeploymentsStopped(rolloutId);
    return;
  }

  for (const dep of oldDeployments) {
    if (dep.containerId) {
      await db
        .update(deployments)
        .set({ status: "stopping" })
        .where(eq(deployments.id, dep.id));

      await db.insert(workQueue).values({
        id: crypto.randomUUID(),
        serverId: dep.serverId,
        type: "stop",
        payload: JSON.stringify({
          deploymentId: dep.id,
          containerId: dep.containerId,
          rolloutId,
        }),
      });
    }
  }
}

export async function handleConfigAck(
  serverId: string,
  ack: ConfigAck
): Promise<void> {
  console.log(
    `[grpc:recv] server=${serverId} config_type=${ack.config_type} success=${ack.success} error=${ack.error || "none"}`
  );

  if (!ack.success) {
    console.error(
      `[config:error] server=${serverId} type=${ack.config_type} error=${ack.error}`
    );
    return;
  }

  const inProgressRollouts = await db
    .select()
    .from(rollouts)
    .where(eq(rollouts.status, "in_progress"));

  for (const rollout of inProgressRollouts) {
    if (ack.config_type === "dns" && rollout.currentStage === "dns_updating") {
      await progressToCaddyUpdate(rollout.id);
    } else if (ack.config_type === "caddy" && rollout.currentStage === "caddy_updating") {
      await progressToStoppingOld(rollout.id);
    }
  }
}

export async function handleStuckJobs(): Promise<void> {
  const timeoutThreshold = new Date(
    Date.now() - WORK_TIMEOUT_MINUTES * 60 * 1000
  );

  const stuckJobs = await db
    .select()
    .from(workQueue)
    .where(
      and(
        eq(workQueue.status, "processing"),
        lt(workQueue.startedAt, timeoutThreshold)
      )
    );

  for (const job of stuckJobs) {
    if (job.attempts >= MAX_ATTEMPTS) {
      await db
        .update(workQueue)
        .set({ status: "failed" })
        .where(eq(workQueue.id, job.id));

      if (job.type === "deploy") {
        const payload = JSON.parse(job.payload);
        if (payload.deploymentId) {
          const [deployment] = await db
            .select()
            .from(deployments)
            .where(eq(deployments.id, payload.deploymentId));

          await db
            .update(deployments)
            .set({ status: "failed", failedAt: "stuck_timeout" })
            .where(eq(deployments.id, payload.deploymentId));

          if (deployment?.rolloutId) {
            await handleRolloutFailure(deployment.rolloutId, "stuck_timeout");
          }
        }
      }
    } else {
      await db
        .update(workQueue)
        .set({
          status: "pending",
          startedAt: null,
          attempts: job.attempts + 1,
        })
        .where(eq(workQueue.id, job.id));
    }
  }
}

const ROLLOUT_TIMEOUT_MINUTES = 10;

export async function handleStuckRollouts(): Promise<void> {
  const timeoutThreshold = new Date(
    Date.now() - ROLLOUT_TIMEOUT_MINUTES * 60 * 1000
  );

  const stuckRollouts = await db
    .select()
    .from(rollouts)
    .where(
      and(
        eq(rollouts.status, "in_progress"),
        lt(rollouts.createdAt, timeoutThreshold)
      )
    );

  for (const rollout of stuckRollouts) {
    console.log(`[rollout:${rollout.id}] stuck at stage ${rollout.currentStage}, failing`);
    await handleRolloutFailure(rollout.id, `stuck_${rollout.currentStage}`);
  }
}

export async function dispatchPendingWork(): Promise<void> {
  const connections = connectionStore.getAll();
  if (connections.length === 0) return;

  const serverIds = connections.map((c) => c.serverId);

  for (const serverId of serverIds) {
    const pendingWork = await db
      .select()
      .from(workQueue)
      .where(
        and(eq(workQueue.serverId, serverId), eq(workQueue.status, "pending"))
      );

    if (pendingWork.length === 0) continue;

    const work = pendingWork[0];
    const connection = connectionStore.get(serverId);
    if (!connection) continue;

    const serverResults = await db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, serverId));

    const serverName = serverResults[0]?.name || serverId;

    await db
      .update(workQueue)
      .set({
        status: "processing",
        startedAt: new Date(),
      })
      .where(eq(workQueue.id, work.id));

    if (work.type === "deploy") {
      const payload = JSON.parse(work.payload);
      if (payload.deploymentId) {
        await db
          .update(deployments)
          .set({ status: "pulling" })
          .where(eq(deployments.id, payload.deploymentId));
      }
    }

    console.log(`[grpc:send] server=${serverId} type=WorkItem work_id=${work.id} work_type=${work.type}`);

    const success = connectionStore.sendMessage(serverId, {
      work: {
        id: work.id,
        type: work.type,
        payload: Buffer.from(work.payload),
      },
    });

    if (!success) {
      console.error(`Failed to dispatch work to ${serverName}`);
      await db
        .update(workQueue)
        .set({
          status: "pending",
          startedAt: null,
        })
        .where(eq(workQueue.id, work.id));
    }
  }
}

let dispatchInterval: ReturnType<typeof setInterval> | null = null;

export function startWorkDispatcher(): void {
  if (dispatchInterval) return;

  dispatchInterval = setInterval(async () => {
    try {
      await handleStuckJobs();
      await handleStuckRollouts();
      await dispatchPendingWork();
    } catch (error) {
      console.error("Work dispatcher error:", error);
    }
  }, 1000);

  console.log("Work dispatcher started");
}

export function stopWorkDispatcher(): void {
  if (dispatchInterval) {
    clearInterval(dispatchInterval);
    dispatchInterval = null;
    console.log("Work dispatcher stopped");
  }
}
