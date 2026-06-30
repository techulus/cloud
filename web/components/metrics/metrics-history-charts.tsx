"use client";

import { Activity, Cpu, HardDrive, MemoryStick } from "lucide-react";
import { useMemo, useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { fetcher } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import type {
	MetricRange,
	MetricsHistory,
	NodeMetricsSnapshot,
} from "@/lib/victoria-metrics";

const RANGE_OPTIONS: Array<{ value: MetricRange; label: string }> = [
	{ value: "1h", label: "1h" },
	{ value: "6h", label: "6h" },
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7d" },
	{ value: "30d", label: "30d" },
];

type MetricsResponse = {
	current: NodeMetricsSnapshot | null;
	history: MetricsHistory;
	range: MetricRange;
	enabled: boolean;
};

type ChartRow = {
	timestamp: string;
	cpuUsagePercent?: number;
	memoryUsagePercent?: number;
	memoryUsedBytes?: number;
	diskUsagePercent?: number;
	diskUsedBytes?: number;
};

type MetricsHistoryChartsProps = {
	endpoint: string;
	title: string;
	description: string;
	scope: "node" | "cluster";
};

type ChartConfig = {
	title: string;
	description: string;
	icon: typeof Cpu;
	percentKey: keyof ChartRow;
	bytesKey?: keyof ChartRow;
	percentColor: string;
	bytesColor?: string;
};

type TooltipPayload = {
	name?: string;
	value?: unknown;
	color?: string;
	dataKey?: string;
};

type MetricsTooltipProps = {
	active?: boolean;
	label?: string | number;
	payload?: readonly TooltipPayload[];
};

const CHARTS: ChartConfig[] = [
	{
		title: "CPU",
		description: "Usage percent",
		icon: Cpu,
		percentKey: "cpuUsagePercent",
		percentColor: "#10b981",
	},
	{
		title: "Memory",
		description: "Usage percent and used memory",
		icon: MemoryStick,
		percentKey: "memoryUsagePercent",
		bytesKey: "memoryUsedBytes",
		percentColor: "#0ea5e9",
		bytesColor: "#6366f1",
	},
	{
		title: "Disk",
		description: "Usage percent and used storage",
		icon: HardDrive,
		percentKey: "diskUsagePercent",
		bytesKey: "diskUsedBytes",
		percentColor: "#f59e0b",
		bytesColor: "#ec4899",
	},
];

export function MetricsHistoryCharts({
	endpoint,
	title,
	description,
	scope,
}: MetricsHistoryChartsProps) {
	const [range, setRange] = useState<MetricRange>("1h");
	const { data, error, isLoading } = useSWR<MetricsResponse>(
		`${endpoint}?range=${range}`,
		fetcher,
		{ refreshInterval: range === "1h" ? 15000 : 60000 },
	);

	const rows = useMemo(() => buildChartRows(data?.history), [data?.history]);
	const hasData = rows.length > 0;

	return (
		<section className="space-y-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<h2 className="text-lg font-semibold">{title}</h2>
					<p className="text-sm text-muted-foreground">{description}</p>
				</div>
				<NativeSelect
					size="sm"
					value={range}
					onChange={(event) => setRange(event.target.value as MetricRange)}
					aria-label="Metrics range"
				>
					{RANGE_OPTIONS.map((option) => (
						<NativeSelectOption key={option.value} value={option.value}>
							{option.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>

			{data?.enabled === false ? (
				<MetricsStateCard
					icon={Activity}
					title="Metrics disabled"
					description="Set VICTORIA_METRICS_URL or VICTORIA_METRICS_PRIVATE_URL to enable metrics history."
				/>
			) : error ? (
				<MetricsStateCard
					icon={Activity}
					title="Metrics unavailable"
					description="The metrics API could not be reached. Current health data may still be available."
				/>
			) : isLoading ? (
				<MetricsStateCard
					icon={Activity}
					title="Loading metrics"
					description="Fetching recent infrastructure history."
					loading
				/>
			) : !hasData ? (
				<MetricsStateCard
					icon={Activity}
					title="No metrics yet"
					description="Charts will appear once the agent has reported data for this range."
				/>
			) : (
				<div className="grid gap-4 xl:grid-cols-3">
					{CHARTS.map((chart) => (
						<MetricChartCard
							key={chart.title}
							chart={chart}
							current={data?.current ?? null}
							rows={rows}
							scope={scope}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function MetricChartCard({
	chart,
	current,
	rows,
	scope,
}: {
	chart: ChartConfig;
	current: NodeMetricsSnapshot | null;
	rows: ChartRow[];
	scope: "node" | "cluster";
}) {
	const Icon = chart.icon;
	const currentPercent = getSnapshotValue(current, chart.percentKey);
	const currentBytes = chart.bytesKey
		? getSnapshotValue(current, chart.bytesKey)
		: null;

	return (
		<Card>
			<CardHeader className="border-b">
				<div className="flex items-start justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2">
						<div
							className="flex size-8 shrink-0 items-center justify-center rounded-lg"
							style={{
								backgroundColor: `${chart.percentColor}1a`,
								color: chart.percentColor,
							}}
						>
							<Icon className="size-4" />
						</div>
						<div className="min-w-0">
							<CardTitle>{chart.title}</CardTitle>
							<CardDescription>{chart.description}</CardDescription>
						</div>
					</div>
					<MetricBadge value={currentPercent} />
				</div>
			</CardHeader>
			<CardContent className="space-y-3 pt-1">
				<div className="h-56 min-w-0">
					<ResponsiveContainer width="100%" height="100%">
						<AreaChart
							data={rows}
							margin={{
								top: 12,
								right: chart.bytesKey ? 6 : 0,
								left: -18,
								bottom: 0,
							}}
						>
							<CartesianGrid strokeDasharray="3 3" vertical={false} />
							<XAxis
								dataKey="timestamp"
								minTickGap={28}
								tickLine={false}
								axisLine={false}
								tickFormatter={formatShortTime}
								className="text-xs"
							/>
							<YAxis
								yAxisId="percent"
								domain={[0, 100]}
								tickLine={false}
								axisLine={false}
								tickFormatter={(value) => `${value}%`}
								className="text-xs"
							/>
							{chart.bytesKey && (
								<YAxis
									yAxisId="bytes"
									orientation="right"
									tickLine={false}
									axisLine={false}
									tickFormatter={formatBytesCompact}
									className="text-xs"
								/>
							)}
							{thresholdsForChart(chart.title, scope).map((threshold) => (
								<ReferenceLine
									key={threshold.value}
									y={threshold.value}
									yAxisId="percent"
									stroke={threshold.color}
									strokeDasharray="4 4"
									ifOverflow="extendDomain"
								/>
							))}
							<Tooltip
								cursor={{ strokeDasharray: "3 3" }}
								content={(props) => (
									<MetricsTooltip
										{...(props as unknown as MetricsTooltipProps)}
									/>
								)}
							/>
							<Area
								yAxisId="percent"
								type="monotone"
								dataKey={chart.percentKey}
								name={`${chart.title} %`}
								stroke={chart.percentColor}
								fill={chart.percentColor}
								fillOpacity={0.14}
								strokeWidth={2}
								connectNulls
								isAnimationActive={false}
							/>
							{chart.bytesKey && (
								<Area
									yAxisId="bytes"
									type="monotone"
									dataKey={chart.bytesKey}
									name={`${chart.title} used`}
									stroke={chart.bytesColor}
									fill={chart.bytesColor}
									fillOpacity={0.08}
									strokeWidth={1.5}
									connectNulls
									isAnimationActive={false}
								/>
							)}
						</AreaChart>
					</ResponsiveContainer>
				</div>
				{currentBytes !== null && (
					<p className="text-xs text-muted-foreground">
						Current used:{" "}
						<span className="font-medium text-foreground tabular-nums">
							{formatBytes(currentBytes)}
						</span>
					</p>
				)}
			</CardContent>
		</Card>
	);
}

function MetricsStateCard({
	icon: Icon,
	title,
	description,
	loading = false,
}: {
	icon: typeof Activity;
	title: string;
	description: string;
	loading?: boolean;
}) {
	return (
		<Card>
			<CardContent className="flex items-center gap-3 py-6">
				<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
					{loading ? (
						<Spinner className="size-4" />
					) : (
						<Icon className="size-4" />
					)}
				</div>
				<div>
					<p className="font-medium">{title}</p>
					<p className="text-sm text-muted-foreground">{description}</p>
				</div>
			</CardContent>
		</Card>
	);
}

function MetricBadge({ value }: { value: number | null }) {
	if (value === null) {
		return <Badge variant="outline">No data</Badge>;
	}

	return (
		<Badge
			variant="outline"
			className={cn(
				value >= 90
					? "border-rose-500/35 bg-rose-500/10 text-rose-600 dark:text-rose-400"
					: value >= 70
						? "border-amber-500/35 bg-amber-500/10 text-amber-600 dark:text-amber-400"
						: "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
			)}
		>
			{value.toFixed(1)}%
		</Badge>
	);
}

function MetricsTooltip({ active, payload, label }: MetricsTooltipProps) {
	if (!active || !payload?.length) return null;

	return (
		<div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
			<p className="mb-1 font-medium">{formatTooltipTime(String(label))}</p>
			<div className="space-y-1">
				{payload.map((item) => (
					<div
						key={`${item.dataKey}-${item.name}`}
						className="flex items-center justify-between gap-5"
					>
						<span className="flex items-center gap-1.5 text-muted-foreground">
							<span
								className="size-2 rounded-full"
								style={{ backgroundColor: item.color }}
							/>
							{item.name}
						</span>
						<span className="font-medium tabular-nums">
							{formatTooltipValue(item)}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

function buildChartRows(history?: MetricsHistory): ChartRow[] {
	if (!history) return [];

	const rows = new Map<string, ChartRow>();
	for (const [key, points] of Object.entries(history) as Array<
		[keyof MetricsHistory, MetricsHistory[keyof MetricsHistory]]
	>) {
		for (const point of points) {
			const row = rows.get(point.timestamp) ?? { timestamp: point.timestamp };
			row[key] = point.value;
			rows.set(point.timestamp, row);
		}
	}

	return Array.from(rows.values()).sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
	);
}

function getSnapshotValue(
	snapshot: NodeMetricsSnapshot | null,
	key: keyof ChartRow,
) {
	if (!snapshot || key === "timestamp") return null;
	const value = snapshot[key as keyof NodeMetricsSnapshot];
	return typeof value === "number" ? value : null;
}

function thresholdsForChart(title: string, scope: "node" | "cluster") {
	if (scope === "cluster" && title === "CPU") {
		return [{ value: 80, color: "#f59e0b" }];
	}
	return [
		{ value: 70, color: "#f59e0b" },
		{ value: 90, color: "#f43f5e" },
	];
}

function formatTooltipValue(item: TooltipPayload) {
	const value = Number(item.value);
	if (!Number.isFinite(value)) return "—";
	if (String(item.dataKey).endsWith("Bytes")) return formatBytes(value);
	return `${value.toFixed(1)}%`;
}

function formatShortTime(value: string) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(value));
}

function formatTooltipTime(value: string) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	}).format(new Date(value));
}

function formatBytesCompact(value: number) {
	if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)}T`;
	if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}G`;
	if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)}M`;
	return `${Math.round(value / 1024)}K`;
}

function formatBytes(value: number) {
	if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)} TB`;
	if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
	if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
	return `${Math.round(value / 1024)} KB`;
}
