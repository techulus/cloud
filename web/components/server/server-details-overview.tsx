"use client";

import { type ReactNode, useMemo, useState } from "react";
import {
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import useSWR from "swr";
import { ServerHeader } from "@/components/server/server-header";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Server } from "@/db/types";
import {
	formatCompactDate,
	formatCompactDateTime,
	formatRelativeTime,
	getTimestamp,
} from "@/lib/date";
import { fetcher } from "@/lib/fetcher";
import type { MetricRange } from "@/lib/metric-ranges";
import { cn } from "@/lib/utils";
import type {
	NodeMetricPoint,
	NodeMetricsHistory,
	NodeMetricsSnapshot,
} from "@/lib/victoria-metrics";

type ServerOverview = Pick<
	Server,
	| "id"
	| "name"
	| "status"
	| "isProxy"
	| "publicIp"
	| "privateIp"
	| "wireguardIp"
	| "lastHeartbeat"
	| "resourcesCpu"
	| "resourcesMemory"
	| "resourcesDisk"
	| "meta"
	| "networkHealth"
	| "containerHealth"
	| "agentHealth"
>;

export type ServerMetricMode = "cpu" | "memory" | "disk";

export type ServerMetricsResponse = {
	current: NodeMetricsSnapshot | null;
	history: NodeMetricsHistory;
	range: MetricRange;
	enabled?: boolean;
	available?: boolean;
};

type ClusterHealthResponse = {
	servers: Array<{
		id: string;
		networkHealth: Server["networkHealth"];
		containerHealth: Server["containerHealth"];
		agentHealth: Server["agentHealth"];
	}>;
};

type ChartRow = {
	timestamp: string;
	percent?: number;
	bytes?: number;
};

type TooltipPayload = {
	dataKey?: string;
	name?: string;
	value?: unknown;
};

type ServerMetricsTooltipProps = {
	active?: boolean;
	label?: string | number;
	payload?: readonly TooltipPayload[];
};

const MODE_OPTIONS: Array<{ value: ServerMetricMode; label: string }> = [
	{ value: "cpu", label: "CPU" },
	{ value: "memory", label: "Memory" },
	{ value: "disk", label: "Disk" },
];

const MODE_COLORS: Record<
	ServerMetricMode,
	{ percent: string; bytes: string }
> = {
	cpu: { percent: "var(--chart-1)", bytes: "var(--chart-1)" },
	memory: { percent: "var(--chart-2)", bytes: "var(--chart-4)" },
	disk: { percent: "var(--chart-3)", bytes: "var(--chart-5)" },
};

export function ServerDetailsOverview({
	server,
	initialMetrics,
}: {
	server: ServerOverview;
	initialMetrics: NodeMetricsSnapshot | null;
}) {
	const metricsUrl = `/api/servers/${server.id}/metrics?range=24h`;
	const {
		data: metrics,
		error: metricsError,
		isLoading,
	} = useSWR<ServerMetricsResponse>(metricsUrl, fetcher, {
		refreshInterval: 60000,
	});
	const { data: clusterHealth } = useSWR<ClusterHealthResponse>(
		"/api/cluster-health",
		fetcher,
		{ refreshInterval: 10000 },
	);
	const liveHealth = clusterHealth?.servers.find(
		(item) => item.id === server.id,
	);

	return (
		<Card className="gap-0 border border-border py-0 ring-0">
			<div className="grid items-stretch lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
				<ServerMetricsPanel
					metrics={metrics}
					initialMetrics={initialMetrics}
					error={metricsError}
					isLoading={isLoading}
				/>
				<ServerOverviewPanel
					server={server}
					networkHealth={liveHealth?.networkHealth ?? server.networkHealth}
					containerHealth={
						liveHealth?.containerHealth ?? server.containerHealth
					}
					agentHealth={liveHealth?.agentHealth ?? server.agentHealth}
				/>
			</div>
		</Card>
	);
}

