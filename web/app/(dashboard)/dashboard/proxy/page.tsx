import Link from "next/link";
import { getProxyRoutes } from "@/actions/proxy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, Globe, Network } from "lucide-react";

function formatRelativeTime(date: Date | null) {
  if (!date) return "Never";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

export default async function ProxyPage() {
  const routes = await getProxyRoutes();

  const managedRoutes = routes.filter((r) => r.isManaged);
  const unmanagedRoutes = routes.filter((r) => !r.isManaged);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex items-center gap-3">
          <Network className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold">Proxy</h1>
            <p className="text-sm text-muted-foreground">
              {routes.length} route{routes.length !== 1 ? "s" : ""} configured
            </p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Managed Routes ({managedRoutes.length})
          </CardTitle>
          <CardDescription>
            Routes deployed through Techulus services
          </CardDescription>
        </CardHeader>
        <CardContent>
          {managedRoutes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No managed routes</p>
          ) : (
            <div className="space-y-2">
              {managedRoutes.map((route) => {
                const upstreams = JSON.parse(route.upstreams) as string[];
                return (
                  <div
                    key={route.id}
                    className="flex items-center justify-between p-3 border rounded-md"
                  >
                    <div className="flex items-center gap-3">
                      <Badge variant="default">managed</Badge>
                      <div>
                        <p className="font-medium">{route.domain}</p>
                        <p className="text-sm text-muted-foreground">
                          {upstreams.length} upstream{upstreams.length !== 1 ? "s" : ""}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">
                        {formatRelativeTime(route.lastSeen)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5 text-muted-foreground" />
            Unmanaged Routes ({unmanagedRoutes.length})
          </CardTitle>
          <CardDescription>
            Routes configured manually on the proxy
          </CardDescription>
        </CardHeader>
        <CardContent>
          {unmanagedRoutes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No unmanaged routes</p>
          ) : (
            <div className="space-y-2">
              {unmanagedRoutes.map((route) => {
                const upstreams = JSON.parse(route.upstreams) as string[];
                return (
                  <div
                    key={route.id}
                    className="flex items-center justify-between p-3 border rounded-md"
                  >
                    <div className="flex items-center gap-3">
                      <Badge variant="secondary">unmanaged</Badge>
                      <div>
                        <p className="font-medium">{route.domain}</p>
                        <p className="text-sm text-muted-foreground">
                          {upstreams.length} upstream{upstreams.length !== 1 ? "s" : ""}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">
                        {formatRelativeTime(route.lastSeen)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
