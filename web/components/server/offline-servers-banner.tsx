"use client";

import Link from "next/link";
import useSWR from "swr";
import { AlertTriangle } from "lucide-react";
import { fetcher } from "@/lib/fetcher";
import type { Server } from "@/db/types";

type ServerBasic = Pick<Server, "id" | "name" | "status">;

export function OfflineServersBanner() {
	const { data: servers } = useSWR<ServerBasic[]>("/api/servers", fetcher, {
		refreshInterval: 30000,
	});

	const offlineServers =
		servers?.filter((s) => s.status === "offline" || s.status === "unknown") ??
		[];

	if (offlineServers.length === 0) return null;

	const serverNames = offlineServers.map((s) => s.name).join(", ");

	return (
		<div className="bg-destructive/10 border-b border-destructive/20 text-destructive px-4 py-2 flex items-center justify-center gap-3 text-sm">
			<AlertTriangle className="h-4 w-4 shrink-0" />
			<span>
				{offlineServers.length === 1 ? "Server" : "Servers"} offline:{" "}
				<strong>{serverNames}</strong>
			</span>
			<Link href="/dashboard" className="text-xs underline hover:no-underline">
				View
			</Link>
		</div>
	);
}
