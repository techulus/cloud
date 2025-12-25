import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { deployments, deploymentPorts, servers, services, servicePorts, workQueue } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function getServiceUpstreams(serviceId: string): Promise<string[]> {
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

    const ports = await db
      .select({ hostPort: deploymentPorts.hostPort, containerPort: servicePorts.port })
      .from(deploymentPorts)
      .innerJoin(servicePorts, eq(deploymentPorts.servicePortId, servicePorts.id))
      .where(eq(deploymentPorts.deploymentId, dep.deploymentId));

    const primaryPort = ports[0];
    if (primaryPort) {
      upstreams.push(`${server.wireguardIp}:${primaryPort.hostPort}`);
    }
  }

  return upstreams;
}

export async function broadcastCaddySync(serviceId: string): Promise<void> {
  const [service] = await db
    .select()
    .from(services)
    .where(eq(services.id, serviceId));

  if (!service?.exposedDomain) return;

  const upstreams = await getServiceUpstreams(serviceId);

  const route = upstreams.length > 0 ? {
    "@id": service.exposedDomain,
    match: [{ host: [service.exposedDomain] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: upstreams.map((u) => ({ dial: u })),
      },
    ],
  } : null;

  const payload = {
    action: upstreams.length > 0 ? "upsert" : "delete",
    domain: service.exposedDomain,
    route,
  };

  const onlineServers = await db
    .select()
    .from(servers)
    .where(eq(servers.status, "online"));

  for (const server of onlineServers) {
    await db.insert(workQueue).values({
      id: randomUUID(),
      serverId: server.id,
      type: "sync_caddy",
      payload: JSON.stringify(payload),
    });
  }

  console.log(`Broadcast sync_caddy for ${service.exposedDomain} to ${onlineServers.length} servers`);
}

export async function syncServiceRoute(serviceId: string): Promise<void> {
  return broadcastCaddySync(serviceId);
}