export function ServerMetricsPanel({
	metrics,
	initialMetrics,
	error,
	isLoading,
	fixedMode,
	range = "24h",
}: {
	metrics?: ServerMetricsResponse;
	initialMetrics?: NodeMetricsSnapshot | null;
	error?: unknown;
	isLoading: boolean;
	fixedMode?: ServerMetricMode;
	range?: MetricRange;
}) {
	const [selectedMode, setSelectedMode] = useState<ServerMetricMode>("cpu");
	const mode = fixedMode ?? selectedMode;
	const rows = useMemo(
		() => buildChartRows(metrics?.history, mode),
		[metrics, mode],
	);
	const current = metrics?.current ?? initialMetrics ?? null;
	const isUnavailable =
		Boolean(error) ||
		metrics?.enabled === false ||
		metrics?.available === false;
	const percent = getCurrentPercent(current, mode);
	const bytes = getCurrentBytes(current, mode);
	const showSkeleton = isLoading && !metrics && !current;

	return (
		<div
			className={cn(
				"flex h-full min-h-72 flex-col gap-4 p-4",
				fixedMode && "pb-6",
			)}
		>
			<div
				className={cn(
					"flex flex-col gap-3",
					fixedMode
						? "items-start sm:flex-row sm:justify-between"
						: "sm:flex-row sm:items-start sm:justify-between",
				)}
			>
				{fixedMode ? (
					<h2 className="text-lg font-semibold">
						{MODE_OPTIONS.find((option) => option.value === fixedMode)?.label}
					</h2>
				) : null}
				<div className="min-w-0">
					{showSkeleton ? (
						<div className="flex flex-nowrap items-end gap-x-5">
							<Skeleton className="h-7 w-24" />
							{mode !== "cpu" ? <Skeleton className="h-7 w-20" /> : null}
						</div>
					) : (
						<div className="flex flex-nowrap items-end gap-x-5">
							<MetricSummary
								value={formatPercent(percent)}
								label={fixedMode ? "Usage" : mode.toUpperCase()}
							/>
							{mode !== "cpu" ? (
								<MetricSummary
									value={formatBytes(bytes)}
									label={fixedMode ? "Used" : `${mode} used`}
								/>
							) : null}
						</div>
					)}
				</div>
				{fixedMode ? null : (
					<ServerMetricTabs
						value={mode}
						onChange={setSelectedMode}
						disabled={isLoading || isUnavailable}
					/>
				)}
			</div>

			<div className="min-h-40 min-w-0 flex-1">
				{isLoading && !metrics ? (
					<Skeleton className="h-full rounded-lg" />
				) : isUnavailable ? (
					<MetricsState message="Server metrics unavailable" />
				) : rows.length === 0 ? (
					<MetricsState
						message={
							fixedMode
								? `No ${mode} metrics in this range`
								: "No resource metrics in this range"
						}
					/>
				) : (
					<ResponsiveContainer
						className="tracking-tight"
						width="100%"
						height="100%"
						minWidth={1}
						minHeight={1}
						initialDimension={{ width: 1, height: 1 }}
					>
						<LineChart
							data={rows}
							margin={{
								top: 8,
								right: mode === "cpu" ? 4 : 12,
								left: 0,
								bottom: 0,
							}}
						>
							<CartesianGrid
								strokeDasharray="3 3"
								vertical={false}
								stroke="var(--border)"
							/>
							<XAxis
								dataKey="timestamp"
								minTickGap={32}
								tickLine={false}
								axisLine={false}
								tickFormatter={(value) =>
									range === "7d" || range === "30d"
										? formatCompactDate(value)
										: formatCompactDateTime(value)
								}
								className="text-[10px]"
							/>
							<YAxis
								yAxisId="percent"
								width={48}
								domain={[0, 100]}
								tickLine={false}
								axisLine={false}
								tickFormatter={(value) => `${value}%`}
								className="text-[10px]"
							/>
							{mode !== "cpu" ? (
								<YAxis
									yAxisId="bytes"
									orientation="right"
									width={46}
									tickLine={false}
									axisLine={false}
									tickFormatter={formatBytesCompact}
									className="text-[10px]"
								/>
							) : null}
							<Tooltip
								cursor={{ strokeDasharray: "3 3" }}
								content={(props) => (
									<ServerMetricsTooltip
										{...(props as unknown as ServerMetricsTooltipProps)}
									/>
								)}
							/>
							<Line
								yAxisId="percent"
								type="monotone"
								dataKey="percent"
								name="Usage"
								stroke={MODE_COLORS[mode].percent}
								strokeWidth={2}
								dot={false}
								connectNulls
								isAnimationActive={false}
							/>
							{mode !== "cpu" ? (
								<Line
									yAxisId="bytes"
									type="monotone"
									dataKey="bytes"
									name="Used"
									stroke={MODE_COLORS[mode].bytes}
									strokeWidth={2}
									dot={false}
									connectNulls
									isAnimationActive={false}
								/>
							) : null}
						</LineChart>
					</ResponsiveContainer>
				)}
			</div>

			{rows.length > 0 && !isUnavailable ? (
				<div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
					<LegendMetric
						color={MODE_COLORS[mode].percent}
						label="Usage"
						value={formatPercent(getLatestValue(rows, "percent"))}
					/>
					{mode !== "cpu" ? (
						<LegendMetric
							color={MODE_COLORS[mode].bytes}
							label="Used"
							value={formatBytes(getLatestValue(rows, "bytes"))}
						/>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function LegendMetric({
	color,
	label,
	value,
}: {
	color: string;
	label: string;
	value: string;
}) {
	return (
		<div className="flex items-center gap-2">
			<span
				className="size-2.5 rounded-full"
				style={{ backgroundColor: color }}
			/>
			<span className="text-muted-foreground">{label}</span>
			<span className="font-medium tabular-nums">{value}</span>
		</div>
	);
}

function ServerMetricTabs({
	value,
	onChange,
	disabled,
}: {
	value: ServerMetricMode;
	onChange: (value: ServerMetricMode) => void;
	disabled: boolean;
}) {
	return (
		<div className="flex w-full self-start rounded-md border border-border bg-muted/30 p-0.5 sm:w-auto">
			{MODE_OPTIONS.map((option) => {
				const isSelected = value === option.value;
				return (
					<button
						key={option.value}
						type="button"
						aria-pressed={isSelected}
						disabled={disabled}
						onClick={() => onChange(option.value)}
						className={cn(
							"flex-1 rounded-[5px] px-2 py-0.5 text-xs font-medium transition-colors sm:flex-none",
							isSelected
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
							disabled && "cursor-not-allowed opacity-50",
						)}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

function ServerOverviewPanel({
	server,
	networkHealth,
	containerHealth,
	agentHealth,
}: {
	server: ServerOverview;
	networkHealth: Server["networkHealth"];
	containerHealth: Server["containerHealth"];
	agentHealth: Server["agentHealth"];
}) {
	return (
		<div className="flex min-w-0 flex-col border-border border-t font-mono lg:border-t-0 lg:border-l">
			<div className="space-y-1.5 px-3 py-2.5 text-sm">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-base">
					<div className="font-sans">
						<ServerHeader server={server} />
					</div>
					<span className="text-muted-foreground">
						{server.lastHeartbeat
							? formatRelativeTime(server.lastHeartbeat)
							: "Never seen"}
					</span>
				</div>
				<ConfigRow label="Network">
					{formatHealth(
						networkHealth?.tunnelUp,
						`${networkHealth?.peerCount ?? 0} peers`,
					)}
				</ConfigRow>
				<ConfigRow label="Containers">
					{formatHealth(
						containerHealth?.runtimeResponsive,
						`${containerHealth?.runningContainers ?? 0} running`,
					)}
				</ConfigRow>
				<ConfigRow label="Agent">{agentHealth?.version ?? "Unknown"}</ConfigRow>
			</div>

			<div className="flex-1 divide-y divide-border border-border border-t text-sm">
				<div className="space-y-1.5 px-3 py-2.5">
					<ConfigRow label="Public IP">{server.publicIp || "—"}</ConfigRow>
					<ConfigRow label="Private IP">{server.privateIp || "—"}</ConfigRow>
					<ConfigRow label="WireGuard IP">
						{server.wireguardIp || "—"}
					</ConfigRow>
				</div>
				<div className="space-y-1.5 px-3 py-2.5">
					<ConfigRow label="CPU">
						{server.resourcesCpu !== null
							? `${server.resourcesCpu} cores`
							: "—"}
					</ConfigRow>
					<ConfigRow label="Memory">
						{server.resourcesMemory !== null
							? `${Math.round((server.resourcesMemory / 1024) * 10) / 10} GB`
							: "—"}
					</ConfigRow>
					<ConfigRow label="Disk">
						{server.resourcesDisk !== null ? `${server.resourcesDisk} GB` : "—"}
					</ConfigRow>
				</div>
				{server.meta ? (
					<div className="space-y-1.5 px-3 py-2.5">
						<ConfigRow label="OS / Arch">
							{server.meta.os || "—"} / {server.meta.arch || "—"}
						</ConfigRow>
						<ConfigRow label="Hostname">
							{server.meta.hostname || "—"}
						</ConfigRow>
					</div>
				) : null}
			</div>
		</div>
	);
}

function ConfigRow({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-baseline justify-between gap-4">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 truncate text-right font-medium">
				{children}
			</span>
		</div>
	);
}

function MetricSummary({ value, label }: { value: string; label: string }) {
	return (
		<div className="shrink-0">
			<p className="font-mono text-xl font-semibold tabular-nums tracking-tight">
				{value}
			</p>
			<p className="text-sm text-muted-foreground">{label}</p>
		</div>
	);
}

function MetricsState({ message }: { message: string }) {
	return (
		<div className="flex h-full min-h-40 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
			{message}
		</div>
	);
}

function ServerMetricsTooltip({
	active,
	label,
	payload,
}: ServerMetricsTooltipProps) {
	if (!active || !payload?.length) return null;
	return (
		<div className="min-w-40 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md">
			<p className="mb-2 text-xs text-muted-foreground">
				{formatCompactDateTime(label)}
			</p>
			<div className="space-y-1 text-sm">
				{payload.map((item) => (
					<div
						key={item.dataKey}
						className="flex items-center justify-between gap-5"
					>
						<span className="text-muted-foreground">
							{item.name ?? (item.dataKey === "bytes" ? "Used" : "Usage")}
						</span>
						<span className="font-mono font-medium tabular-nums">
							{item.dataKey === "bytes"
								? formatBytes(Number(item.value))
								: formatPercent(Number(item.value))}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

function buildChartRows(
	history: NodeMetricsHistory | undefined,
	mode: ServerMetricMode,
): ChartRow[] {
	if (!history) return [];
	const percentPoints = history[`${mode}UsagePercent`];
	const bytePoints = mode === "cpu" ? [] : history[`${mode}UsedBytes`];
	const rows = new Map<string, ChartRow>();
	addPoints(rows, percentPoints, "percent");
	addPoints(rows, bytePoints, "bytes");
	return Array.from(rows.values()).sort(
		(a, b) => getTimestamp(a.timestamp, 0) - getTimestamp(b.timestamp, 0),
	);
}

function addPoints(
	rows: Map<string, ChartRow>,
	points: NodeMetricPoint[],
	key: "percent" | "bytes",
) {
	for (const point of points) {
		const row = rows.get(point.timestamp) ?? { timestamp: point.timestamp };
		row[key] = point.value;
		rows.set(point.timestamp, row);
	}
}

function getLatestValue(rows: ChartRow[], key: "percent" | "bytes") {
	for (let i = rows.length - 1; i >= 0; i--) {
		const value = rows[i][key];
		if (value !== undefined && Number.isFinite(value)) return value;
	}
	return null;
}

function getCurrentPercent(
	current: NodeMetricsSnapshot | null,
	mode: ServerMetricMode,
) {
	return current?.[`${mode}UsagePercent`] ?? null;
}

function getCurrentBytes(
	current: NodeMetricsSnapshot | null,
	mode: ServerMetricMode,
) {
	return mode === "cpu" ? null : (current?.[`${mode}UsedBytes`] ?? null);
}

function formatHealth(healthy: boolean | undefined, detail: string) {
	if (healthy === undefined) return "Unknown";
	return healthy ? detail : `${detail} · unavailable`;
}

function formatPercent(value: number | null) {
	return value === null || !Number.isFinite(value)
		? "—"
		: `${value.toFixed(1)}%`;
}

function formatBytes(value: number | null) {
	if (value === null || !Number.isFinite(value)) return "—";
	if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)} TB`;
	if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
	if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
	return `${Math.round(value / 1024)} KB`;
}

function formatBytesCompact(value: number) {
	if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)}T`;
	if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}G`;
	if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)}M`;
	return `${Math.round(value / 1024)}K`;
}
