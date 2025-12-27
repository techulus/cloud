import { notFound } from "next/navigation";
import {
  getProjectBySlug,
  listServices,
  listDeployments,
  getServicePorts,
  getDeploymentPorts,
} from "@/actions/projects";
import { ServiceCanvas } from "@/components/service-canvas";
import { PageHeader } from "@/components/page-header";
import { CreateServiceDialog } from "@/components/create-service-dialog";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { eq } from "drizzle-orm";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);

  if (!project) {
    notFound();
  }

  const servicesList = await listServices(project.id);

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
        deployments: deploymentsWithDetails,
      };
    })
  );

  return (
    <div>
      <PageHeader
        title={project.name}
        backHref="/dashboard"
        actions={<CreateServiceDialog projectId={project.id} />}
        compact
      />
      <ServiceCanvas
        projectId={project.id}
        projectSlug={slug}
        initialServices={initialServices}
      />
    </div>
  );
}
