import { notFound } from "next/navigation";
import Link from "next/link";
import { getServerWithContainers } from "@/actions/servers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, Box, Server } from "lucide-react";

function getStatusVariant(status: string) {
  switch (status) {
    case "online":
      return "default";
    case "pending":
      return "secondary";
    case "offline":
      return "destructive";
    default:
      return "outline";
  }
}

function getContainerStateVariant(state: string) {
  switch (state.toLowerCase()) {
    case "running":
      return "default";
    case "exited":
    case "stopped":
      return "secondary";
    case "dead":
    case "removing":
      return "destructive";
    default:
      return "outline";
  }
}

function formatRelativeTime(date: Date | null) {
  if (!date) return "Never";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return `${diffSecs} seconds ago`;
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
}

export default async function ServerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const server = await getServerWithContainers(id);

  if (!server) {
    notFound();
  }

  const managedContainers = server.containers.filter((c) => c.isManaged);
  const unmanagedContainers = server.containers.filter((c) => !c.isManaged);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex items-center gap-3">
          <Server className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold">{server.name}</h1>
            <Badge variant={getStatusVariant(server.status)}>
              {server.status}
            </Badge>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Server Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Public IP</p>
              <p className="font-mono">{server.publicIp || "—"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">WireGuard IP</p>
              <p className="font-mono">{server.wireguardIp || "—"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Last Seen</p>
              <p>{formatRelativeTime(server.lastHeartbeat)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">CPU</p>
              <p>{server.resourcesCpu !== null ? `${server.resourcesCpu} cores` : "—"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Memory</p>
              <p>{server.resourcesMemory !== null ? `${Math.round(server.resourcesMemory / 1024 * 10) / 10} GB` : "—"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Disk</p>
              <p>{server.resourcesDisk !== null ? `${server.resourcesDisk} GB` : "—"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Box className="h-5 w-5" />
            Managed Containers ({managedContainers.length})
          </CardTitle>
          <CardDescription>
            Containers deployed through Techulus
          </CardDescription>
        </CardHeader>
        <CardContent>
          {managedContainers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No managed containers</p>
          ) : (
            <div className="space-y-2">
              {managedContainers.map((container) => (
                <div
                  key={container.id}
                  className="flex items-center justify-between p-3 border rounded-md"
                >
                  <div className="flex items-center gap-3">
                    <Badge variant={getContainerStateVariant(container.state)}>
                      {container.state}
                    </Badge>
                    <div>
                      <p className="font-medium">{container.name}</p>
                      <p className="text-sm text-muted-foreground font-mono">
                        {container.image}
                      </p>
                    </div>
                  </div>
                  <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                    {container.containerId.slice(0, 12)}
                  </code>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Box className="h-5 w-5 text-muted-foreground" />
            Unmanaged Containers ({unmanagedContainers.length})
          </CardTitle>
          <CardDescription>
            Other containers running on this server
          </CardDescription>
        </CardHeader>
        <CardContent>
          {unmanagedContainers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No unmanaged containers</p>
          ) : (
            <div className="space-y-2">
              {unmanagedContainers.map((container) => (
                <div
                  key={container.id}
                  className="flex items-center justify-between p-3 border rounded-md"
                >
                  <div className="flex items-center gap-3">
                    <Badge variant={getContainerStateVariant(container.state)}>
                      {container.state}
                    </Badge>
                    <div>
                      <p className="font-medium">{container.name}</p>
                      <p className="text-sm text-muted-foreground font-mono">
                        {container.image}
                      </p>
                    </div>
                  </div>
                  <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                    {container.containerId.slice(0, 12)}
                  </code>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
