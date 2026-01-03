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
import { formatDateTime, formatTime } from "@/lib/date";
import { fetcher } from "@/lib/fetcher";

type LogLevel = "error" | "warn" | "info" | "debug";
type StatusCategory = "2xx" | "3xx" | "4xx" | "5xx";

interface BaseEntry {
	timestamp: string;
}

interface ServiceLogEntry extends BaseEntry {
	id: string;
	deploymentId?: string;
	stream: "stdout" | "stderr";
	message: string;
}

interface RequestEntry extends BaseEntry {
	id: string;
	method: string;
	path: string;
	status: number;
	duration: number;
	clientIp: string;
}

interface BuildLogEntry extends BaseEntry {
	message: string;
}

type LogViewerVariant = "service-logs" | "requests" | "build-logs";

type LogViewerProps =
	| { variant: "service-logs"; serviceId: string }
	| { variant: "requests"; serviceId: string }
	| { variant: "build-logs"; buildId: string; isLive: boolean };

const LEVEL_COLORS: Record<LogLevel, string> = {
	error: "text-red-500 bg-red-500/10",
	warn: "text-yellow-500 bg-yellow-500/10",
	info: "text-blue-500 bg-blue-500/10",
	debug: "text-zinc-500 bg-zinc-500/10",
};

const STATUS_COLORS: Record<StatusCategory, string> = {
	"2xx": "text-green-500 bg-green-500/10",
	"3xx": "text-blue-500 bg-blue-500/10",
	"4xx": "text-yellow-500 bg-yellow-500/10",
	"5xx": "text-red-500 bg-red-500/10",
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

function getStatusCategory(status: number): StatusCategory {
	if (status >= 200 && status < 300) return "2xx";
	if (status >= 300 && status < 400) return "3xx";
	if (status >= 400 && status < 500) return "4xx";
	return "5xx";
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

function useLogData(props: LogViewerProps) {
	const endpoint = useMemo(() => {
		switch (props.variant) {
			case "service-logs":
				return `/api/services/${props.serviceId}/logs?limit=500&type=container`;
			case "requests":
				return `/api/services/${props.serviceId}/requests?limit=500`;
			case "build-logs":
				return `/api/builds/${props.buildId}/logs`;
		}
	}, [props]);

	const pollingInterval = useMemo(() => {
		if (props.variant === "build-logs") {
			return props.isLive ? 2000 : 0;
		}
		return 2000;
	}, [props]);

	return useSWR<{ logs: unknown[]; hasMore?: boolean }>(endpoint, fetcher, {
		refreshInterval: pollingInterval,
	});
}

function ServiceLogsFilters({
	levels,
	onLevelsChange,
	showStdout,
	onShowStdoutChange,
	showStderr,
	onShowStderrChange,
}: {
	levels: Set<LogLevel>;
	onLevelsChange: (levels: Set<LogLevel>) => void;
	showStdout: boolean;
	onShowStdoutChange: (show: boolean) => void;
	showStderr: boolean;
	onShowStderrChange: (show: boolean) => void;
}) {
	const toggleLevel = (level: LogLevel) => {
		const newLevels = new Set(levels);
		if (newLevels.has(level)) {
			newLevels.delete(level);
		} else {
			newLevels.add(level);
		}
		onLevelsChange(newLevels);
	};

	const levelLabel = useMemo(() => {
		if (levels.size === 4) return "All levels";
		if (levels.size === 0) return "No levels";
		return Array.from(levels).join(", ");
	}, [levels]);

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger className="inline-flex items-center justify-center gap-1 h-7 px-2.5 text-[0.8rem] font-medium rounded-[min(var(--radius-md),12px)] border border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50">
					{levelLabel}
					<ChevronDown className="size-3" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuGroup>
						<DropdownMenuLabel>Log Levels</DropdownMenuLabel>
						<DropdownMenuSeparator />
						{(["error", "warn", "info", "debug"] as LogLevel[]).map((level) => (
							<DropdownMenuCheckboxItem
								key={level}
								checked={levels.has(level)}
								onCheckedChange={() => toggleLevel(level)}
							>
								<span className="flex items-center gap-2">
									<span
										className={`size-2 rounded-full ${
											level === "error"
												? "bg-red-500"
												: level === "warn"
													? "bg-yellow-500"
													: level === "info"
														? "bg-blue-500"
														: "bg-zinc-500"
										}`}
									/>
									{level.charAt(0).toUpperCase() + level.slice(1)}
								</span>
							</DropdownMenuCheckboxItem>
						))}
						<DropdownMenuSeparator />
						<DropdownMenuCheckboxItem
							checked={levels.size === 4}
							onCheckedChange={() =>
								onLevelsChange(
									levels.size === 4
										? new Set()
										: new Set(["error", "warn", "info", "debug"]),
								)
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
					onClick={() => onShowStdoutChange(!showStdout)}
				>
					stdout
				</Button>
				<Button
					variant={showStderr ? "destructive" : "outline"}
					size="sm"
					onClick={() => onShowStderrChange(!showStderr)}
				>
					stderr
				</Button>
			</div>
		</>
	);
}

function RequestsFilters({
	statusFilter,
	onStatusFilterChange,
}: {
	statusFilter: Set<StatusCategory>;
	onStatusFilterChange: (filter: Set<StatusCategory>) => void;
}) {
	const toggleStatus = (status: StatusCategory) => {
		const newStatuses = new Set(statusFilter);
		if (newStatuses.has(status)) {
			newStatuses.delete(status);
		} else {
			newStatuses.add(status);
		}
		onStatusFilterChange(newStatuses);
	};

	const statusLabel = useMemo(() => {
		if (statusFilter.size === 4) return "All statuses";
		if (statusFilter.size === 0) return "No statuses";
		return Array.from(statusFilter).join(", ");
	}, [statusFilter]);

	const statusOptions: {
		value: StatusCategory;
		label: string;
		color: string;
	}[] = [
		{ value: "2xx", label: "2xx Success", color: "bg-green-500" },
		{ value: "3xx", label: "3xx Redirect", color: "bg-blue-500" },
		{ value: "4xx", label: "4xx Client Error", color: "bg-yellow-500" },
		{ value: "5xx", label: "5xx Server Error", color: "bg-red-500" },
	];

	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="inline-flex items-center justify-center gap-1 h-7 px-2.5 text-[0.8rem] font-medium rounded-[min(var(--radius-md),12px)] border border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50">
				{statusLabel}
				<ChevronDown className="size-3" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Status Codes</DropdownMenuLabel>
					<DropdownMenuSeparator />
					{statusOptions.map((opt) => (
						<DropdownMenuCheckboxItem
							key={opt.value}
							checked={statusFilter.has(opt.value)}
							onCheckedChange={() => toggleStatus(opt.value)}
						>
							<span className="flex items-center gap-2">
								<span className={`size-2 rounded-full ${opt.color}`} />
								{opt.label}
							</span>
						</DropdownMenuCheckboxItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuCheckboxItem
						checked={statusFilter.size === 4}
						onCheckedChange={() =>
							onStatusFilterChange(
								statusFilter.size === 4
									? new Set()
									: new Set(["2xx", "3xx", "4xx", "5xx"]),
							)
						}
					>
						Select all
					</DropdownMenuCheckboxItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ServiceLogRow({
	entry,
	search,
}: {
	entry: ServiceLogEntry;
	search: string;
}) {
	const level = detectLevel(entry.message);

	return (
		<div className="flex hover:bg-black/5 dark:hover:bg-white/5 -mx-2 px-2 py-0.5 group">
			<span
				className="shrink-0 text-zinc-400 dark:text-zinc-600 select-none pr-2 tabular-nums"
				title={formatDateTime(entry.timestamp)}
			>
				{formatTime(entry.timestamp)}
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
}

function RequestRow({
	entry,
	search,
}: {
	entry: RequestEntry;
	search: string;
}) {
	const category = getStatusCategory(entry.status);

	return (
		<div className="flex hover:bg-black/5 dark:hover:bg-white/5 -mx-2 px-2 py-0.5 group">
			<span
				className="shrink-0 text-zinc-400 dark:text-zinc-600 select-none pr-2 tabular-nums"
				title={formatDateTime(entry.timestamp)}
			>
				{formatTime(entry.timestamp)}
			</span>
			<span
				className={`shrink-0 px-1.5 rounded text-[10px] font-medium mr-2 tabular-nums ${STATUS_COLORS[category]}`}
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
}

function BuildLogRow({
	entry,
	search,
}: {
	entry: BuildLogEntry;
	search: string;
}) {
	return (
		<div className="flex hover:bg-black/5 dark:hover:bg-white/5 -mx-2 px-2 py-0.5">
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
	);
}

export function LogViewer(props: LogViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [search, setSearch] = useState("");
	const [autoScroll, setAutoScroll] = useState(true);

	const [levels, setLevels] = useState<Set<LogLevel>>(
		new Set(["error", "warn", "info", "debug"]),
	);
	const [showStdout, setShowStdout] = useState(true);
	const [showStderr, setShowStderr] = useState(true);
	const [statusFilter, setStatusFilter] = useState<Set<StatusCategory>>(
		new Set(["2xx", "3xx", "4xx", "5xx"]),
	);

	const { data, mutate, isLoading } = useLogData(props);
	const logs = (data?.logs || []) as unknown[];
	const hasMore = data?.hasMore || false;

	const filteredLogs = useMemo(() => {
		return logs.filter((log) => {
			if (props.variant === "service-logs") {
				const entry = log as ServiceLogEntry;
				if (entry.stream === "stdout" && !showStdout) return false;
				if (entry.stream === "stderr" && !showStderr) return false;

				const level = detectLevel(entry.message);
				if (level && !levels.has(level)) return false;

				if (
					search &&
					!entry.message.toLowerCase().includes(search.toLowerCase())
				)
					return false;
			} else if (props.variant === "requests") {
				const entry = log as RequestEntry;
				const category = getStatusCategory(entry.status);
				if (!statusFilter.has(category)) return false;

				if (search) {
					const searchLower = search.toLowerCase();
					const matchesPath = entry.path.toLowerCase().includes(searchLower);
					const matchesMethod = entry.method
						.toLowerCase()
						.includes(searchLower);
					const matchesStatus = entry.status.toString().includes(search);
					const matchesIp = entry.clientIp.includes(search);
					if (!matchesPath && !matchesMethod && !matchesStatus && !matchesIp) {
						return false;
					}
				}
			} else if (props.variant === "build-logs") {
				const entry = log as BuildLogEntry;
				if (
					search &&
					!entry.message.toLowerCase().includes(search.toLowerCase())
				)
					return false;
			}

			return true;
		});
	}, [
		logs,
		props.variant,
		search,
		levels,
		showStdout,
		showStderr,
		statusFilter,
	]);

	useEffect(() => {
		if (autoScroll && containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight;
		}
	}, [filteredLogs.length, autoScroll]);

	const config = useMemo(() => {
		switch (props.variant) {
			case "service-logs":
				return {
					searchPlaceholder: "Search logs...",
					emptyMessage: "No logs available",
					noMatchMessage: "No logs match filters",
					loadMoreLabel: "Load older logs",
					height: "h-[84vh]",
				};
			case "requests":
				return {
					searchPlaceholder: "Search path, method, status, IP...",
					emptyMessage: "No requests available",
					noMatchMessage: "No requests match filters",
					loadMoreLabel: "Load older requests",
					height: "h-[84vh]",
				};
			case "build-logs":
				return {
					searchPlaceholder: "Search logs...",
					emptyMessage: "Waiting for build logs...",
					noMatchMessage: "No logs match your search",
					loadMoreLabel: "",
					height: "h-full",
				};
		}
	}, [props.variant]);

	return (
		<div
			className={`flex flex-col ${config.height} bg-zinc-100 dark:bg-zinc-950 rounded-lg border`}
		>
			<div className="flex flex-wrap items-center gap-2 p-2 border-b bg-zinc-50 dark:bg-zinc-900">
				<div className="relative flex-1 min-w-50">
					<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
					<Input
						placeholder={config.searchPlaceholder}
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

				{props.variant === "service-logs" && (
					<ServiceLogsFilters
						levels={levels}
						onLevelsChange={setLevels}
						showStdout={showStdout}
						onShowStdoutChange={setShowStdout}
						showStderr={showStderr}
						onShowStderrChange={setShowStderr}
					/>
				)}

				{props.variant === "requests" && (
					<RequestsFilters
						statusFilter={statusFilter}
						onStatusFilterChange={setStatusFilter}
					/>
				)}

				<div className="flex items-center gap-2 ml-auto">
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
				{hasMore && config.loadMoreLabel && (
					<div className="flex justify-center py-2 border-b">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => mutate()}
							className="gap-1 text-muted-foreground"
						>
							<ChevronUp className="size-3" />
							{config.loadMoreLabel}
						</Button>
					</div>
				)}

				{isLoading ? (
					<div className="flex items-center justify-center h-full text-muted-foreground">
						<Spinner className="size-5" />
					</div>
				) : filteredLogs.length === 0 ? (
					<div className="flex items-center justify-center h-full text-muted-foreground">
						{logs.length === 0 ? config.emptyMessage : config.noMatchMessage}
					</div>
				) : (
					<div className="p-4 py-2">
						{filteredLogs.map((entry, idx) => {
							if (props.variant === "service-logs") {
								const e = entry as ServiceLogEntry;
								return (
									<ServiceLogRow
										key={`${e.id}-${idx}`}
										entry={e}
										search={search}
									/>
								);
							}
							if (props.variant === "requests") {
								const e = entry as RequestEntry;
								return (
									<RequestRow
										key={`${e.id}-${idx}`}
										entry={e}
										search={search}
									/>
								);
							}
							const e = entry as BuildLogEntry;
							return (
								<BuildLogRow
									key={`${e.timestamp}-${idx}`}
									entry={e}
									search={search}
								/>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
