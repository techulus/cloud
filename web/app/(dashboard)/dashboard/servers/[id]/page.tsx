import { notFound } from "next/navigation";
import { getServerDetails } from "@/db/queries";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { db } from "@/db";
import { workQueue } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";

function StatusIndicator({ status }: { status: string }) {
  const colors: Record<string, { dot: string; text: string }> = {
    online: {
      dot: "bg-emerald-500",
      text: "text-emerald-600 dark:text-emerald-400",
    },
    pending: {
      dot: "bg-amber-500",
      text: "text-amber-600 dark:text-amber-400",
    },
    offline: {
      dot: "bg-rose-500",
      text: "text-rose-600 dark:text-rose-400",
    },
    unknown: {
      dot: "bg-zinc-400",
      text: "text-zinc-500",
    },
  };

  const color = colors[status] || colors.unknown;

  return (
    <div className="flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        {status === "online" && (
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full ${color.dot} opacity-75`}
          />
        )}
        <span
          className={`relative inline-flex rounded-full h-2 w-2 ${color.dot}`}
        />
      </span>
      <span className={`text-xs font-medium capitalize ${color.text}`}>
        {status}
      </span>
    </div>
  );
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
  const [server, recentActions] = await Promise.all([
    getServerDetails(id),
    db
      .select()
      .from(workQueue)
      .where(eq(workQueue.serverId, id))
      .orderBy(desc(workQueue.createdAt))
      .limit(50),
  ]);

  if (!server) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={server.name}
        breadcrumbs={[{ label: "Servers", href: "/dashboard" }]}
        actions={<StatusIndicator status={server.status} />}
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

      <Card>
        <CardHeader>
          <CardTitle>Recent Actions</CardTitle>
        </CardHeader>
        <CardContent>
          {recentActions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No actions yet</p>
          ) : (
            <div className="space-y-3">
              {recentActions.map((action) => (
                <div
                  key={action.id}
                  className="py-3 border-b last:border-0"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Badge
                        variant={
                          action.status === "completed"
                            ? "default"
                            : action.status === "failed"
                              ? "destructive"
                              : action.status === "processing"
                                ? "secondary"
                                : "outline"
                        }
                      >
                        {action.status}
                      </Badge>
                      <span className="font-medium">{action.type}</span>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {formatRelativeTime(action.createdAt)}
                    </span>
                  </div>
                  <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-x-auto">
                    {JSON.stringify(JSON.parse(action.payload), null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
