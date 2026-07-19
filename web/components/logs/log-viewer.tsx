"use client";

import {
	ArrowDownToLine,
	ChevronDown,
	ChevronUp,
	Search,
	X,
} from "lucide-react";
import {
	parseAsArrayOf,
	parseAsBoolean,
	parseAsStringLiteral,
	useQueryState,
} from "nuqs";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { formatPreciseDateTime, formatTime } from "@/lib/date";
import { fetcher } from "@/lib/fetcher";
import {
	DEFAULT_LOG_TIME_RANGE,
	LOG_TIME_RANGES,
	type LogTimeRange,
	MAX_LOG_SEARCH_LENGTH,
	splitLogSearchMatches,
} from "@/lib/log-query";

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

interface ServerLogEntry extends BaseEntry {
	id: string;
	message: string;
	level: string;
}

type Server = { id: string; name: string };

const STATUS_OPTIONS: {
	value: StatusCategory;
	label: string;
	color: string;
}[] = [
	{ value: "2xx", label: "2xx Success", color: "bg-green-500" },
	{ value: "3xx", label: "3xx Redirect", color: "bg-blue-500" },
	{ value: "4xx", label: "4xx Client Error", color: "bg-yellow-500" },
	{ value: "5xx", label: "5xx Server Error", color: "bg-red-500" },
];

const SERVER_LOG_LEVEL_COLORS: Record<string, string> = {
	error: "text-red-500 bg-red-500/10",
	warn: "text-yellow-500 bg-yellow-500/10",
	info: "text-blue-500 bg-blue-500/10",
};

const EMPTY_LOGS: unknown[] = [];

const LOG_TIME_RANGE_LABELS: Record<LogTimeRange, string> = {
	"1h": "Last hour",
	"6h": "Last 6 hours",
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
};

type LogViewerProps =
	| { variant: "service-logs"; serviceId: string; servers?: Server[] }
	| { variant: "requests"; serviceId: string }
	| { variant: "build-logs"; buildId: string; isLive: boolean }
	| { variant: "server-logs"; serverId: string }
	| { variant: "rollout-logs"; rolloutId: string; isLive: boolean };

const LEVEL_COLORS: Record<LogLevel, string> = {
	error: "text-red-500 bg-red-500/10",
	warn: "text-yellow-500 bg-yellow-500/10",
	info: "text-blue-500 bg-blue-500/10",
	debug: "text-slate-500 bg-slate-500/10",
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
	const parts = splitLogSearchMatches(text, search);
	let offset = 0;

	return parts.map(({ text: part, isMatch }) => {
		const start = offset;
		offset += part.length;

		return isMatch ? (
			<mark
				key={`${part}-${start}`}
				className="bg-yellow-300 dark:bg-yellow-700 text-inherit rounded-sm px-0.5"
			>
				{part}
			</mark>
		) : (
			part
		);
	});
}

type LogDataResponse = { logs: unknown[]; hasMore?: boolean };

type LogEndpointOptions = {
	search: string;
	range: LogTimeRange;
	filterServerId?: string;
	before?: string;
};

function supportsTimeRange(variant: LogViewerProps["variant"]): boolean {
	return (
		variant === "service-logs" ||
		variant === "requests" ||
		variant === "server-logs"
	);
}

function buildLogEndpoint(
	props: LogViewerProps,
	{ search, range, filterServerId, before }: LogEndpointOptions,
): string {
	const params = new URLSearchParams();
	if (search) params.set("q", search);
	if (supportsTimeRange(props.variant)) params.set("range", range);
	if (before) params.set("before", before);

	let path: string;
	switch (props.variant) {
		case "service-logs":
			path = `/api/services/${props.serviceId}/logs`;
			params.set("limit", "500");
			params.set("type", "container");
			if (filterServerId) params.set("serverId", filterServerId);
			break;
		case "requests":
			path = `/api/services/${props.serviceId}/requests`;
			params.set("limit", "500");
			break;
		case "build-logs":
			path = `/api/builds/${props.buildId}/logs`;
			break;
		case "server-logs":
			path = `/api/servers/${props.serverId}/logs`;
			params.set("limit", "500");
			break;
		case "rollout-logs":
			path = `/api/rollouts/${props.rolloutId}/logs`;
			break;
	}

	const query = params.toString();
	return query ? `${path}?${query}` : path;
}

