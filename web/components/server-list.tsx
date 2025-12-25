"use client";

import useSWR from "swr";
import Link from "next/link";
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
import { syncWireGuard } from "@/actions/servers";

type Server = {
  id: string;
  name: string;
  publicIp: string | null;
  wireguardIp: string | null;
  status: string;
};

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function StatusBadge({ status }: { status: string }) {
  const variants: Record<
    string,
    "default" | "secondary" | "destructive" | "outline"
  > = {
    online: "default",
    pending: "secondary",
    offline: "destructive",
    unknown: "outline",
  };

  return <Badge variant={variants[status] || "outline"}>{status}</Badge>;
}

export function ServerList({ initialServers }: { initialServers: Server[] }) {
  const { data: servers } = useSWR<Server[]>("/api/servers", fetcher, {
    fallbackData: initialServers,
    refreshInterval: 10000,
    revalidateOnFocus: true,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Servers</h2>
          <p className="text-muted-foreground">Manage your server fleet</p>
        </div>
        <div className="flex gap-2">
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

      {!servers || servers.length === 0 ? (
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
  );
}
