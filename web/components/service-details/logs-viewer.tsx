"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useEffect, useRef } from "react";

interface LogEntry {
	id: string;
	deploymentId: string;
	stream: "stdout" | "stderr";
	message: string;
	timestamp: string;
}

interface LogsViewerProps {
	serviceId: string;
}

export function LogsViewer({ serviceId }: LogsViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const { data } = useSWR<{ logs: LogEntry[]; hasMore: boolean }>(
		`/api/services/${serviceId}/logs?limit=200`,
		fetcher,
		{ refreshInterval: 2000 },
	);

	const logs = data?.logs || [];

	useEffect(() => {
		if (containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight;
		}
	}, [logs.length]);

	const formatTimestamp = (ts: string) => {
		return new Date(ts).toLocaleTimeString("en-US", {
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	};

	return (
		<div
			ref={containerRef}
			className="h-[70vh] overflow-y-auto font-mono text-[11px] leading-4 rounded-xl border bg-zinc-100 dark:bg-zinc-950"
		>
			{logs.length === 0 ? (
				<div className="flex items-center justify-center h-full text-muted-foreground">
					No logs available
				</div>
			) : (
				<div className="p-4">
					{logs.map((entry) => (
						<div
							key={entry.id}
							className="flex hover:bg-black/5 dark:hover:bg-white/5 -mx-4 px-4"
						>
							<span className="shrink-0 text-zinc-400 dark:text-zinc-600 select-none pr-4 tabular-nums">
								{formatTimestamp(entry.timestamp)}
							</span>
							<span
								className={`break-all whitespace-pre-wrap ${
									entry.stream === "stderr"
										? "text-red-600 dark:text-red-400"
										: "text-zinc-800 dark:text-zinc-200"
								}`}
							>
								{entry.message}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
