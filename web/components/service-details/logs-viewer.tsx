"use client";

import { useEffect, useRef } from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Terminal } from "lucide-react";
import { fetcher } from "@/lib/fetcher";

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
	const logsContainerRef = useRef<HTMLDivElement>(null);
	const isNearBottomRef = useRef(true);

	const { data } = useSWR<{ logs: LogEntry[]; hasMore: boolean }>(
		`/api/services/${serviceId}/logs?limit=200`,
		fetcher,
		{ refreshInterval: 2000 },
	);

	const logs = data?.logs || [];

	const handleScroll = () => {
		if (!logsContainerRef.current) return;
		const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current;
		isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;
	};

	useEffect(() => {
		if (logsContainerRef.current && isNearBottomRef.current) {
			logsContainerRef.current.scrollTop =
				logsContainerRef.current.scrollHeight;
		}
	}, [logs]);

	const formatTimestamp = (ts: string) => {
		return new Date(ts).toLocaleTimeString("en-US", {
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<Terminal className="h-4 w-4" />
					Logs
				</CardTitle>
			</CardHeader>
			<CardContent className="p-0">
				<div
					ref={logsContainerRef}
					onScroll={handleScroll}
					className="h-[400px] overflow-y-auto font-mono text-xs bg-zinc-950 text-zinc-100 rounded-b-lg"
				>
					{logs.length === 0 ? (
						<div className="flex items-center justify-center h-full text-zinc-500">
							No logs available
						</div>
					) : (
						<div className="p-3 space-y-0.5">
							{logs.map((entry) => (
								<div
									key={entry.id}
									className={`flex gap-2 ${
										entry.stream === "stderr" ? "text-red-400" : "text-zinc-300"
									}`}
								>
									<span className="text-zinc-600 shrink-0">
										{formatTimestamp(entry.timestamp)}
									</span>
									<span className="break-all whitespace-pre-wrap">
										{entry.message}
									</span>
								</div>
							))}
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
