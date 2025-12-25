"use server";

import { db } from "@/db";
import { servers, proxyRoutes } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function getProxyServer() {
  const serversWithRoutes = await db
    .select({
      id: servers.id,
      name: servers.name,
      status: servers.status,
      publicIp: servers.publicIp,
      wireguardIp: servers.wireguardIp,
      resourcesCpu: servers.resourcesCpu,
      resourcesMemory: servers.resourcesMemory,
      resourcesDisk: servers.resourcesDisk,
      lastHeartbeat: servers.lastHeartbeat,
    })
    .from(servers)
    .innerJoin(proxyRoutes, eq(proxyRoutes.serverId, servers.id))
    .groupBy(servers.id);

  return serversWithRoutes[0] || null;
}

export async function getProxyWithRoutes(serverId: string) {
  const serverResults = await db
    .select({
      id: servers.id,
      name: servers.name,
      status: servers.status,
      publicIp: servers.publicIp,
      wireguardIp: servers.wireguardIp,
      resourcesCpu: servers.resourcesCpu,
      resourcesMemory: servers.resourcesMemory,
      resourcesDisk: servers.resourcesDisk,
      lastHeartbeat: servers.lastHeartbeat,
    })
    .from(servers)
    .where(eq(servers.id, serverId));

  const server = serverResults[0];
  if (!server) return null;

  const routes = await db
    .select()
    .from(proxyRoutes)
    .where(eq(proxyRoutes.serverId, serverId));

  return {
    ...server,
    routes,
  };
}

export async function getProxyRoutes() {
  const routes = await db
    .select({
      id: proxyRoutes.id,
      serverId: proxyRoutes.serverId,
      routeId: proxyRoutes.routeId,
      domain: proxyRoutes.domain,
      upstreams: proxyRoutes.upstreams,
      isManaged: proxyRoutes.isManaged,
      lastSeen: proxyRoutes.lastSeen,
      serverName: servers.name,
    })
    .from(proxyRoutes)
    .innerJoin(servers, eq(servers.id, proxyRoutes.serverId));

  return routes;
}
