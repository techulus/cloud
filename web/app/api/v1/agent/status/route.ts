import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { servers, workQueue, deployments, serverContainers, proxyRoutes, servicePorts } from "@/db/schema";
import { eq, and, lt, ne, notInArray } from "drizzle-orm";
import { verifyEd25519Signature } from "@/lib/crypto";
import { getWireGuardPeers, isProxyServer } from "@/lib/wireguard";
import { PROXY_WIREGUARD_IP } from "@/lib/constants";
import { randomUUID } from "crypto";

type ContainerInfo = {
  id: string;
  name: string;
  image: string;
  state: string;
  created: number;
};

type ProxyRouteInfo = {
  routeId: string;
  domain: string;
  upstreams: string[];
};

const WORK_TIMEOUT_MINUTES = 5;
const MAX_ATTEMPTS = 3;

export async function POST(request: NextRequest) {
  try {
    const serverId = request.headers.get("x-server-id");
    const signature = request.headers.get("x-signature");
    const timestamp = request.headers.get("x-timestamp");

    if (!serverId || !signature || !timestamp) {
      return NextResponse.json(
        { error: "Missing required headers" },
        { status: 400 }
      );
    }

    const timestampMs = parseInt(timestamp, 10);
    const now = Date.now();
    if (Math.abs(now - timestampMs) > 5 * 60 * 1000) {
      return NextResponse.json(
        { error: "Request timestamp too old" },
        { status: 401 }
      );
    }

    const serverResults = await db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId));

    const server = serverResults[0];

    if (!server || !server.signingPublicKey) {
      return NextResponse.json({ error: "Server not found or not registered" }, { status: 404 });
    }

    if (server.status === "unknown") {
      return NextResponse.json(
        { error: "Server requires approval" },
        { status: 403 }
      );
    }

    const body = await request.text();
    const message = `${timestamp}:${body}`;

    const isValid = verifyEd25519Signature(
      server.signingPublicKey,
      message,
      signature
    );

    if (!isValid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const parsedBody = body ? JSON.parse(body) : {};
    const { resources, publicIp, containers, proxyRoutes: agentProxyRoutes } = parsedBody as {
      resources?: { cpuCores?: number; memoryTotalMB?: number; diskTotalGB?: number };
      publicIp?: string;
      containers?: ContainerInfo[];
      proxyRoutes?: ProxyRouteInfo[];
    };

    const updateData: Record<string, unknown> = {
      lastHeartbeat: new Date(),
      status: "online",
    };

    if (resources) {
      if (resources.cpuCores !== undefined) updateData.resourcesCpu = resources.cpuCores;
      if (resources.memoryTotalMB !== undefined)
        updateData.resourcesMemory = resources.memoryTotalMB;
      if (resources.diskTotalGB !== undefined)
        updateData.resourcesDisk = resources.diskTotalGB;
    }

    const publicIpChanged = publicIp && publicIp !== server.publicIp;
    if (publicIp) {
      updateData.publicIp = publicIp;
    }

    await db.update(servers).set(updateData).where(eq(servers.id, serverId));

    if (publicIpChanged && server.wireguardIp) {
      if (isProxyServer(server.wireguardIp)) {
        const workers = await db
          .select({ id: servers.id, wireguardIp: servers.wireguardIp })
          .from(servers)
          .where(
            and(
              ne(servers.id, serverId),
              eq(servers.status, "online"),
              ne(servers.wireguardIp, PROXY_WIREGUARD_IP)
            )
          );

        for (const worker of workers) {
          const peers = await getWireGuardPeers(worker.id, worker.wireguardIp!);
          await db.insert(workQueue).values({
            id: randomUUID(),
            serverId: worker.id,
            type: "update_wireguard",
            payload: JSON.stringify({ peers }),
          });
        }
      } else {
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

        if (proxyServer) {
          const peers = await getWireGuardPeers(proxyServer.id, proxyServer.wireguardIp!);
          await db.insert(workQueue).values({
            id: randomUUID(),
            serverId: proxyServer.id,
            type: "update_wireguard",
            payload: JSON.stringify({ peers }),
          });
        }
      }
    }

    if (containers && containers.length > 0) {
      const allDeployments = await db
        .select({ containerId: deployments.containerId })
        .from(deployments)
        .where(eq(deployments.serverId, serverId));

      const managedContainerIds = new Set(
        allDeployments.map((d) => d.containerId).filter(Boolean)
      );

      const seenContainerIds: string[] = [];

      for (const container of containers) {
        seenContainerIds.push(container.id);
        const isManaged = managedContainerIds.has(container.id);

        const existing = await db
          .select()
          .from(serverContainers)
          .where(
            and(
              eq(serverContainers.serverId, serverId),
              eq(serverContainers.containerId, container.id)
            )
          );

        if (existing.length > 0) {
          await db
            .update(serverContainers)
            .set({
              name: container.name,
              image: container.image,
              state: container.state,
              isManaged,
              lastSeen: new Date(),
            })
            .where(eq(serverContainers.id, existing[0].id));
        } else {
          await db.insert(serverContainers).values({
            id: randomUUID(),
            serverId,
            containerId: container.id,
            name: container.name,
            image: container.image,
            state: container.state,
            isManaged,
          });
        }
      }

      if (seenContainerIds.length > 0) {
        await db
          .delete(serverContainers)
          .where(
            and(
              eq(serverContainers.serverId, serverId),
              notInArray(serverContainers.containerId, seenContainerIds)
            )
          );
      }
    } else if (containers && containers.length === 0) {
      await db
        .delete(serverContainers)
        .where(eq(serverContainers.serverId, serverId));
    }

    if (agentProxyRoutes && agentProxyRoutes.length > 0) {
      const allServicePorts = await db
        .select({ subdomain: servicePorts.subdomain })
        .from(servicePorts)
        .where(eq(servicePorts.isPublic, true));

      const managedDomains = new Set(
        allServicePorts.map((sp) => sp.subdomain).filter(Boolean)
      );

      const seenRouteIds: string[] = [];

      for (const route of agentProxyRoutes) {
        seenRouteIds.push(route.routeId);
        const isManaged = managedDomains.has(route.domain.split(".")[0]);

        const existing = await db
          .select()
          .from(proxyRoutes)
          .where(
            and(
              eq(proxyRoutes.serverId, serverId),
              eq(proxyRoutes.routeId, route.routeId)
            )
          );

        if (existing.length > 0) {
          await db
            .update(proxyRoutes)
            .set({
              domain: route.domain,
              upstreams: JSON.stringify(route.upstreams),
              isManaged,
              lastSeen: new Date(),
            })
            .where(eq(proxyRoutes.id, existing[0].id));
        } else {
          await db.insert(proxyRoutes).values({
            id: randomUUID(),
            serverId,
            routeId: route.routeId,
            domain: route.domain,
            upstreams: JSON.stringify(route.upstreams),
            isManaged,
          });
        }
      }

      if (seenRouteIds.length > 0) {
        await db
          .delete(proxyRoutes)
          .where(
            and(
              eq(proxyRoutes.serverId, serverId),
              notInArray(proxyRoutes.routeId, seenRouteIds)
            )
          );
      }
    } else if (agentProxyRoutes && agentProxyRoutes.length === 0) {
      await db
        .delete(proxyRoutes)
        .where(eq(proxyRoutes.serverId, serverId));
    }

    await handleStuckJobs();

    const pendingWork = await db
      .select()
      .from(workQueue)
      .where(and(eq(workQueue.serverId, serverId), eq(workQueue.status, "pending")));

    if (pendingWork.length > 0) {
      const work = pendingWork[0];
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

      console.log(`[agent:${server.name}] assigned work: ${work.type} (${work.id})`);

      return NextResponse.json({
        work: {
          id: work.id,
          type: work.type,
          payload: JSON.parse(work.payload),
        },
      });
    }

    console.log(`[agent:${server.name}] polled, no work`);

    return NextResponse.json({ work: null });
  } catch (error) {
    console.error("Agent status error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

async function handleStuckJobs() {
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
