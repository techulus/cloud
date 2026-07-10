"use client";

import { Activity, Cpu, HardDrive, MemoryStick } from "lucide-react";
import { useMemo, useState } from "react";
import {
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import useSWR from "swr";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
	formatCompactDateTime,
	formatPreciseDateTime,
	getTimestamp,
} from "@/lib/date";
import { fetcher } from "@/lib/fetcher";
import { METRIC_RANGE_KEYS, type MetricRange } from "@/lib/metric-ranges";
import type {
	MetricsHistory,
	ServerMetricsHistory,
} from "@/lib/victoria-metrics";

type MetricsResponse = {
	range: MetricRange;
	series: ServerMetricsHistory[];
};

type ChartRow = {
	timestamp: string;
} & Record<string, number | string | undefined>;

type MetricsHistoryChartsProps = {
	endpoint: string;
	title: string;
	description: string;
	servers: Array<{ id: string; name: string }>;
};

type ChartConfig = {
	title: string;
	description: string;
	icon: typeof Cpu;
	percentKey: keyof MetricsHistory;
	bytesKey?: keyof MetricsHistory;
	percentColor: string;
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
		description: "Usage percent by server",
		icon: Cpu,
		percentKey: "cpuUsagePercent",
		percentColor: "#10b981",
	},
	{
		title: "Memory",
		description: "Usage percent and used memory by server",
		icon: MemoryStick,
		percentKey: "memoryUsagePercent",
		bytesKey: "memoryUsedBytes",
		percentColor: "#0ea5e9",
	},
	{
		title: "Disk",
		description: "Usage percent and used storage by server",
		icon: HardDrive,
		percentKey: "diskUsagePercent",
		bytesKey: "diskUsedBytes",
		percentColor: "#f59e0b",
	},
];

const CHART_THRESHOLDS = [
	{ value: 70, color: "#f59e0b" },
	{ value: 90, color: "#f43f5e" },
];

const SERVER_COLORS = [
	"#10b981",
	"#0ea5e9",
	"#f59e0b",
	"#ec4899",
	"#8b5cf6",
	"#14b8a6",
	"#f43f5e",
	"#84cc16",
];

