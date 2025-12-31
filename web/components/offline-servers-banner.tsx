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
    <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-50">
      <div className="bg-destructive/10 border border-destructive/20 text-destructive rounded-lg shadow-lg px-4 py-2 flex items-center gap-3 text-sm">
        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
        <span>
          {offlineServers.length === 1 ? "Server" : "Servers"} offline:{" "}
          <strong>{serverNames}</strong>
        </span>
        <Link
          href="/dashboard"
          className="text-xs underline hover:no-underline"
        >
          View
        </Link>
      </div>
    </div>
  );
}
