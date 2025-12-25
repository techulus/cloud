import { notFound } from "next/navigation";
import Link from "next/link";
import { getProject, listServices, listDeployments, getServicePorts, getDeploymentPorts } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { ServiceList } from "@/components/service-list";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { eq } from "drizzle-orm";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);

  if (!project) {
    notFound();
  }

  const servicesList = await listServices(id);

  const initialServices = await Promise.all(
    servicesList.map(async (service) => {
      const [ports, serviceDeployments] = await Promise.all([
        getServicePorts(service.id),
        listDeployments(service.id),
      ]);

      const deploymentsWithDetails = await Promise.all(
        serviceDeployments.map(async (deployment) => {
          const [depPorts, server] = await Promise.all([
            getDeploymentPorts(deployment.id),
            db
              .select({ wireguardIp: servers.wireguardIp })
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
        deployments: deploymentsWithDetails,
      };
    })
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link href="/dashboard" className="hover:underline">
              Dashboard
            </Link>
            <span>/</span>
            <span>{project.name}</span>
          </div>
          <h2 className="text-2xl font-bold">{project.name}</h2>
        </div>
        <Link href={`/dashboard/projects/${id}/services/new`}>
          <Button>Add Service</Button>
        </Link>
      </div>

      <ServiceList projectId={id} initialServices={initialServices} />
    </div>
  );
}