export function MetricsHistoryCharts({
	endpoint,
	title,
	description,
	servers,
}: MetricsHistoryChartsProps) {
	const [range, setRange] = useState<MetricRange>("1h");
	const [selectedServerId, setSelectedServerId] = useState("all");
	const requestUrl = useMemo(() => {
		const params = new URLSearchParams({ range });
		if (selectedServerId !== "all") {
			params.set("serverId", selectedServerId);
		}
		return `${endpoint}?${params.toString()}`;
	}, [endpoint, range, selectedServerId]);
	const { data, error, isLoading } = useSWR<MetricsResponse>(
		requestUrl,
		fetcher,
		{ refreshInterval: 60000 },
	);

	const series = data?.series ?? [];
	const rows = useMemo(() => buildChartRows(series), [series]);
	const hasData = series.some((server) =>
		Object.values(server.history).some((points) => points.length > 0),
	);

	return (
		<section className="space-y-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<h2 className="text-lg font-semibold">{title}</h2>
					<p className="text-sm text-muted-foreground">{description}</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<NativeSelect
						size="sm"
						value={selectedServerId}
						onChange={(event) => setSelectedServerId(event.target.value)}
						aria-label="Server"
					>
						<NativeSelectOption value="all">All</NativeSelectOption>
						{servers.map((server) => (
							<NativeSelectOption key={server.id} value={server.id}>
								{server.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<NativeSelect
						size="sm"
						value={range}
						onChange={(event) => setRange(event.target.value as MetricRange)}
						aria-label="Metrics range"
					>
						{METRIC_RANGE_KEYS.map((option) => (
							<NativeSelectOption key={option} value={option}>
								{option}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
			</div>

			{error ? (
				<MetricsStateCard
					icon={Activity}
					title="Metrics unavailable"
					description="The metrics API could not be reached. Current health data may still be available."
				/>
			) : isLoading ? (
				<MetricsChartsSkeleton />
			) : !hasData ? (
				<MetricsStateCard
					icon={Activity}
					title="No metrics yet"
					description="Charts will appear once the agent has reported data for this range."
				/>
			) : (
				<div className="grid gap-4">
					{CHARTS.map((chart) => (
						<MetricChartCard
							key={chart.title}
							chart={chart}
							rows={rows}
							series={series}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function MetricChartCard({
	chart,
	rows,
	series,
}: {
	chart: ChartConfig;
	rows: ChartRow[];
	series: ServerMetricsHistory[];
}) {
	const Icon = chart.icon;

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
				</div>
			</CardHeader>
			<CardContent className="space-y-3 pt-1">
				<div className="h-72 min-w-0 lg:h-80">
					<ResponsiveContainer
						width="100%"
						height="100%"
						minWidth={1}
						minHeight={1}
						initialDimension={{ width: 1, height: 1 }}
					>
						<LineChart
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
								tickFormatter={(value) => formatCompactDateTime(value)}
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
							<Legend
								verticalAlign="top"
								align="right"
								iconType="plainline"
								wrapperStyle={{ paddingBottom: 12 }}
							/>
							{CHART_THRESHOLDS.map((threshold) => (
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
							{series.map((server, index) => (
								<Line
									key={getSeriesKey(chart.percentKey, server.serverId)}
									yAxisId="percent"
									type="monotone"
									dataKey={getSeriesKey(chart.percentKey, server.serverId)}
									name={`${server.serverName} %`}
									stroke={getServerColor(index)}
									strokeWidth={2}
									dot={false}
									connectNulls
									isAnimationActive={false}
								/>
							))}
							{chart.bytesKey ? renderByteLines(chart.bytesKey, series) : null}
						</LineChart>
					</ResponsiveContainer>
				</div>
			</CardContent>
		</Card>
	);
}

function MetricsChartsSkeleton() {
	return (
		<div aria-hidden="true" className="grid gap-4">
			{CHARTS.map((chart) => (
				<Card key={chart.title}>
					<CardHeader className="border-b">
						<div className="flex items-center gap-3">
							<Skeleton className="size-8 rounded-lg" />
							<div className="space-y-2">
								<Skeleton className="h-5 w-24" />
								<Skeleton className="h-4 w-56 max-w-full" />
							</div>
						</div>
					</CardHeader>
					<CardContent className="pt-4">
						<Skeleton className="h-72 rounded-lg lg:h-80" />
					</CardContent>
				</Card>
			))}
		</div>
	);
}

function MetricsStateCard({
	icon: Icon,
	title,
	description,
}: {
	icon: typeof Activity;
	title: string;
	description: string;
}) {
	return (
		<Card>
			<CardContent className="flex items-center gap-3 py-6">
				<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
					<Icon className="size-4" />
				</div>
				<div>
					<p className="font-medium">{title}</p>
					<p className="text-sm text-muted-foreground">{description}</p>
				</div>
			</CardContent>
		</Card>
	);
}

function renderByteLines(
	bytesKey: keyof MetricsHistory,
	series: ServerMetricsHistory[],
) {
	return series.map((server, index) => (
		<Line
			key={getSeriesKey(bytesKey, server.serverId)}
			yAxisId="bytes"
			type="monotone"
			dataKey={getSeriesKey(bytesKey, server.serverId)}
			name={`${server.serverName} used`}
			stroke={getServerColor(index)}
			strokeDasharray="4 4"
			strokeWidth={1.5}
			dot={false}
			connectNulls
			isAnimationActive={false}
		/>
	));
}

function MetricsTooltip({ active, payload, label }: MetricsTooltipProps) {
	if (!active || !payload?.length) return null;

	return (
		<div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
			<p className="mb-1 font-medium">{formatPreciseDateTime(String(label))}</p>
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

function buildChartRows(series: ServerMetricsHistory[]): ChartRow[] {
	const rows = new Map<string, ChartRow>();
	for (const server of series) {
		for (const [key, points] of Object.entries(server.history) as Array<
			[keyof MetricsHistory, MetricsHistory[keyof MetricsHistory]]
		>) {
			for (const point of points) {
				const row = rows.get(point.timestamp) ?? { timestamp: point.timestamp };
				row[getSeriesKey(key, server.serverId)] = point.value;
				rows.set(point.timestamp, row);
			}
		}
	}

	return Array.from(rows.values()).sort(
		(a, b) => getTimestamp(a.timestamp, 0) - getTimestamp(b.timestamp, 0),
	);
}
function formatTooltipValue(item: TooltipPayload) {
	const value = Number(item.value);
	if (!Number.isFinite(value)) return "-";
	const dataKey = String(item.dataKey);
	if (
		dataKey.startsWith("memoryUsedBytes:") ||
		dataKey.startsWith("diskUsedBytes:")
	) {
		return formatBytes(value);
	}
	return `${value.toFixed(1)}%`;
}

function getSeriesKey(metricKey: keyof MetricsHistory, serverId: string) {
	return `${metricKey}:${serverId}`;
}

function getServerColor(index: number) {
	return SERVER_COLORS[index % SERVER_COLORS.length];
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
