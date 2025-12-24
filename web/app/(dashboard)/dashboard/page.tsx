import Link from "next/link";
import { listServers } from "@/actions/servers";
import { listProjects } from "@/actions/projects";
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
import { syncWireGuard, refreshServerStatuses } from "@/actions/servers";

export default async function DashboardPage() {
  const [servers, projects] = await Promise.all([listServers(), listProjects()]);

  return (
    <div className="space-y-8">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Projects</h2>
            <p className="text-muted-foreground">Deploy and manage services</p>
          </div>
          <Link href="/dashboard/projects/new">
            <Button>New Project</Button>
          </Link>
        </div>

        {projects.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center">
              <p className="text-muted-foreground mb-4">
                No projects yet. Create your first project to deploy services.
              </p>
              <Link href="/dashboard/projects/new">
                <Button>New Project</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <Link key={project.id} href={`/dashboard/projects/${project.id}`}>
                <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                  <CardHeader>
                    <CardTitle>{project.name}</CardTitle>
                    <CardDescription>{project.slug}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Servers</h2>
            <p className="text-muted-foreground">Manage your server fleet</p>
          </div>
          <div className="flex gap-2">
            <ActionButton
              action={refreshServerStatuses}
              label="Refresh Status"
              loadingLabel="Refreshing..."
              variant="outline"
            />
            <ActionButton
              action={syncWireGuard}
              label="Sync WireGuard"
              loadingLabel="Syncing..."
              variant="outline"
            />
            <Link href="/dashboard/servers/new">
              <Button variant="outline">Add Server</Button>
            </Link>
          </div>
        </div>

        {servers.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center">
              <p className="text-muted-foreground mb-4">
                No servers yet. Add your first server to get started.
              </p>
              <Link href="/dashboard/servers/new">
                <Button>Add Server</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {servers.map((server) => (
              <Card key={server.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{server.name}</CardTitle>
                    <StatusBadge status={server.status} />
                  </div>
                  <CardDescription>
                    {server.wireguardIp || "Not registered"}{" "}
                    {server.publicIp && `• ${server.publicIp}`}
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    online: "default",
    pending: "secondary",
    offline: "destructive",
    unknown: "outline",
  };

  return (
    <Badge variant={variants[status] || "outline"}>
      {status}
    </Badge>
  );
}
