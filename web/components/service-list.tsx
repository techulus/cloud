"use client";

import useSWR from "swr";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  deployService,
  deleteService,
  stopDeployment,
  deleteDeployment,
  syncDeploymentRoute,
} from "@/actions/projects";

type DeploymentPort = {
  id: string;
  hostPort: number;
  containerPort: number;
};

type Deployment = {
  id: string;
  serviceId: string;
  serverId: string;
  containerId: string | null;
  status: string;
  ports: DeploymentPort[];
  server: { wireguardIp: string | null } | null;
};

type ServicePort = {
  id: string;
  serviceId: string;
  port: number;
};

type Service = {
  id: string;
  projectId: string;
  name: string;
  image: string;
  exposedDomain: string | null;
  ports: ServicePort[];
  deployments: Deployment[];
};

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function getStatusVariant(status: string) {
  switch (status) {
    case "running":
      return "default";
    case "pending":
    case "pulling":
    case "stopping":
      return "secondary";
    case "stopped":
      return "outline";
    case "failed":
      return "destructive";
    default:
      return "secondary";
  }
}

function ActionButton({
  action,
  label,
  loadingLabel,
  variant = "default",
  size = "sm",
  onComplete,
}: {
  action: () => Promise<unknown>;
  label: string;
  loadingLabel: string;
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  size?: "default" | "sm" | "lg" | "icon";
  onComplete?: () => void;
}) {
  const [isLoading, setIsLoading] = useState(false);

  const handleClick = async () => {
    setIsLoading(true);
    try {
      await action();
      onComplete?.();
    } catch (error) {
      console.error("Action failed:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button onClick={handleClick} disabled={isLoading} variant={variant} size={size}>
      {isLoading ? loadingLabel : label}
    </Button>
  );
}

export function ServiceList({
  projectId,
  initialServices,
}: {
  projectId: string;
  initialServices: Service[];
}) {
  const { data: services, mutate } = useSWR<Service[]>(
    `/api/projects/${projectId}/services`,
    fetcher,
    {
      fallbackData: initialServices,
      refreshInterval: 5000,
      revalidateOnFocus: true,
    }
  );

  const handleActionComplete = () => {
    mutate();
  };

  if (!services || services.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-muted-foreground mb-4">
            No services yet. Add your first service to deploy.
          </p>
          <Link href={`/dashboard/projects/${projectId}/services/new`}>
            <Button>Add Service</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      {services.map((service) => {
        const portsList = service.ports.map((p) => p.port).join(", ");
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
                <div className="flex items-center gap-2">
                  <ActionButton
                    action={() => deployService(service.id)}
                    label="Deploy"
                    loadingLabel="Deploying..."
                    onComplete={handleActionComplete}
                  />
                  <ActionButton
                    action={() => deleteService(service.id)}
                    label="Delete"
                    loadingLabel="Deleting..."
                    variant="outline"
                    onComplete={handleActionComplete}
                  />
                </div>
              </div>
            </CardHeader>
            {service.deployments.length > 0 && (
              <CardContent>
                <div className="space-y-2">
                  <p className="text-sm font-medium">Deployments</p>
                  {service.deployments.map((deployment) => {
                    const portsDisplay = deployment.ports
                      .map((p) => `${p.containerPort}→${p.hostPort}`)
                      .join(", ");
                    const isTransitioning =
                      deployment.status === "pending" ||
                      deployment.status === "pulling" ||
                      deployment.status === "stopping";
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
                            {deployment.server?.wireguardIp} [{portsDisplay}]
                          </span>
                          {deployment.containerId && (
                            <code className="text-xs text-muted-foreground">
                              {deployment.containerId.slice(0, 12)}
                            </code>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {isTransitioning && (
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <svg
                                className="animate-spin h-4 w-4"
                                xmlns="http://www.w3.org/2000/svg"
                                fill="none"
                                viewBox="0 0 24 24"
                              >
                                <circle
                                  className="opacity-25"
                                  cx="12"
                                  cy="12"
                                  r="10"
                                  stroke="currentColor"
                                  strokeWidth="4"
                                />
                                <path
                                  className="opacity-75"
                                  fill="currentColor"
                                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                />
                              </svg>
                            </div>
                          )}
                          {deployment.status === "running" && (
                            <>
                              <ActionButton
                                action={() => syncDeploymentRoute(deployment.id)}
                                label="Sync"
                                loadingLabel="Syncing..."
                                variant="outline"
                                onComplete={handleActionComplete}
                              />
                              <ActionButton
                                action={() => stopDeployment(deployment.id)}
                                label="Stop"
                                loadingLabel="Stopping..."
                                variant="destructive"
                                onComplete={handleActionComplete}
                              />
                            </>
                          )}
                          {(deployment.status === "stopped" ||
                            deployment.status === "failed") && (
                            <ActionButton
                              action={() => deleteDeployment(deployment.id)}
                              label="Delete"
                              loadingLabel="Deleting..."
                              variant="outline"
                              onComplete={handleActionComplete}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}
