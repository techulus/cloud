import { db } from "@/db";
import { deployments, servicePorts, services } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { WIREGUARD_SUBNET_CIDR } from "./constants";

export type CaddyRoute = {
  id: string;
  domain: string;
  upstreams: string[];
  internal: boolean;
};

async function getPortUpstreams(
  serviceId: string,
  containerPort: number,
): Promise<string[]> {
  const runningDeployments = await db
    .select({
      ipAddress: deployments.ipAddress,
    })
    .from(deployments)
    .where(
      and(eq(deployments.serviceId, serviceId), eq(deployments.status, "running"))
    );

  const upstreams: string[] = [];

  for (const dep of runningDeployments) {
    if (dep.ipAddress) {
      upstreams.push(`${dep.ipAddress}:${containerPort}`);
    }
  }

  return upstreams;
}

export async function getAllRoutes(): Promise<CaddyRoute[]> {
  const routes: CaddyRoute[] = [];

  const allServices = await db.select().from(services);

  for (const service of allServices) {
    const ports = await db
      .select()
      .from(servicePorts)
      .where(eq(servicePorts.serviceId, service.id));

    if (ports.length === 0) continue;

    const firstPort = ports[0];
    const upstreams = await getPortUpstreams(service.id, firstPort.port);

    if (upstreams.length === 0) continue;

    routes.push({
      id: `${service.name}.internal`,
      domain: `${service.name}.internal`,
      upstreams,
      internal: true,
    });

    for (const port of ports) {
      if (port.isPublic && port.domain) {
        const portUpstreams = await getPortUpstreams(service.id, port.port);
        if (portUpstreams.length > 0) {
          routes.push({
            id: port.domain,
            domain: port.domain,
            upstreams: portUpstreams,
            internal: false,
          });
        }
      }
    }
  }

  return routes;
}

export function buildCaddyRoute(route: CaddyRoute): object {
  if (route.internal) {
    return {
      "@id": route.id,
      match: [
        { host: [route.domain] },
        { remote_ip: { ranges: [WIREGUARD_SUBNET_CIDR] } }
      ],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: route.upstreams.map((u) => ({ dial: u })),
        },
      ],
    };
  }

  return {
    "@id": route.id,
    match: [{ host: [route.domain] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: route.upstreams.map((u) => ({ dial: u })),
      },
    ],
  };
}