function useDebouncedValue(value: string, delay: number): string {
	const [debouncedValue, setDebouncedValue] = useState(value);

	useEffect(() => {
		if (!value) {
			setDebouncedValue("");
			return;
		}

		const timeout = window.setTimeout(() => setDebouncedValue(value), delay);
		return () => window.clearTimeout(timeout);
	}, [value, delay]);

	return debouncedValue;
}

function TimeRangeFilter({
	range,
	onRangeChange,
}: {
	range: LogTimeRange;
	onRangeChange: (range: LogTimeRange) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="inline-flex items-center justify-center gap-1 h-7 px-2.5 text-[0.8rem] font-medium rounded-[min(var(--radius-md),12px)] border border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50">
				{LOG_TIME_RANGE_LABELS[range]}
				<ChevronDown className="size-3" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-40">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Time range</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuRadioGroup
					aria-label="Time range"
					value={range}
					onValueChange={(value) => onRangeChange(value as LogTimeRange)}
				>
					{LOG_TIME_RANGES.map((option) => (
						<DropdownMenuRadioItem key={option} value={option} closeOnClick>
							{LOG_TIME_RANGE_LABELS[option]}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
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
														: "bg-slate-500"
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

function ServerLogFilters({
	levels,
	onLevelsChange,
}: {
	levels: Set<LogLevel>;
	onLevelsChange: (levels: Set<LogLevel>) => void;
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
		if (levels.size === 3) return "All levels";
		if (levels.size === 0) return "No levels";
		return Array.from(levels).join(", ");
	}, [levels]);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="inline-flex items-center justify-center gap-1 h-7 px-2.5 text-[0.8rem] font-medium rounded-[min(var(--radius-md),12px)] border border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50">
				{levelLabel}
				<ChevronDown className="size-3" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Log Levels</DropdownMenuLabel>
					<DropdownMenuSeparator />
					{(["error", "warn", "info"] as LogLevel[]).map((level) => (
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
												: "bg-blue-500"
									}`}
								/>
								{level.charAt(0).toUpperCase() + level.slice(1)}
							</span>
						</DropdownMenuCheckboxItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuCheckboxItem
						checked={levels.size === 3}
						onCheckedChange={() =>
							onLevelsChange(
								levels.size === 3
									? new Set()
									: new Set(["error", "warn", "info"]),
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
					{STATUS_OPTIONS.map((opt) => (
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

function ServerFilter({
	servers,
	selectedServerId,
	onServerChange,
}: {
	servers: Server[];
	selectedServerId: string | null;
	onServerChange: (serverId: string | null) => void;
}) {
	const selectedServer = servers.find((s) => s.id === selectedServerId);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="inline-flex items-center justify-center gap-1 h-7 px-2.5 text-[0.8rem] font-medium rounded-[min(var(--radius-md),12px)] border border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50">
				{selectedServer ? selectedServer.name : "All servers"}
				<ChevronDown className="size-3" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Filter by Server</DropdownMenuLabel>
					<DropdownMenuSeparator />
					<DropdownMenuCheckboxItem
						checked={selectedServerId === null}
						onCheckedChange={() => onServerChange(null)}
					>
						All servers
					</DropdownMenuCheckboxItem>
					<DropdownMenuSeparator />
					{servers.map((server) => (
						<DropdownMenuCheckboxItem
							key={server.id}
							checked={selectedServerId === server.id}
							onCheckedChange={() => onServerChange(server.id)}
						>
							{server.name}
						</DropdownMenuCheckboxItem>
					))}
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
		<div className="flex flex-col sm:flex-row hover:bg-black/5 dark:hover:bg-white/5 -mx-2 px-2 py-1 sm:py-0.5 group">
			<div className="flex items-baseline sm:contents">
				<span
					className="shrink-0 w-[70px] text-slate-400 dark:text-slate-600 select-none pr-2 tabular-nums"
					title={formatPreciseDateTime(entry.timestamp)}
				>
					{formatTime(entry.timestamp)}
				</span>
				{level && (
					<span
						className={`shrink-0 w-[50px] text-center px-1.5 rounded text-[10px] font-medium uppercase mr-2 ${LEVEL_COLORS[level]}`}
					>
						{level}
					</span>
				)}
				<span
					className={`shrink-0 w-[50px] text-center px-1 rounded text-[10px] mr-2 ${
						entry.stream === "stderr"
							? "text-red-600 dark:text-red-400 bg-red-500/10"
							: "text-slate-600 dark:text-slate-400 bg-slate-500/10"
					}`}
				>
					{entry.stream}
				</span>
			</div>
			<span
				className={`break-all whitespace-pre-wrap ${
					entry.stream === "stderr"
						? "text-red-600 dark:text-red-400"
						: "text-slate-800 dark:text-slate-200"
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
		<div className="flex flex-wrap sm:flex-nowrap hover:bg-black/5 dark:hover:bg-white/5 -mx-2 px-2 py-1 sm:py-0.5 group">
			<span
				className="shrink-0 w-[70px] text-slate-400 dark:text-slate-600 select-none pr-2 tabular-nums"
				title={formatPreciseDateTime(entry.timestamp)}
			>
				{formatTime(entry.timestamp)}
			</span>
			<span
				className={`shrink-0 w-[40px] text-center px-1.5 rounded text-[10px] font-medium mr-2 tabular-nums ${STATUS_COLORS[category]}`}
			>
				{entry.status}
			</span>
			<span className="shrink-0 w-[50px] text-slate-500 dark:text-slate-400 font-medium">
				{entry.method}
			</span>
			<span className="order-last basis-full sm:order-none sm:basis-auto sm:flex-1 break-all whitespace-pre-wrap text-slate-800 dark:text-slate-200">
				{highlightMatches(entry.path, search)}
			</span>
			<span className="shrink-0 w-[60px] text-right ml-auto sm:ml-2 text-slate-400 dark:text-slate-500 tabular-nums">
				{Math.round(Number(entry.duration) || 0)}ms
			</span>
			<span className="shrink-0 ml-2 text-slate-400 dark:text-slate-500 tabular-nums hidden group-hover:inline">
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
		<div className="flex flex-col sm:flex-row hover:bg-black/5 dark:hover:bg-white/5 -mx-2 px-2 py-1 sm:py-0.5">
			<span
				className="shrink-0 w-[70px] text-slate-400 dark:text-slate-600 select-none pr-2 tabular-nums"
				title={formatPreciseDateTime(entry.timestamp)}
			>
				{formatTime(entry.timestamp)}
			</span>
			<span className="text-slate-800 dark:text-slate-200 break-all whitespace-pre-wrap">
				{highlightMatches(entry.message, search)}
			</span>
		</div>
	);
}

function ServerLogRow({
	entry,
	search,
}: {
	entry: ServerLogEntry;
	search: string;
}) {
	return (
		<div className="flex flex-col sm:flex-row hover:bg-black/5 dark:hover:bg-white/5 -mx-2 px-2 py-1 sm:py-0.5">
			<div className="flex items-baseline sm:contents">
				<span
					className="shrink-0 w-[70px] text-slate-400 dark:text-slate-600 select-none pr-2 tabular-nums"
					title={formatPreciseDateTime(entry.timestamp)}
				>
					{formatTime(entry.timestamp)}
				</span>
				<span
					className={`shrink-0 w-[50px] text-center px-1.5 rounded text-[10px] font-medium uppercase mr-2 ${SERVER_LOG_LEVEL_COLORS[entry.level] || SERVER_LOG_LEVEL_COLORS.info}`}
				>
					{entry.level}
				</span>
			</div>
			<span className="text-slate-800 dark:text-slate-200 break-all whitespace-pre-wrap">
				{highlightMatches(entry.message, search)}
			</span>
		</div>
	);
}

const logLevelParser = parseAsArrayOf(
	parseAsStringLiteral(["error", "warn", "info", "debug"] as const),
);
const statusParser = parseAsArrayOf(
	parseAsStringLiteral(["2xx", "3xx", "4xx", "5xx"] as const),
);
const rangeParser = parseAsStringLiteral(LOG_TIME_RANGES);

export function LogViewer(props: LogViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const scrollRestorationRef = useRef<{
		scrollTop: number;
		scrollHeight: number;
	} | null>(null);
	const paginationAbortRef = useRef<AbortController | null>(null);
	const [search, setSearch] = useQueryState("q", { defaultValue: "" });
	const debouncedSearch = useDebouncedValue(search, 300).trim();
	const [range, setRange] = useQueryState(
		"range",
		rangeParser.withDefault(DEFAULT_LOG_TIME_RANGE),
	);
	const [autoScroll, setAutoScroll] = useState(true);
	const [selectedServerId, setSelectedServerId] = useQueryState("server");

	const defaultLevels =
		props.variant === "server-logs"
			? (["error", "warn", "info"] as const)
			: (["error", "warn", "info", "debug"] as const);

	const [levelsParam, setLevelsParam] = useQueryState(
		"levels",
		logLevelParser.withDefault([...defaultLevels]),
	);
	const levels = useMemo(
		() => new Set(levelsParam as LogLevel[]),
		[levelsParam],
	);
	const setLevels = (newLevels: Set<LogLevel>) =>
		setLevelsParam(Array.from(newLevels) as typeof levelsParam);

	const [showStdout, setShowStdout] = useQueryState(
		"stdout",
		parseAsBoolean.withDefault(true),
	);
	const [showStderr, setShowStderr] = useQueryState(
		"stderr",
		parseAsBoolean.withDefault(true),
	);

	const [statusParam, setStatusParam] = useQueryState(
		"status",
		statusParser.withDefault(["2xx", "3xx", "4xx", "5xx"]),
	);
	const statusFilter = useMemo(
		() => new Set(statusParam as StatusCategory[]),
		[statusParam],
	);
	const setStatusFilter = (newStatus: Set<StatusCategory>) =>
		setStatusParam(Array.from(newStatus) as typeof statusParam);

	const servers = props.variant === "service-logs" ? props.servers : undefined;
	const logEndpointOptions: LogEndpointOptions = {
		search: debouncedSearch,
		range,
		filterServerId: selectedServerId ?? undefined,
	};
	const paginationKey = buildLogEndpoint(props, logEndpointOptions);
	let pollingInterval = 2000;
	if (props.variant === "build-logs" || props.variant === "rollout-logs") {
		pollingInterval = props.isLive ? 2000 : 0;
	} else if (props.variant === "server-logs") {
		pollingInterval = 5000;
	}
	const [olderState, setOlderState] = useState<{
		key: string;
		logs: unknown[];
		hasMore: boolean;
	}>({ key: "", logs: [], hasMore: true });
	const [loadingOlderKey, setLoadingOlderKey] = useState<string | null>(null);
	const olderLogs =
		olderState.key === paginationKey ? olderState.logs : EMPTY_LOGS;
	const olderHasMore =
		olderState.key === paginationKey ? olderState.hasMore : true;
	const isLoadingOlder = loadingOlderKey === paginationKey;

	useEffect(() => {
		void paginationKey;
		paginationAbortRef.current?.abort();
		paginationAbortRef.current = null;
		scrollRestorationRef.current = null;
		setLoadingOlderKey(null);

		return () => paginationAbortRef.current?.abort();
	}, [paginationKey]);

	const { data, error, isLoading, mutate } = useSWR<LogDataResponse>(
		paginationKey,
		fetcher,
		{
			keepPreviousData: true,
			refreshInterval: pollingInterval,
		},
	);
	const hasResolvedData = data !== undefined;
	useEffect(() => {
		if (error && hasResolvedData) {
			toast.error(
				error instanceof Error ? error.message : "Failed to refresh logs",
				{ id: `logs-refresh-${paginationKey}` },
			);
		}
	}, [error, hasResolvedData, paginationKey]);

	const recentLogs = (data?.logs as unknown[] | undefined) || EMPTY_LOGS;
	const logs = useMemo(() => {
		const seenIds = new Set<string>();
		const combined: unknown[] = [];

		for (const log of olderLogs) {
			const entry = log as { id?: string; timestamp?: string };
			const id = entry.id || entry.timestamp || "";
			if (!seenIds.has(id)) {
				seenIds.add(id);
				combined.push(log);
			}
		}

		for (const log of recentLogs) {
			const entry = log as { id?: string; timestamp?: string };
			const id = entry.id || entry.timestamp || "";
			if (!seenIds.has(id)) {
				seenIds.add(id);
				combined.push(log);
			}
		}

		return combined.sort((a, b) => {
			const aEntry = a as { id?: string; timestamp?: string };
			const bEntry = b as { id?: string; timestamp?: string };
			const timeCompare = (aEntry.timestamp || "").localeCompare(
				bEntry.timestamp || "",
			);
			if (timeCompare !== 0) return timeCompare;
			return (aEntry.id || "").localeCompare(bEntry.id || "");
		});
	}, [olderLogs, recentLogs]);
	const hasMore =
		olderLogs.length === 0 ? data?.hasMore || false : olderHasMore;

	const loadOlderLogs = async () => {
		if (isLoadingOlder || isLoading || !hasMore) return;

		const oldestLog = logs[0] as { timestamp?: string } | undefined;
		if (!oldestLog?.timestamp) return;

		const container = containerRef.current;
		if (container) {
			scrollRestorationRef.current = {
				scrollTop: container.scrollTop,
				scrollHeight: container.scrollHeight,
			};
		}

		const requestKey = paginationKey;
		const controller = new AbortController();
		paginationAbortRef.current?.abort();
		paginationAbortRef.current = controller;
		setLoadingOlderKey(requestKey);
		try {
			const cursor = oldestLog.timestamp;
			const endpoint = buildLogEndpoint(props, {
				...logEndpointOptions,
				before: cursor,
			});
			const response = await fetch(endpoint, {
				cache: "no-store",
				signal: controller.signal,
			});
			const result = (await response.json()) as LogDataResponse & {
				message?: string;
			};
			if (paginationAbortRef.current !== controller) return;
			if (!response.ok) {
				throw new Error(result.message || "Failed to load older logs");
			}

			if (result.logs && result.logs.length > 0) {
				setOlderState((current) => ({
					key: requestKey,
					logs: [
						...result.logs,
						...(current.key === requestKey ? current.logs : []),
					],
					hasMore: result.hasMore || false,
				}));
			} else {
				setOlderState((current) => ({
					key: requestKey,
					logs: current.key === requestKey ? current.logs : [],
					hasMore: false,
				}));
				scrollRestorationRef.current = null;
			}
		} catch (error) {
			if (paginationAbortRef.current !== controller) return;
			scrollRestorationRef.current = null;
			if (!(error instanceof DOMException && error.name === "AbortError")) {
				console.error("Failed to load older logs:", error);
				toast.error(
					error instanceof Error ? error.message : "Failed to load older logs",
				);
			}
		} finally {
			if (paginationAbortRef.current === controller) {
				paginationAbortRef.current = null;
				setLoadingOlderKey(null);
			}
		}
	};

	const filteredLogs = useMemo(() => {
		return logs.filter((log) => {
			if (props.variant === "service-logs") {
				const entry = log as ServiceLogEntry;
				if (entry.stream === "stdout" && !showStdout) return false;
				if (entry.stream === "stderr" && !showStderr) return false;

				const level = detectLevel(entry.message);
				if (level && !levels.has(level)) return false;
			} else if (props.variant === "requests") {
				const entry = log as RequestEntry;
				const category = getStatusCategory(entry.status);
				if (!statusFilter.has(category)) return false;
			} else if (props.variant === "server-logs") {
				const entry = log as ServerLogEntry;
				if (!levels.has(entry.level as LogLevel)) return false;
			}

			return true;
		});
	}, [logs, props.variant, levels, showStdout, showStderr, statusFilter]);
	const logCount = logs.length;
	const filteredLogCount = filteredLogs.length;
	const newestFilteredLogTimestamp = (
		filteredLogs.at(-1) as BaseEntry | undefined
	)?.timestamp;

	useLayoutEffect(() => {
		void logCount;
		void filteredLogCount;
		void newestFilteredLogTimestamp;
		const container = containerRef.current;
		const restoration = scrollRestorationRef.current;

		if (restoration && container) {
			const scrollHeightAfter = container.scrollHeight;
			container.scrollTop =
				restoration.scrollTop + (scrollHeightAfter - restoration.scrollHeight);
			scrollRestorationRef.current = null;
		} else if (autoScroll && container) {
			container.scrollTop = container.scrollHeight;
		}
	}, [logCount, filteredLogCount, newestFilteredLogTimestamp, autoScroll]);

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
					height: "h-[84vh]",
				};
			case "server-logs":
				return {
					searchPlaceholder: "Search logs...",
					emptyMessage: "No agent logs available",
					noMatchMessage: "No logs match filters",
					loadMoreLabel: "Load older logs",
					height: "h-[84vh]",
				};
			case "rollout-logs":
				return {
					searchPlaceholder: "Search logs...",
					emptyMessage: "Waiting for rollout logs...",
					noMatchMessage: "No logs match your search",
					loadMoreLabel: "",
					height: "h-[84vh]",
				};
		}
	}, [props.variant]);

	return (
		<div className={`flex flex-col ${config.height} rounded-md border`}>
			<div className="flex flex-wrap items-center gap-2 p-2 border-b rounded-t-md">
				<div className="relative flex-1 min-w-50">
					<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
					<Input
						placeholder={config.searchPlaceholder}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						maxLength={MAX_LOG_SEARCH_LENGTH}
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

				{props.variant === "server-logs" && (
					<ServerLogFilters levels={levels} onLevelsChange={setLevels} />
				)}

				{supportsTimeRange(props.variant) && (
					<TimeRangeFilter
						range={range}
						onRangeChange={(nextRange) => void setRange(nextRange)}
					/>
				)}

				{servers && servers.length > 1 && (
					<ServerFilter
						servers={servers}
						selectedServerId={selectedServerId}
						onServerChange={setSelectedServerId}
					/>
				)}

				<div className="flex items-center gap-2 ml-auto">
					<Button
						variant={autoScroll ? "default" : "outline"}
						size="icon-sm"
						onClick={() => setAutoScroll((current) => !current)}
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
							onClick={loadOlderLogs}
							disabled={isLoadingOlder || isLoading}
							className="gap-1 text-muted-foreground"
						>
							{isLoadingOlder ? (
								<Spinner className="size-3" />
							) : (
								<ChevronUp className="size-3" />
							)}
							{isLoadingOlder ? "Loading..." : config.loadMoreLabel}
						</Button>
					</div>
				)}

				{error && logs.length === 0 ? (
					<Empty className="h-full">
						<EmptyTitle>Unable to load logs</EmptyTitle>
						<EmptyContent>
							<Button variant="outline" size="sm" onClick={() => void mutate()}>
								Try again
							</Button>
						</EmptyContent>
					</Empty>
				) : isLoading && logs.length === 0 ? (
					<div className="flex items-center justify-center h-full text-muted-foreground">
						<Spinner className="size-5" />
					</div>
				) : filteredLogs.length === 0 ? (
					<Empty className="h-full">
						<EmptyTitle>
							{debouncedSearch.trim() || logs.length > 0
								? config.noMatchMessage
								: config.emptyMessage}
						</EmptyTitle>
					</Empty>
				) : (
					<div className="p-4 py-2">
						{filteredLogs.map((entry) => {
							if (props.variant === "service-logs") {
								const e = entry as ServiceLogEntry;
								return (
									<ServiceLogRow
										key={e.id}
										entry={e}
										search={debouncedSearch}
									/>
								);
							}
							if (props.variant === "requests") {
								const e = entry as RequestEntry;
								return (
									<RequestRow key={e.id} entry={e} search={debouncedSearch} />
								);
							}
							if (props.variant === "server-logs") {
								const e = entry as ServerLogEntry;
								return (
									<ServerLogRow key={e.id} entry={e} search={debouncedSearch} />
								);
							}
							if (props.variant === "rollout-logs") {
								const e = entry as BuildLogEntry;
								return (
									<BuildLogRow
										key={e.timestamp}
										entry={e}
										search={debouncedSearch}
									/>
								);
							}
							const e = entry as BuildLogEntry;
							return (
								<BuildLogRow
									key={e.timestamp}
									entry={e}
									search={debouncedSearch}
								/>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
