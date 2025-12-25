import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { deployments, deploymentPorts, servers, servicePorts, workQueue } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function getPortUpstreams(
  serviceId: string,
  servicePortId: string,
): Promise<string[]> {
  const runningDeployments = await db
    .select({
      deploymentId: deployments.id,
      serverId: deployments.serverId,
    })
    .from(deployments)
    .where(
      and(eq(deployments.serviceId, serviceId), eq(deployments.status, "running"))
    );

  const upstreams: string[] = [];

  for (const dep of runningDeployments) {
    const [server] = await db
      .select({ wireguardIp: servers.wireguardIp })
      .from(servers)
      .where(eq(servers.id, dep.serverId));

    if (!server?.wireguardIp) continue;

    const [portMapping] = await db
      .select({ hostPort: deploymentPorts.hostPort })
      .from(deploymentPorts)
      .where(
        and(
          eq(deploymentPorts.deploymentId, dep.deploymentId),
          eq(deploymentPorts.servicePortId, servicePortId)
        )
      );

    if (portMapping) {
      upstreams.push(`${server.wireguardIp}:${portMapping.hostPort}`);
    }
  }

  return upstreams;
}

export async function syncPublicPorts(serviceId: string): Promise<void> {
  const publicPorts = await db
    .select()
    .from(servicePorts)
    .where(
      and(
        eq(servicePorts.serviceId, serviceId),
        eq(servicePorts.isPublic, true)
      )
    );

  const onlineServers = await db
    .select()
    .from(servers)
    .where(eq(servers.status, "online"));

  for (const port of publicPorts) {
    if (!port.subdomain) continue;

    const domain = `${port.subdomain}.techulus.app`;
    const upstreams = await getPortUpstreams(serviceId, port.id);

    const route = upstreams.length > 0 ? {
      "@id": domain,
      match: [{ host: [domain] }],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: upstreams.map((u) => ({ dial: u })),
        },
      ],
    } : null;

    const payload = {
      action: upstreams.length > 0 ? "upsert" : "delete",
      domain,
      route,
    };

    for (const server of onlineServers) {
      await db.insert(workQueue).values({
        id: randomUUID(),
        serverId: server.id,
        type: "sync_caddy",
        payload: JSON.stringify(payload),
      });
    }

    console.log(`Broadcast sync_caddy for ${domain} to ${onlineServers.length} servers`);
  }
}

export async function syncServiceRoute(serviceId: string): Promise<void> {
  return syncPublicPorts(serviceId);
}
