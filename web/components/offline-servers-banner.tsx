"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";

type Server = {
  id: string;
  name: string;
  status: string;
};

export function OfflineServersBanner() {
  const [offlineServers, setOfflineServers] = useState<Server[]>([]);

  useEffect(() => {
    async function fetchServers() {
      try {
        const response = await fetch("/api/servers");
        if (!response.ok) return;
        const servers: Server[] = await response.json();
        const offline = servers.filter(
          (s) => s.status === "offline" || s.status === "unknown"
        );
        setOfflineServers(offline);
      } catch {
        // Ignore errors
      }
    }

    fetchServers();
    const interval = setInterval(fetchServers, 30000);
    return () => clearInterval(interval);
  }, []);

  if (offlineServers.length === 0) return null;

  const serverNames = offlineServers.map((s) => s.name).join(", ");

  return (
    <div className="bg-destructive/10 border-b border-destructive/20">
      <div className="container max-w-7xl mx-auto px-4 py-2 flex items-center gap-2 text-sm text-destructive">
        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
        <span>
          {offlineServers.length === 1 ? "Server" : "Servers"} offline:{" "}
          <strong>{serverNames}</strong>
        </span>
        <Link
          href="/dashboard"
          className="ml-auto text-xs underline hover:no-underline"
        >
          View dashboard
        </Link>
      </div>
    </div>
  );
}
