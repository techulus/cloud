"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuCheckboxItem,
	DropdownMenuSeparator,
	DropdownMenuLabel,
	DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import {
	Search,
	ChevronDown,
	Pause,
	Play,
	Copy,
	Download,
	ArrowDownToLine,
	X,
	ChevronUp,
} from "lucide-react";
import { toast } from "sonner";

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

type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_COLORS: Record<LogLevel, string> = {
	error: "text-red-500 bg-red-500/10",
	warn: "text-yellow-500 bg-yellow-500/10",
	info: "text-blue-500 bg-blue-500/10",
	debug: "text-zinc-500 bg-zinc-500/10",
};

function detectLevel(message: string): LogLevel | null {
	const m = message.toLowerCase();
	if (/\berror\b|\[error\]|error:|"level":"error"/.test(m)) return "error";
	if (/\bwarn(ing)?\b|\[warn(ing)?\]|warn:|"level":"warn"/.test(m))
		return "warn";
	if (/\binfo\b|\[info\]|info:|"level":"info"/.test(m)) return "info";
	if (/\bdebug\b|\[debug\]|debug:|"level":"debug"/.test(m)) return "debug";
	return null;
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

export function LogsViewer({ serviceId }: LogsViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [search, setSearch] = useState("");
	const [levels, setLevels] = useState<Set<LogLevel>>(
		new Set(["error", "warn", "info", "debug"]),
	);
	const [showStdout, setShowStdout] = useState(true);
	const [showStderr, setShowStderr] = useState(true);
	const [isPaused, setIsPaused] = useState(false);
	const [autoScroll, setAutoScroll] = useState(true);

	const { data, mutate } = useSWR<{ logs: LogEntry[]; hasMore: boolean }>(
		`/api/services/${serviceId}/logs?limit=500`,
		fetcher,
		{ refreshInterval: isPaused ? 0 : 2000 },
	);

	const logs = data?.logs || [];
	const hasMore = data?.hasMore || false;

	const filteredLogs = useMemo(() => {
		return logs.filter((log) => {
			if (log.stream === "stdout" && !showStdout) return false;
			if (log.stream === "stderr" && !showStderr) return false;

			const level = detectLevel(log.message);
			if (level && !levels.has(level)) return false;

			if (search && !log.message.toLowerCase().includes(search.toLowerCase()))
				return false;

			return true;
		});
	}, [logs, showStdout, showStderr, levels, search]);

	useEffect(() => {
		if (autoScroll && containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight;
		}
	}, [filteredLogs.length, autoScroll]);

	const formatTimestamp = (ts: string) => {
		return new Date(ts).toLocaleTimeString("en-US", {
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	};

	const formatFullTimestamp = (ts: string) => {
		return new Date(ts).toLocaleString("en-US", {
			hour12: false,
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	};

	const toggleLevel = (level: LogLevel) => {
		const newLevels = new Set(levels);
		if (newLevels.has(level)) {
			newLevels.delete(level);
		} else {
			newLevels.add(level);
		}
		setLevels(newLevels);
	};

	const selectAllLevels = () => {
		setLevels(new Set(["error", "warn", "info", "debug"]));
	};

	const selectNoneLevels = () => {
		setLevels(new Set());
	};

	const copyLogs = useCallback(() => {
		const text = filteredLogs
			.map(
				(log) =>
					`${formatFullTimestamp(log.timestamp)} [${log.stream}] ${log.message}`,
			)
			.join("\n");
		navigator.clipboard.writeText(text);
		toast.success("Logs copied to clipboard");
	}, [filteredLogs]);

	const downloadLogs = useCallback(() => {
		const text = filteredLogs
			.map(
				(log) =>
					`${formatFullTimestamp(log.timestamp)} [${log.stream}] ${log.message}`,
			)
			.join("\n");
		const blob = new Blob([text], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `logs-${serviceId}-${new Date().toISOString().slice(0, 10)}.log`;
		a.click();
		URL.revokeObjectURL(url);
		toast.success("Logs downloaded");
	}, [filteredLogs, serviceId]);

	const levelLabel = useMemo(() => {
		if (levels.size === 4) return "All levels";
		if (levels.size === 0) return "No levels";
		return Array.from(levels).join(", ");
	}, [levels]);

	return (
		<div className="fixed inset-0 top-32 z-50 flex flex-col bg-zinc-100 dark:bg-zinc-950">
			<div className="flex flex-wrap items-center gap-2 p-2 border-b bg-zinc-50 dark:bg-zinc-900">
				<div className="relative flex-1 min-w-[200px]">
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

				<DropdownMenu>
					<DropdownMenuTrigger className="inline-flex items-center justify-center gap-1 h-7 px-2.5 text-[0.8rem] font-medium rounded-[min(var(--radius-md),12px)] border border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50">
						{levelLabel}
						<ChevronDown className="size-3" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						<DropdownMenuGroup>
							<DropdownMenuLabel>Log Levels</DropdownMenuLabel>
							<DropdownMenuSeparator />
							<DropdownMenuCheckboxItem
								checked={levels.has("error")}
								onCheckedChange={() => toggleLevel("error")}
							>
								<span className="flex items-center gap-2">
									<span className="size-2 rounded-full bg-red-500" />
									Error
								</span>
							</DropdownMenuCheckboxItem>
							<DropdownMenuCheckboxItem
								checked={levels.has("warn")}
								onCheckedChange={() => toggleLevel("warn")}
							>
								<span className="flex items-center gap-2">
									<span className="size-2 rounded-full bg-yellow-500" />
									Warn
								</span>
							</DropdownMenuCheckboxItem>
							<DropdownMenuCheckboxItem
								checked={levels.has("info")}
								onCheckedChange={() => toggleLevel("info")}
							>
								<span className="flex items-center gap-2">
									<span className="size-2 rounded-full bg-blue-500" />
									Info
								</span>
							</DropdownMenuCheckboxItem>
							<DropdownMenuCheckboxItem
								checked={levels.has("debug")}
								onCheckedChange={() => toggleLevel("debug")}
							>
								<span className="flex items-center gap-2">
									<span className="size-2 rounded-full bg-zinc-500" />
									Debug
								</span>
							</DropdownMenuCheckboxItem>
							<DropdownMenuSeparator />
							<DropdownMenuCheckboxItem
								checked={levels.size === 4}
								onCheckedChange={() =>
									levels.size === 4 ? selectNoneLevels() : selectAllLevels()
								}
							>
								Select all
							</DropdownMenuCheckboxItem>
						</DropdownMenuGroup>
					</DropdownMenuContent>
				</DropdownMenu>

				<div className="flex items-center gap-1">
					<Button
						variant={showStdout ? "default" : "outline"}
						size="sm"
						onClick={() => setShowStdout(!showStdout)}
					>
						stdout
					</Button>
					<Button
						variant={showStderr ? "destructive" : "outline"}
						size="sm"
						onClick={() => setShowStderr(!showStderr)}
					>
						stderr
					</Button>
				</div>

				<div className="flex items-center gap-1 ml-auto">
					<Button
						variant="outline"
						size="icon-sm"
						onClick={() => setIsPaused(!isPaused)}
						title={isPaused ? "Resume" : "Pause"}
					>
						{isPaused ? (
							<Play className="size-4" />
						) : (
							<Pause className="size-4" />
						)}
					</Button>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={copyLogs}
						title="Copy logs"
					>
						<Copy className="size-4" />
					</Button>
					<Button
						variant="outline"
						size="icon-sm"
						onClick={downloadLogs}
						title="Download logs"
					>
						<Download className="size-4" />
					</Button>
					<Button
						variant={autoScroll ? "default" : "outline"}
						size="icon-sm"
						onClick={() => setAutoScroll(!autoScroll)}
						title={autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
					>
						<ArrowDownToLine className="size-4" />
					</Button>
				</div>
			</div>

			<div
				ref={containerRef}
				className="flex-1 overflow-y-auto font-mono text-xs leading-5"
			>
				{hasMore && (
					<div className="flex justify-center py-2 border-b">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => mutate()}
							className="gap-1 text-muted-foreground"
						>
							<ChevronUp className="size-3" />
							Load older logs
						</Button>
					</div>
				)}

				{filteredLogs.length === 0 ? (
					<div className="flex items-center justify-center h-full text-muted-foreground">
						{logs.length === 0 ? "No logs available" : "No logs match filters"}
					</div>
				) : (
					<div className="p-2">
						{filteredLogs.map((entry, index) => {
							const level = detectLevel(entry.message);
							return (
								<div
									key={entry.id}
									className="flex hover:bg-black/5 dark:hover:bg-white/5 -mx-2 px-2 py-0.5 group"
								>
									<span className="shrink-0 text-zinc-400 dark:text-zinc-600 select-none pr-2 tabular-nums w-8 text-right">
										{index + 1}
									</span>
									<span
										className="shrink-0 text-zinc-400 dark:text-zinc-600 select-none pr-2 tabular-nums"
										title={formatFullTimestamp(entry.timestamp)}
									>
										{formatTimestamp(entry.timestamp)}
									</span>
									{level && (
										<span
											className={`shrink-0 px-1.5 rounded text-[10px] font-medium uppercase mr-2 ${LEVEL_COLORS[level]}`}
										>
											{level}
										</span>
									)}
									<span
										className={`shrink-0 px-1 rounded text-[10px] mr-2 ${
											entry.stream === "stderr"
												? "text-red-600 dark:text-red-400 bg-red-500/10"
												: "text-zinc-600 dark:text-zinc-400 bg-zinc-500/10"
										}`}
									>
										{entry.stream}
									</span>
									<span
										className={`break-all whitespace-pre-wrap ${
											entry.stream === "stderr"
												? "text-red-600 dark:text-red-400"
												: "text-zinc-800 dark:text-zinc-200"
										}`}
									>
										{highlightMatches(entry.message, search)}
									</span>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{isPaused && (
				<div className="flex items-center justify-center gap-2 py-1.5 px-3 border-t bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 text-xs font-medium">
					<Pause className="size-3" />
					Paused - new logs are not being fetched
				</div>
			)}
		</div>
	);
}
