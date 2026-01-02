"use client";

import { ArrowDownToLine, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime, formatTime } from "@/lib/date";
import { fetcher } from "@/lib/fetcher";

interface LogEntry {
	timestamp: string;
	message: string;
}

interface BuildLogsViewerProps {
	buildId: string;
	serviceId: string;
	isLive: boolean;
}

function highlightMatches(text: string, search: string): React.ReactNode {
	if (!search) return text;

	const regex = new RegExp(
		`(${search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
		"gi",
	);
	const parts = text.split(regex);

	return parts.map((part, i) =>
		regex.test(part) ? (
			<mark
				key={i}
				className="bg-yellow-300 dark:bg-yellow-700 text-inherit rounded-sm px-0.5"
			>
				{part}
			</mark>
		) : (
			part
		),
	);
}

export function BuildLogsViewer({
	buildId,
	serviceId,
	isLive,
}: BuildLogsViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [search, setSearch] = useState("");
	const [autoScroll, setAutoScroll] = useState(true);

	const { data, isLoading } = useSWR<{ logs: LogEntry[] }>(
		`/api/builds/${buildId}/logs`,
		fetcher,
		{
			refreshInterval: isLive ? 2000 : 0,
		},
	);

	const logs = data?.logs || [];

	const filteredLogs = useMemo(() => {
		if (!search) return logs;
		return logs.filter((log) =>
			log.message.toLowerCase().includes(search.toLowerCase()),
		);
	}, [logs, search]);

	useEffect(() => {
		if (autoScroll && containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight;
		}
	}, [filteredLogs.length, autoScroll]);

	return (
		<div className="flex flex-col h-full bg-zinc-100 dark:bg-zinc-950 rounded-lg border">
			<div className="flex items-center gap-2 p-2 border-b bg-zinc-50 dark:bg-zinc-900">
				<div className="relative flex-1">
					<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
					<Input
						placeholder="Search logs..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						className="pl-8 pr-8 h-8"
					/>
					{search && (
						<button
							onClick={() => setSearch("")}
							className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
						>
							<X className="size-4" />
						</button>
					)}
				</div>

				<Button
					variant={autoScroll ? "default" : "outline"}
					size="icon-sm"
					onClick={() => setAutoScroll(!autoScroll)}
					title={autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
				>
					<ArrowDownToLine className="size-4" />
				</Button>
			</div>

			<div
				ref={containerRef}
				className="flex-1 overflow-y-auto font-mono text-xs leading-5"
			>
				{isLoading ? (
					<div className="flex items-center justify-center h-full text-muted-foreground">
						<Spinner className="size-5" />
					</div>
				) : filteredLogs.length === 0 ? (
					<div className="flex items-center justify-center h-full text-muted-foreground">
						{logs.length === 0
							? "Waiting for build logs..."
							: "No logs match your search"}
					</div>
				) : (
					<div className="p-4 py-2">
						{filteredLogs.map((entry, idx) => (
							<div
								key={`${entry.timestamp}-${idx}`}
								className="flex hover:bg-black/5 dark:hover:bg-white/5 -mx-2 px-2 py-0.5"
							>
								<span
									className="shrink-0 text-zinc-400 dark:text-zinc-600 select-none pr-2 tabular-nums"
									title={formatDateTime(entry.timestamp)}
								>
									{formatTime(entry.timestamp)}
								</span>
								<span className="text-zinc-800 dark:text-zinc-200 break-all whitespace-pre-wrap">
									{highlightMatches(entry.message, search)}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
