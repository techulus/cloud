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
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Globe, Lock, Settings, X } from "lucide-react";
import {
  deployService,
  deleteService,
  stopDeployment,
  deleteDeployment,
  syncDeploymentRoute,
  addServicePort,
  removeServicePort,
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
  isPublic: boolean;
  subdomain: string | null;
};

type Service = {
  id: string;
  projectId: string;
  name: string;
  image: string;
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

function PortManagerDialog({
  service,
  onUpdate,
}: {
  service: Service;
  onUpdate: () => void;
}) {
  const [newPort, setNewPort] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [subdomain, setSubdomain] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const hasRunningDeployments = service.deployments.some(
    (d) => d.status === "running" || d.status === "pending" || d.status === "pulling"
  );

  const hasAnyDeployment = service.deployments.length > 0;

  const handleAddPort = async () => {
    const port = parseInt(newPort);
    if (isNaN(port) || port <= 0 || port > 65535) return;
    if (isPublic && !subdomain.trim()) return;

    setIsAdding(true);
    try {
      await addServicePort(service.id, port, isPublic, isPublic ? subdomain.trim() : undefined);
      setNewPort("");
      setSubdomain("");
      setIsPublic(false);
      onUpdate();
    } catch (error) {
      console.error("Failed to add port:", error);
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemovePort = async (portId: string) => {
    setRemovingId(portId);
    try {
      await removeServicePort(service.id, portId);
      onUpdate();
    } catch (error) {
      console.error("Failed to remove port:", error);
    } finally {
      setRemovingId(null);
    }
  };

  const getPrivateUrl = (port: ServicePort) => {
    const runningDeployment = service.deployments.find((d) => d.status === "running");
    if (!runningDeployment?.server?.wireguardIp) return null;
    const deploymentPort = runningDeployment.ports.find((p) => p.containerPort === port.port);
    if (!deploymentPort) return null;
    return `${runningDeployment.server.wireguardIp}:${deploymentPort.hostPort}`;
  };

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Settings className="h-4 w-4 mr-1" />
        Ports {service.ports.length > 0 && `(${service.ports.length})`}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage Ports</DialogTitle>
        </DialogHeader>

        {hasRunningDeployments && service.ports.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Re-deploy required for port changes to take effect
          </p>
        )}

        {service.ports.length > 0 && (
          <div className="space-y-2">
            {service.ports.map((port) => {
              const privateUrl = getPrivateUrl(port);
              return (
                <div
                  key={port.id}
                  className="flex items-center justify-between bg-muted px-3 py-2 rounded-md text-sm"
                >
                  <div className="flex items-center gap-2">
                    {port.isPublic ? (
                      <Globe className="h-4 w-4 text-primary" />
                    ) : (
                      <Lock className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="font-medium">{port.port}</span>
                    {port.isPublic && port.subdomain && (
                      <a
                        href={`https://${port.subdomain}.techulus.app`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:underline"
                      >
                        {port.subdomain}.techulus.app
                      </a>
                    )}
                    {!port.isPublic && privateUrl && (
                      <span className="text-xs text-muted-foreground">
                        {privateUrl}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemovePort(port.id)}
                    disabled={removingId === port.id}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {hasAnyDeployment ? (
          <div className="space-y-3 pt-2 border-t">
            <p className="text-sm font-medium">Add Port</p>
            <div className="flex gap-2">
              <Input
                type="number"
                placeholder="Port"
                value={newPort}
                onChange={(e) => setNewPort(e.target.value)}
                className="w-24"
                min={1}
                max={65535}
              />
              <button
                type="button"
                onClick={() => setIsPublic(!isPublic)}
                className={`flex items-center gap-1 px-3 py-1 rounded-md text-sm border transition-colors ${
                  isPublic
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted text-muted-foreground border-transparent hover:text-foreground"
                }`}
              >
                {isPublic ? <Globe className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                {isPublic ? "Public" : "Private"}
              </button>
            </div>
            {isPublic && (
              <div className="flex items-center gap-1">
                <Input
                  type="text"
                  placeholder="subdomain"
                  value={subdomain}
                  onChange={(e) => setSubdomain(e.target.value)}
                  className="w-40"
                />
                <span className="text-sm text-muted-foreground">.techulus.app</span>
              </div>
            )}
            <Button
              size="sm"
              onClick={handleAddPort}
              disabled={isAdding || !newPort || (isPublic && !subdomain.trim())}
            >
              {isAdding ? "Adding..." : "Add Port"}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground pt-2 border-t">
            Deploy the service first to add ports
          </p>
        )}
      </DialogContent>
    </Dialog>
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
      {services.map((service) => (
          <Card key={service.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>{service.name}</CardTitle>
                  <CardDescription>{service.image}</CardDescription>
                  {service.ports.filter(p => p.isPublic && p.subdomain).length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {service.ports.filter(p => p.isPublic && p.subdomain).map(port => (
                        <a
                          key={port.id}
                          href={`https://${port.subdomain}.techulus.app`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Globe className="h-3 w-3" />
                          {port.subdomain}.techulus.app
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <PortManagerDialog service={service} onUpdate={handleActionComplete} />
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
      ))}
    </div>
  );
}
