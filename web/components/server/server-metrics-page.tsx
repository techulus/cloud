"use client";

import { ChevronDown } from "lucide-react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
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
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
	formatCompactDate,
	formatCompactDateTime,
	formatPreciseDateTime,
} from "@/lib/date";
import { fetcher } from "@/lib/fetcher";
import { METRIC_RANGE_KEYS, type MetricRange } from "@/lib/metric-ranges";
import type {
	MetricsHistory,
	NodeMetricsSnapshot,
} from "@/lib/victoria-metrics";

type ServerMetricsResponse = {
	current: NodeMetricsSnapshot | null;
	history: MetricsHistory;
	range: MetricRange;
	enabled?: boolean;
	available?: boolean;
};

type ChartConfig = {
	title: string;
	key: "cpuUsagePercent" | "memoryUsagePercent" | "diskUsagePercent";
	bytesKey?: "memoryUsedBytes" | "diskUsedBytes";
	color: string;
};

type ChartRow = { timestamp: string; value: number };

type TooltipProps = {
	active?: boolean;
	label?: string | number;
	payload?: ReadonlyArray<{ value?: unknown }>;
};

const RANGE_LABELS: Record<MetricRange, string> = {
	"1h": "Last hour",
	"6h": "Last 6 hours",
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
};

const CHARTS: ChartConfig[] = [
	{ title: "CPU", key: "cpuUsagePercent", color: "#10b981" },
	{
		title: "Memory",
		key: "memoryUsagePercent",
		bytesKey: "memoryUsedBytes",
		color: "#0ea5e9",
	},
	{
		title: "Disk",
		key: "diskUsagePercent",
		bytesKey: "diskUsedBytes",
		color: "#f59e0b",
	},
];

export function ServerMetricsPage({ serverId }: { serverId: string }) {
	const [range, setRange] = useQueryState(
		"range",
		parseAsStringLiteral(METRIC_RANGE_KEYS).withDefault("1h"),
	);
	const { data, error, isLoading } = useSWR<ServerMetricsResponse>(
		`/api/servers/${serverId}/metrics?range=${range}`,
		fetcher,
		{ refreshInterval: 60000, keepPreviousData: true },
	);

	return (
		<div className="space-y-4">
			<div className="flex justify-end">
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="outline"
								className="min-w-44 justify-between whitespace-nowrap"
							/>
						}
					>
						{RANGE_LABELS[range]} <ChevronDown className="size-4" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-44">
						<DropdownMenuRadioGroup
							value={range}
							onValueChange={(value) => setRange(value as MetricRange)}
						>
							{METRIC_RANGE_KEYS.map((value) => (
								<DropdownMenuRadioItem key={value} value={value}>
									{RANGE_LABELS[value]}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<div className="space-y-4">
				{CHARTS.map((chart) => (
					<div key={chart.key} className="h-80 rounded-lg border border-border">
						<ServerMetricPanel
							chart={chart}
							data={data}
							error={error}
							isLoading={isLoading}
							range={range}
						/>
					</div>
				))}
			</div>
		</div>
	);
}

function ServerMetricPanel({
	chart,
	data,
	error,
	isLoading,
	range,
}: {
	chart: ChartConfig;
	data?: ServerMetricsResponse;
	error?: unknown;
	isLoading: boolean;
	range: MetricRange;
}) {
	const points = data?.history[chart.key] ?? [];
	const rows: ChartRow[] = points.map((point) => ({
		timestamp: point.timestamp,
		value: point.value,
	}));
	const latestPercent =
		data?.current?.[chart.key] ?? rows.at(-1)?.value ?? null;
	const bytePoints = chart.bytesKey
		? (data?.history[chart.bytesKey] ?? [])
		: [];
	const latestBytes = chart.bytesKey
		? (data?.current?.[chart.bytesKey] ?? bytePoints.at(-1)?.value ?? null)
		: null;
	const isUnavailable =
		Boolean(error) || data?.enabled === false || data?.available === false;

	return (
		<div className="flex h-full min-h-72 flex-col gap-4 p-4">
			<div className="flex flex-col items-start gap-3">
				<h2 className="text-lg font-semibold">{chart.title}</h2>
				<div className="flex flex-nowrap items-end gap-x-5">
					{isLoading ? (
						<>
							<Skeleton className="h-7 w-24" />
							{chart.bytesKey ? <Skeleton className="h-7 w-20" /> : null}
						</>
					) : (
						<>
							<MetricSummary
								label="Usage"
								value={formatPercent(latestPercent)}
							/>
							{chart.bytesKey ? (
								<MetricSummary label="Used" value={formatBytes(latestBytes)} />
							) : null}
						</>
					)}
				</div>
			</div>

			<div className="min-h-40 min-w-0 flex-1">
				{isLoading ? (
					<Skeleton className="h-full rounded-lg" />
				) : isUnavailable ? (
					<MetricsState message="Server metrics unavailable" />
				) : rows.length === 0 ? (
					<MetricsState
						message={`No ${chart.title.toLowerCase()} metrics in this range`}
					/>
				) : (
					<ResponsiveContainer
						width="100%"
						height="100%"
						minWidth={1}
						minHeight={1}
						initialDimension={{ width: 1, height: 1 }}
					>
						<LineChart
							data={rows}
							margin={{ top: 8, right: 48, left: 0, bottom: 0 }}
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
								className="text-xs"
							/>
							<YAxis
								width={64}
								domain={[0, 100]}
								tickLine={false}
								axisLine={false}
								tickFormatter={(value) => `${value}%`}
								className="text-xs"
							/>
							<Tooltip
								cursor={{ strokeDasharray: "3 3" }}
								content={(props) => (
									<MetricsTooltip {...(props as unknown as TooltipProps)} />
								)}
							/>
							<Line
								type="monotone"
								dataKey="value"
								name={`${chart.title} usage`}
								stroke={chart.color}
								strokeWidth={2}
								dot={false}
								connectNulls
								isAnimationActive={false}
							/>
						</LineChart>
					</ResponsiveContainer>
				)}
			</div>
		</div>
	);
}

function MetricSummary({ label, value }: { label: string; value: string }) {
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
		<div className="flex h-full items-center justify-center rounded-lg border border-border border-dashed text-sm text-muted-foreground">
			{message}
		</div>
	);
}

function MetricsTooltip({ active, payload, label }: TooltipProps) {
	if (!active || !payload?.length) return null;
	const value = Number(payload[0]?.value);

	return (
		<div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
			<p className="mb-1 font-medium">{formatPreciseDateTime(String(label))}</p>
			<p className="font-medium tabular-nums">
				{Number.isFinite(value) ? `${value.toFixed(1)}%` : "-"}
			</p>
		</div>
	);
}

function formatPercent(value: number | null) {
	return value == null ? "-" : `${value.toFixed(1)}%`;
}

function formatBytes(value: number | null) {
	if (value == null) return "-";
	if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(2)} TB`;
	if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
	if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
	return `${Math.round(value / 1024)} KB`;
}
