import { db } from "@/db";
import { deployments, servicePorts, services } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

export type CaddyRoute = {
  id: string;
  domain: string;
  upstreams: string[];
  serviceId: string;
};

const ROUTABLE_STATUSES = ["caddy_updating", "running"] as const;

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
      and(
        eq(deployments.serviceId, serviceId),
        inArray(deployments.status, [...ROUTABLE_STATUSES])
      )
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

    for (const port of ports) {
      if (port.isPublic && port.domain) {
        const portUpstreams = await getPortUpstreams(service.id, port.port);
        if (portUpstreams.length > 0) {
          routes.push({
            id: port.domain,
            domain: port.domain,
            upstreams: portUpstreams,
            serviceId: service.id,
          });
        }
      }
    }
  }

  return routes;
}

export function buildCaddyRoute(route: CaddyRoute): object {
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
