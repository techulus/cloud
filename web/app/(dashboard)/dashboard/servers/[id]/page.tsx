import { notFound } from "next/navigation";
import { getServerDetails } from "@/actions/servers";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";

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
  const server = await getServerDetails(id);

  if (!server) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={server.name}
        breadcrumbs={[{ label: "Servers", href: "/dashboard" }]}
        actions={
          <Badge variant={getStatusVariant(server.status)}>
            {server.status}
          </Badge>
        }
      />

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
    </div>
  );
}
