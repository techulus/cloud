import { db } from "@/db";
import { workQueue, deployments, servers } from "@/db/schema";
import { eq, and, lt } from "drizzle-orm";
import { connectionStore } from "../store/connections";
import type { WorkComplete } from "../generated/proto/agent";
import { pushCaddyConfigToProxies } from "./caddy";

const WORK_TIMEOUT_MINUTES = 5;
const MAX_ATTEMPTS = 3;

export async function handleWorkComplete(
  serverId: string,
  workComplete: WorkComplete
): Promise<void> {
  const { work_id: workId, status, logs } = workComplete;

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
    throw new Error("Work item not found or not processing");
  }

  await db.update(workQueue).set({ status }).where(eq(workQueue.id, workId));

  if (work.type === "deploy") {
    const payload = JSON.parse(work.payload);
    const deploymentId = payload.deploymentId;

    if (deploymentId) {
      if (status === "completed") {
        const containerIdMatch = logs?.match(/Container started: ([a-f0-9]+)/);
        const containerId = containerIdMatch ? containerIdMatch[1] : null;

        await db
          .update(deployments)
          .set({
            status: "running",
            containerId,
          })
          .where(eq(deployments.id, deploymentId));

        await pushCaddyConfigToProxies();
      } else {
        await db
          .update(deployments)
          .set({ status: "failed" })
          .where(eq(deployments.id, deploymentId));
      }
    }
  }

  if (work.type === "stop") {
    const payload = JSON.parse(work.payload);
    const deploymentId = payload.deploymentId;

    if (deploymentId && status === "completed") {
      await db
        .update(deployments)
        .set({ status: "stopped" })
        .where(eq(deployments.id, deploymentId));

      await pushCaddyConfigToProxies();
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
          await db
            .update(deployments)
            .set({ status: "failed" })
            .where(eq(deployments.id, payload.deploymentId));
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
