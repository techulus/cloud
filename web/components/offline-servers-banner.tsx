"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { Server } from "@/db/types";

type ServerBasic = Pick<Server, "id" | "name" | "status">;

export function OfflineServersBanner() {
	const [offlineServers, setOfflineServers] = useState<ServerBasic[]>([]);
	const [isVisible, setIsVisible] = useState(false);
	const [shouldRender, setShouldRender] = useState(false);
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);

	useEffect(() => {
		async function fetchServers() {
			try {
				const response = await fetch("/api/servers");
				if (!response.ok) return;
				const servers: ServerBasic[] = await response.json();
				const offline = servers.filter(
					(s) => s.status === "offline" || s.status === "unknown",
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

	useEffect(() => {
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}

		if (offlineServers.length > 0) {
			setShouldRender(true);
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					setIsVisible(true);
				});
			});
		} else {
			setIsVisible(false);
			timeoutRef.current = setTimeout(() => {
				setShouldRender(false);
			}, 300);
		}

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, [offlineServers.length]);

	if (!shouldRender) return null;

	const serverNames = offlineServers.map((s) => s.name).join(", ");

	return (
		<div
			className={`fixed bottom-12 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ease-out ${
				isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
			}`}
		>
			<div className="bg-destructive/10 border border-destructive/20 text-destructive rounded-lg shadow-lg px-4 py-2 flex items-center gap-3 text-sm">
				<AlertTriangle className="h-4 w-4 shrink-0" />
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
