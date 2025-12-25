import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getProject,
  listServices,
  listDeployments,
  getServicePorts,
  getDeploymentPorts,
} from "@/actions/projects";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/components/action-button";
import { deployService, stopDeployment, deleteDeployment, syncDeploymentRoute } from "@/actions/projects";
import { db } from "@/db";
import { servers, deployments } from "@/db/schema";
import { eq } from "drizzle-orm";

function getStatusVariant(status: string) {
  switch (status) {
    case "running":
      return "default";
    case "pending":
    case "pulling":
      return "secondary";
    case "stopped":
      return "outline";
    case "failed":
      return "destructive";
    default:
      return "secondary";
  }
}

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [project, services] = await Promise.all([
    getProject(id),
    listServices(id),
  ]);

  if (!project) {
    notFound();
  }

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

      {services.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-muted-foreground mb-4">
              No services yet. Add your first service to deploy.
            </p>
            <Link href={`/dashboard/projects/${id}/services/new`}>
              <Button>Add Service</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {await Promise.all(
            services.map(async (service) => {
              const [serviceDeployments, ports] = await Promise.all([
                listDeployments(service.id),
                getServicePorts(service.id),
              ]);
              const portsList = ports.map((p) => p.port).join(", ");
              return (
                <Card key={service.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle>{service.name}</CardTitle>
                        <CardDescription>
                          {service.image} • Ports: {portsList}
                        </CardDescription>
                        {service.exposedDomain && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {service.exposedDomain}
                          </p>
                        )}
                      </div>
                      <ActionButton
                        action={deployService.bind(null, service.id)}
                        label="Deploy"
                        loadingLabel="Deploying..."
                      />
                    </div>
                  </CardHeader>
                  {serviceDeployments.length > 0 && (
                    <CardContent>
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Deployments</p>
                        {await Promise.all(
                          serviceDeployments.map(async (deployment) => {
                            const [deployPorts, server] = await Promise.all([
                              getDeploymentPorts(deployment.id),
                              db
                                .select({ wireguardIp: servers.wireguardIp })
                                .from(servers)
                                .where(eq(servers.id, deployment.serverId))
                                .then((r) => r[0]),
                            ]);
                            const portsDisplay = deployPorts
                              .map((p) => `${p.containerPort}→${p.hostPort}`)
                              .join(", ");
                            return (
                              <div
                                key={deployment.id}
                                className="flex items-center justify-between text-sm border rounded-md p-2"
                              >
                                <div className="flex items-center gap-2">
                                  <Badge variant={getStatusVariant(deployment.status)}>
                                    {deployment.status}
                                  </Badge>
                                  <span className="text-muted-foreground">
                                    {server?.wireguardIp} [{portsDisplay}]
                                  </span>
                                  {deployment.containerId && (
                                    <code className="text-xs text-muted-foreground">
                                      {deployment.containerId.slice(0, 12)}
                                    </code>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  {deployment.status === "running" && (
                                    <>
                                      <ActionButton
                                        action={syncDeploymentRoute.bind(null, deployment.id)}
                                        label="Sync"
                                        loadingLabel="Syncing..."
                                        variant="outline"
                                      />
                                      <ActionButton
                                        action={stopDeployment.bind(null, deployment.id)}
                                        label="Stop"
                                        loadingLabel="Stopping..."
                                        variant="destructive"
                                      />
                                    </>
                                  )}
                                  {(deployment.status === "stopped" ||
                                    deployment.status === "failed" ||
                                    deployment.status === "pending") && (
                                    <ActionButton
                                      action={deleteDeployment.bind(null, deployment.id)}
                                      label="Delete"
                                      loadingLabel="Deleting..."
                                      variant="outline"
                                    />
                                  )}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </CardContent>
                  )}
                </Card>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
