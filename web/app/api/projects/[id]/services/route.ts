export const dynamic = "force-dynamic";

import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { db } from "@/db";
import {
  services,
  servicePorts,
  serviceReplicas,
  serviceVolumes,
  deployments,
  deploymentPorts,
  servers,
  secrets,
  rollouts,
} from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId } = await params;

  const servicesList = await db
    .select()
    .from(services)
    .where(eq(services.projectId, projectId))
    .orderBy(services.createdAt);

  const result = await Promise.all(
    servicesList.map(async (service) => {
      const [ports, serviceDeployments, replicas, serviceSecrets, serviceRollouts, volumes, lockedServer] = await Promise.all([
        db
          .select()
          .from(servicePorts)
          .where(eq(servicePorts.serviceId, service.id))
          .orderBy(servicePorts.port),
        db
          .select()
          .from(deployments)
          .where(eq(deployments.serviceId, service.id))
          .orderBy(deployments.createdAt),
        db
          .select({
            id: serviceReplicas.id,
            serverId: serviceReplicas.serverId,
            serverName: servers.name,
            count: serviceReplicas.count,
          })
          .from(serviceReplicas)
          .innerJoin(servers, eq(serviceReplicas.serverId, servers.id))
          .where(eq(serviceReplicas.serviceId, service.id)),
        db
          .select({ key: secrets.key, updatedAt: secrets.updatedAt })
          .from(secrets)
          .where(eq(secrets.serviceId, service.id)),
        db
          .select()
          .from(rollouts)
          .where(eq(rollouts.serviceId, service.id))
          .orderBy(desc(rollouts.createdAt)),
        db
          .select()
          .from(serviceVolumes)
          .where(eq(serviceVolumes.serviceId, service.id)),
        service.lockedServerId
          ? db
              .select({ name: servers.name })
              .from(servers)
              .where(eq(servers.id, service.lockedServerId))
              .then((r) => r[0])
          : Promise.resolve(null),
      ]);

      const deploymentsWithDetails = await Promise.all(
        serviceDeployments.map(async (deployment) => {
          const [depPorts, server] = await Promise.all([
            db
              .select({
                id: deploymentPorts.id,
                hostPort: deploymentPorts.hostPort,
                containerPort: servicePorts.port,
              })
              .from(deploymentPorts)
              .innerJoin(
                servicePorts,
                eq(deploymentPorts.servicePortId, servicePorts.id)
              )
              .where(eq(deploymentPorts.deploymentId, deployment.id)),
            db
              .select({ name: servers.name, wireguardIp: servers.wireguardIp })
              .from(servers)
              .where(eq(servers.id, deployment.serverId))
              .then((r) => r[0]),
          ]);

          return {
            ...deployment,
            ports: depPorts,
            server,
          };
        })
      );

      return {
        ...service,
        ports,
        configuredReplicas: replicas,
        deployments: deploymentsWithDetails,
        secrets: serviceSecrets,
        rollouts: serviceRollouts,
        volumes,
        lockedServer,
      };
    })
  );

  return Response.json(result);
}
