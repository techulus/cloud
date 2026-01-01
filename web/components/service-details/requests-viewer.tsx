"use client";

import {
	ArrowDownToLine,
	ChevronDown,
	ChevronUp,
	Search,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { fetcher } from "@/lib/fetcher";

interface RequestEntry {
	id: string;
	method: string;
	path: string;
	status: number;
	duration: number;
	clientIp: string;
	timestamp: string;
}

interface RequestsViewerProps {
	serviceId: string;
}

type StatusFilter = "all" | "2xx" | "3xx" | "4xx" | "5xx";

const STATUS_COLORS: Record<string, string> = {
	"2xx": "text-green-500 bg-green-500/10",
	"3xx": "text-blue-500 bg-blue-500/10",
	"4xx": "text-yellow-500 bg-yellow-500/10",
	"5xx": "text-red-500 bg-red-500/10",
};

function getStatusCategory(status: number): string {
	if (status >= 200 && status < 300) return "2xx";
	if (status >= 300 && status < 400) return "3xx";
	if (status >= 400 && status < 500) return "4xx";
	if (status >= 500) return "5xx";
	return "unknown";
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

export function RequestsViewer({ serviceId }: RequestsViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [search, setSearch] = useState("");
	const [statusFilter, setStatusFilter] = useState<Set<StatusFilter>>(
		new Set(["2xx", "3xx", "4xx", "5xx"]),
	);
	const [isPaused, setIsPaused] = useState(false);
	const [autoScroll, setAutoScroll] = useState(true);

	const { data, mutate, isLoading } = useSWR<{
		logs: RequestEntry[];
		hasMore: boolean;
	}>(`/api/services/${serviceId}/requests?limit=500`, fetcher, {
		refreshInterval: isPaused ? 0 : 2000,
	});

	const logs = data?.logs || [];
	const hasMore = data?.hasMore || false;

	const filteredLogs = useMemo(() => {
		return logs.filter((log) => {
			const category = getStatusCategory(log.status) as StatusFilter;
			if (!statusFilter.has(category)) return false;

			if (search) {
				const searchLower = search.toLowerCase();
				const matchesPath = log.path.toLowerCase().includes(searchLower);
				const matchesMethod = log.method.toLowerCase().includes(searchLower);
				const matchesStatus = log.status.toString().includes(search);
				const matchesIp = log.clientIp.includes(search);
				if (!matchesPath && !matchesMethod && !matchesStatus && !matchesIp) {
					return false;
				}
			}

			return true;
		});
	}, [logs, statusFilter, search]);

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

	const toggleStatus = (status: StatusFilter) => {
		const newStatuses = new Set(statusFilter);
		if (newStatuses.has(status)) {
			newStatuses.delete(status);
		} else {
			newStatuses.add(status);
		}
		setStatusFilter(newStatuses);
	};

	const selectAllStatuses = () => {
		setStatusFilter(new Set(["2xx", "3xx", "4xx", "5xx"]));
	};

	const selectNoneStatuses = () => {
		setStatusFilter(new Set());
	};

	const statusLabel = useMemo(() => {
		if (statusFilter.size === 4) return "All statuses";
		if (statusFilter.size === 0) return "No statuses";
		return Array.from(statusFilter).join(", ");
	}, [statusFilter]);

	return (
		<div className="fixed inset-0 top-32 z-50 flex flex-col bg-zinc-100 dark:bg-zinc-950">
			<div className="flex flex-wrap items-center gap-2 p-2 border-b bg-zinc-50 dark:bg-zinc-900">
				<div className="relative flex-1 min-w-50">
					<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
					<Input
						placeholder="Search path, method, status, IP..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						className="pl-8 pr-8 h-8"
					/>
					{search && (
						<button
							type="button"
							onClick={() => setSearch("")}
							className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
						>
							<X className="size-4" />
						</button>
					)}
				</div>

				<DropdownMenu>
					<DropdownMenuTrigger className="inline-flex items-center justify-center gap-1 h-7 px-2.5 text-[0.8rem] font-medium rounded-[min(var(--radius-md),12px)] border border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50">
						{statusLabel}
						<ChevronDown className="size-3" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						<DropdownMenuGroup>
							<DropdownMenuLabel>Status Codes</DropdownMenuLabel>
							<DropdownMenuSeparator />
							<DropdownMenuCheckboxItem
								checked={statusFilter.has("2xx")}
								onCheckedChange={() => toggleStatus("2xx")}
							>
								<span className="flex items-center gap-2">
									<span className="size-2 rounded-full bg-green-500" />
									2xx Success
								</span>
							</DropdownMenuCheckboxItem>
							<DropdownMenuCheckboxItem
								checked={statusFilter.has("3xx")}
								onCheckedChange={() => toggleStatus("3xx")}
							>
								<span className="flex items-center gap-2">
									<span className="size-2 rounded-full bg-blue-500" />
									3xx Redirect
								</span>
							</DropdownMenuCheckboxItem>
							<DropdownMenuCheckboxItem
								checked={statusFilter.has("4xx")}
								onCheckedChange={() => toggleStatus("4xx")}
							>
								<span className="flex items-center gap-2">
									<span className="size-2 rounded-full bg-yellow-500" />
									4xx Client Error
								</span>
							</DropdownMenuCheckboxItem>
							<DropdownMenuCheckboxItem
								checked={statusFilter.has("5xx")}
								onCheckedChange={() => toggleStatus("5xx")}
							>
								<span className="flex items-center gap-2">
									<span className="size-2 rounded-full bg-red-500" />
									5xx Server Error
								</span>
							</DropdownMenuCheckboxItem>
							<DropdownMenuSeparator />
							<DropdownMenuCheckboxItem
								checked={statusFilter.size === 4}
								onCheckedChange={() =>
									statusFilter.size === 4
										? selectNoneStatuses()
										: selectAllStatuses()
								}
							>
								Select all
							</DropdownMenuCheckboxItem>
						</DropdownMenuGroup>
					</DropdownMenuContent>
				</DropdownMenu>

				<div className="flex items-center gap-2 ml-auto">
					<button
						type="button"
						onClick={() => setIsPaused(!isPaused)}
						className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border transition-colors ${
							isPaused
								? "border-border bg-background hover:bg-muted text-muted-foreground"
								: "border-primary bg-primary/10 text-primary hover:bg-primary/20"
						}`}
						title={isPaused ? "Resume live updates" : "Pause live updates"}
					>
						<span
							className={`size-2 rounded-full ${
								isPaused ? "bg-muted-foreground" : "bg-primary animate-pulse"
							}`}
						/>
						{isPaused ? "Paused" : "Live"}
					</button>
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
							Load older requests
						</Button>
					</div>
				)}

				{isLoading ? (
					<div className="flex items-center justify-center h-full text-muted-foreground">
						<Spinner className="size-5" />
					</div>
				) : filteredLogs.length === 0 ? (
					<div className="flex items-center justify-center h-full text-muted-foreground">
						{logs.length === 0
							? "No requests available"
							: "No requests match filters"}
					</div>
				) : (
					<>
						{!isPaused && (
							<div className="flex items-center gap-2 py-1 px-2 text-xs font-medium text-primary bg-primary/5 border-y border-primary/20 sticky top-0">
								<span className="text-primary">▶</span>
								Live Mode
							</div>
						)}
						<div className="p-4 py-2">
							{[...filteredLogs].reverse().map((entry) => {
								const category = getStatusCategory(entry.status);
								const statusColor = STATUS_COLORS[category] || "";

								return (
									<div
										key={entry.id}
										className="flex hover:bg-black/5 dark:hover:bg-white/5 -mx-2 px-2 py-0.5 group"
									>
										<span
											className="shrink-0 text-zinc-400 dark:text-zinc-600 select-none pr-2 tabular-nums"
											title={formatFullTimestamp(entry.timestamp)}
										>
											{formatTimestamp(entry.timestamp)}
										</span>
										<span
											className={`shrink-0 px-1.5 rounded text-[10px] font-medium mr-2 tabular-nums ${statusColor}`}
										>
											{entry.status}
										</span>
										<span className="shrink-0 w-12 text-zinc-500 dark:text-zinc-400 font-medium">
											{entry.method}
										</span>
										<span className="flex-1 break-all whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">
											{highlightMatches(entry.path, search)}
										</span>
										<span className="shrink-0 ml-2 text-zinc-400 dark:text-zinc-500 tabular-nums">
											{Math.round(Number(entry.duration) || 0)}ms
										</span>
										<span className="shrink-0 ml-2 text-zinc-400 dark:text-zinc-500 tabular-nums hidden group-hover:inline">
											{entry.clientIp}
										</span>
									</div>
								);
							})}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
