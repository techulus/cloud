"use client";

import {
	Activity,
	Box,
	Github,
	Globe,
	type LucideIcon,
	Server,
} from "lucide-react";
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
import { useService } from "@/components/service/service-layout-client";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ServiceWithDetails as Service } from "@/db/types";
import { isObservedStarting } from "@/lib/deployment-status";
import { fetcher } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

type ServiceMetricsResponse = {
	metricsEnabled: boolean;
	range: string;
	windowStart: string;
	windowEnd: string;
	stepSeconds: number;
	totalRequests: number;
	statusCodes: string[];
	buckets: Array<{
		timestamp: string;
		totalRequests: number;
		statuses: Record<string, number>;
		p50ResponseTimeMs: number | null;
		p90ResponseTimeMs: number | null;
		p95ResponseTimeMs: number | null;
		p99ResponseTimeMs: number | null;
		ingressBytesPerSecond: number | null;
		egressBytesPerSecond: number | null;
		cpuUsagePercent: number | null;
		memoryUsagePercent: number | null;
		memoryUsedBytes: number | null;
	}>;
};

type EndpointItem = {
	key: string;
	kind: "public" | "private" | "tcp";
	typeLabel: string;
	label: string;
	target: string;
	href?: string;
};

type ServerSummary = {
	id: string;
	name: string;
	configured: number;
	running: number;
	total: number;
};

type OverviewData = {
	endpoints: EndpointItem[];
	publicHttpCount: number;
	serverSummaries: ServerSummary[];
	runningDeployments: number;
	status: ServiceStatus;
	source: SourceInfo;
};

type SourceInfo = {
	icon: LucideIcon;
	label: string;
	detail: string;
	href?: string;
	branch?: string | null;
};

type ServiceStatus = {
	label: string;
	tone: "live" | "progress" | "warning" | "sleeping" | "muted";
};

type ChartRow = {
	timestamp: string;
	totalRequests: number;
} & Record<string, string | number | null>;

type ServiceChartMode = "requests" | "latency" | "traffic" | "resources";

type StatusSeries = {
	status: string;
	totalDataKey: string;
	color: string;
	totalRequests: number;
};

type ServiceMetricsTooltipPayload = {
	name?: string;
	value?: unknown;
	color?: string;
	dataKey?: string;
	payload?: ChartRow;
};

type ServiceMetricsTooltipProps = {
	active?: boolean;
	label?: string | number;
	mode: ServiceChartMode;
	payload?: readonly ServiceMetricsTooltipPayload[];
};

type MetricSeries = {
	key: string;
	label: string;
	color: string;
	valueFormatter: (value: number) => string;
};

const STATUS_TONE_CLASSES: Record<
	ServiceStatus["tone"],
	{ dot: string; text: string }
> = {
	live: { dot: "bg-teal-500", text: "text-teal-700 dark:text-teal-400" },
	progress: { dot: "bg-blue-500", text: "text-blue-700 dark:text-blue-400" },
	warning: { dot: "bg-red-500", text: "text-red-700 dark:text-red-400" },
	sleeping: { dot: "bg-cyan-500", text: "text-cyan-700 dark:text-cyan-400" },
	muted: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
};

const ACTIVE_BUILD_STATUSES = new Set([
	"pending",
	"claimed",
	"cloning",
	"building",
	"pushing",
]);

const STATUS_CODE_COLOR_PALETTES: Record<string, string[]> = {
	"2": ["#10b981", "#22c55e", "#14b8a6", "#84cc16"],
	"3": ["#6366f1", "#8b5cf6", "#06b6d4", "#3b82f6"],
	"4": ["#f59e0b", "#f97316", "#eab308", "#fb7185"],
	"5": ["#ef4444", "#f43f5e", "#dc2626", "#b91c1c"],
	default: ["#64748b", "#0ea5e9", "#a855f7", "#71717a"],
};

export function ServiceDetailsOverview({ service }: { service: Service }) {
	const { proxyDomain } = useService();
	const overview = useMemo(
		() => buildOverviewData(service, proxyDomain),
		[service, proxyDomain],
	);
	const serviceMetricsUrl =
		overview.runningDeployments > 0
			? `/api/services/${service.id}/metrics?range=24h`
			: null;
	const {
		data: serviceMetrics,
		error: serviceMetricsError,
		isLoading: isServiceMetricsLoading,
	} = useSWR<ServiceMetricsResponse>(serviceMetricsUrl, fetcher, {
		refreshInterval: 60000,
	});

	return (
		<Card className="gap-0 border border-border py-0 ring-0">
			<div className="grid items-stretch lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
				<ServiceMetricsPanel
					hasPublicHttp={overview.publicHttpCount > 0}
					hasRunningDeployments={overview.runningDeployments > 0}
					stats={serviceMetrics}
					error={serviceMetricsError}
					isLoading={isServiceMetricsLoading}
				/>

				<ServiceConfigPanel service={service} overview={overview} />
			</div>
		</Card>
	);
}

function ServiceMetricsPanel({
	hasPublicHttp,
	hasRunningDeployments,
	stats,
	error,
	isLoading,
}: {
	hasPublicHttp: boolean;
	hasRunningDeployments: boolean;
	stats?: ServiceMetricsResponse;
	error?: unknown;
	isLoading: boolean;
}) {
	const [chartMode, setChartMode] = useState<ServiceChartMode>("requests");
	const chartRows = useMemo(() => buildChartRows(stats), [stats]);
	const statusSeries = useMemo(() => buildStatusSeries(stats), [stats]);
	const activeSeries = useMemo(
		() => buildMetricSeries(chartMode, statusSeries),
		[chartMode, statusSeries],
	);
	const hasChartData = hasMetricDataForMode(chartRows, chartMode, activeSeries);
	const isUnavailable = Boolean(error) || stats?.metricsEnabled === false;
	const hasMetricData = stats && !isUnavailable;
	const p95 = getLatestValue(chartRows, "p95ResponseTimeMs");
	const egress = getLatestValue(chartRows, "egressBytesPerSecond");
	const cpu = getLatestValue(chartRows, "cpuUsagePercent");
	const memory = getLatestValue(chartRows, "memoryUsedBytes");

	return (
		<div className="flex h-full min-h-72 flex-col gap-4 p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					{isLoading ? (
						<div className="flex flex-wrap items-end gap-x-5 gap-y-2">
							<Skeleton className="h-7 w-24" />
							<Skeleton className="h-7 w-20" />
						</div>
					) : hasRunningDeployments ? (
						<div className="flex flex-wrap items-end gap-x-5 gap-y-2">
							<div>
								<p className="font-mono text-xl font-semibold tabular-nums tracking-tight">
									{hasMetricData
										? formatCompactNumber(stats.totalRequests)
										: "-"}
								</p>
								<p className="text-sm text-muted-foreground">requests in 24h</p>
							</div>
							<div>
								<p className="font-mono text-xl font-semibold tabular-nums tracking-tight">
									{hasMetricData
										? formatRate(getAverageRequestsPerSecond(stats))
										: "-"}
								</p>
								<p className="text-sm text-muted-foreground">avg RPS</p>
							</div>
							<div>
								<p className="font-mono text-xl font-semibold tabular-nums tracking-tight">
									{hasMetricData && p95 != null ? formatDurationMs(p95) : "-"}
								</p>
								<p className="text-sm text-muted-foreground">p95 latency</p>
							</div>
							<div>
								<p className="font-mono text-xl font-semibold tabular-nums tracking-tight">
									{hasMetricData && cpu != null ? `${formatRate(cpu)}%` : "-"}
								</p>
								<p className="text-sm text-muted-foreground">CPU</p>
							</div>
							<div>
								<p className="font-mono text-xl font-semibold tabular-nums tracking-tight">
									{hasMetricData && memory != null ? formatBytes(memory) : "-"}
								</p>
								<p className="text-sm text-muted-foreground">memory</p>
							</div>
							<div>
								<p className="font-mono text-xl font-semibold tabular-nums tracking-tight">
									{hasMetricData && egress != null
										? `${formatBytes(egress)}/s`
										: "-"}
								</p>
								<p className="text-sm text-muted-foreground">egress</p>
							</div>
						</div>
					) : (
						<>
							<p className="font-mono text-xl font-semibold tabular-nums tracking-tight">
								-
							</p>
							<p className="text-sm text-muted-foreground">not deployed</p>
						</>
					)}
				</div>
				<div className="flex flex-col items-end gap-2">
					<p className="text-sm text-muted-foreground">{formatToday()}</p>
					<ServiceChartModeToggle
						value={chartMode}
						onChange={setChartMode}
						disabled={!hasRunningDeployments || isLoading || isUnavailable}
					/>
				</div>
			</div>

			<div className="min-h-40 min-w-0 flex-1">
				{!hasRunningDeployments ? (
					<ServiceMetricsState message="Deploy the service to collect metrics" />
				) : isLoading ? (
					<Skeleton className="h-full rounded-lg" />
				) : isUnavailable ? (
					<ServiceMetricsState message="Service metrics unavailable" />
				) : !hasChartData ? (
					<ServiceMetricsState
						message={
							chartMode === "requests" ||
							chartMode === "latency" ||
							chartMode === "traffic"
								? hasPublicHttp
									? "No public HTTP metrics in this range"
									: "No public HTTP ingress"
								: "No resource metrics in this range"
						}
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
							data={chartRows}
							margin={{
								top: 8,
								right: 4,
								left: getYAxisMargin(chartMode),
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
								tickFormatter={formatShortDate}
								className="text-xs"
							/>
							<YAxis
								tickLine={false}
								axisLine={false}
								tickFormatter={(value) =>
									formatAxisTick(Number(value), chartMode)
								}
								className="text-xs"
							/>
							<Tooltip
								cursor={{ strokeDasharray: "3 3" }}
								content={(props) => (
									<ServiceMetricsTooltip
										{...(props as unknown as ServiceMetricsTooltipProps)}
										mode={chartMode}
									/>
								)}
							/>
							{activeSeries.map((series) => (
								<Line
									key={series.key}
									type="monotone"
									dataKey={series.key}
									name={series.label}
									stroke={series.color}
									strokeWidth={2}
									dot={false}
									connectNulls
									isAnimationActive={false}
								/>
							))}
						</LineChart>
					</ResponsiveContainer>
				)}
			</div>

			{activeSeries.length > 0 && (
				<div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
					{activeSeries.map((series) => (
						<LegendMetric
							key={series.key}
							color={series.color}
							label={series.label}
							value={formatLatestSeriesValue(chartRows, series)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function ServiceChartModeToggle({
	value,
	onChange,
	disabled,
}: {
	value: ServiceChartMode;
	onChange: (value: ServiceChartMode) => void;
	disabled: boolean;
}) {
	const options: Array<{ value: ServiceChartMode; label: string }> = [
		{ value: "requests", label: "Requests" },
		{ value: "latency", label: "Latency" },
		{ value: "traffic", label: "Traffic" },
		{ value: "resources", label: "Resources" },
	];

	return (
		<div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
			{options.map((option) => {
				const isSelected = value === option.value;

				return (
					<button
						key={option.value}
						type="button"
						aria-pressed={isSelected}
						disabled={disabled}
						onClick={() => onChange(option.value)}
						className={cn(
							"rounded-[5px] px-2 py-0.5 text-xs font-medium transition-colors",
							isSelected
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
							disabled &&
								"cursor-not-allowed opacity-50 hover:text-muted-foreground",
						)}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

function ServiceConfigPanel({
	service,
	overview,
}: {
	service: Service;
	overview: OverviewData;
}) {
	const primaryEndpoint = getPrimaryEndpoint(overview.endpoints);

	return (
		<div className="min-w-0 border-border border-t p-4 lg:border-t-0 lg:border-l">
			<div className="grid gap-3 sm:grid-cols-2">
				<SummaryItem icon={Activity} label="Status">
					<StatusValue status={overview.status} />
					<p className="text-base font-medium">
						{formatInstanceSummary(overview)}
					</p>
				</SummaryItem>
				<SummaryItem icon={Server} label="Instances">
					<ServerList servers={overview.serverSummaries} />
					<ConfigChip>{formatResources(service)}</ConfigChip>
				</SummaryItem>

				<ConfigDigestItem
					icon={overview.source.icon}
					label="Runtime"
					primary={<SourcePrimary source={overview.source} />}
				>
					<ConfigChip>
						{overview.source.branch || overview.source.detail}
					</ConfigChip>
					{service.githubRootDir ? (
						<ConfigChip>{service.githubRootDir}</ConfigChip>
					) : null}
					<ConfigChip>
						{service.startCommand ? "Custom Command" : "Image Command"}
					</ConfigChip>
					<ConfigChip tone={service.healthCheckCmd ? "active" : "muted"}>
						{service.healthCheckCmd ? "Health Check" : "No Health Check"}
					</ConfigChip>
				</ConfigDigestItem>

				<ConfigDigestItem
					icon={Globe}
					label="Network"
					primary={<EndpointPrimary endpoint={primaryEndpoint} />}
				>
					<ConfigChip>{formatPortSummary(service.ports || [])}</ConfigChip>
					{primaryEndpoint.kind !== "private" ? (
						<ConfigChip>{`${service.hostname || service.name}.internal`}</ConfigChip>
					) : null}
				</ConfigDigestItem>
			</div>
		</div>
	);
}

function SummaryItem({
	icon: Icon,
	label,
	children,
	className,
}: {
	icon: LucideIcon;
	label: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"min-w-0 rounded-md border border-border bg-muted/20 p-4",
				className,
			)}
		>
			<div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
				<Icon className="size-4" />
				<span>{label}</span>
			</div>
			<div className="mt-2 min-w-0 space-y-2 text-sm text-foreground">
				{children}
			</div>
		</div>
	);
}

function ConfigDigestItem({
	icon: Icon,
	label,
	primary,
	children,
	className,
}: {
	icon: LucideIcon;
	label: string;
	primary: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"min-w-0 rounded-md border border-border bg-muted/20 p-4",
				className,
			)}
		>
			<div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
				<Icon className="size-4" />
				<span>{label}</span>
			</div>
			<div className="mt-2 min-w-0 text-sm font-medium text-foreground">
				{primary}
			</div>
			<div className="mt-2 flex flex-wrap gap-1.5">{children}</div>
		</div>
	);
}

function ConfigChip({
	children,
	tone = "muted",
}: {
	children: ReactNode;
	tone?: "active" | "muted";
}) {
	return (
		<Badge
			variant={tone === "active" ? "secondary" : "outline"}
			className={cn("max-w-full", tone === "muted" && "text-muted-foreground")}
		>
			<span className="truncate">{children}</span>
		</Badge>
	);
}

function SourcePrimary({ source }: { source: SourceInfo }) {
	if (source.href) {
		return (
			<a
				href={source.href}
				target="_blank"
				rel="noopener noreferrer"
				className="block min-w-0 truncate hover:text-primary"
			>
				{source.label}
			</a>
		);
	}

	return <span className="block truncate">{source.label}</span>;
}

function EndpointPrimary({ endpoint }: { endpoint: EndpointItem }) {
	if (endpoint.href) {
		return (
			<a
				href={endpoint.href}
				target="_blank"
				rel="noopener noreferrer"
				className="block min-w-0 truncate hover:text-primary"
			>
				{endpoint.label}
			</a>
		);
	}

	return <span className="block truncate">{endpoint.label}</span>;
}

function StatusValue({ status }: { status: ServiceStatus }) {
	const classes = STATUS_TONE_CLASSES[status.tone];

	return (
		<div className="flex items-center gap-2">
			<span className={cn("size-2 rounded-full", classes.dot)} />
			<span className={cn("text-base font-medium", classes.text)}>
				{status.label}
			</span>
		</div>
	);
}

function ServerList({ servers }: { servers: ServerSummary[] }) {
	if (servers.length === 0) {
		return <p className="text-muted-foreground">No servers configured</p>;
	}

	return (
		<div className="flex flex-wrap gap-2">
			{servers.map((server) => (
				<Badge key={server.id} variant="outline" className="max-w-full">
					<span className="truncate">{server.name}</span>
					<span className="text-muted-foreground">
						{server.configured > 0
							? `${server.running}/${server.configured}`
							: `${server.running} Running`}
					</span>
				</Badge>
			))}
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

function ServiceMetricsState({ message }: { message: string }) {
	return (
		<div className="flex h-full items-center justify-center rounded-lg border border-border border-dashed text-sm text-muted-foreground">
			{message}
		</div>
	);
}

function ServiceMetricsTooltip({
	active,
	payload,
	label,
	mode,
}: ServiceMetricsTooltipProps) {
	if (!active || !payload?.length) return null;

	const row = payload[0]?.payload;
	const visiblePayload = payload.filter(
		(item) => item.value != null && Number.isFinite(Number(item.value)),
	);
	const items = visiblePayload.length > 0 ? visiblePayload : payload;

	return (
		<div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
			<p className="mb-1 font-medium">{formatTooltipDate(String(label))}</p>
			<div className="space-y-1">
				{items.map((item) => (
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
							{formatChartValue(Number(item.value), mode)}
						</span>
					</div>
				))}
			</div>
			{row ? (
				<p className="mt-1 text-muted-foreground">
					{formatRequestCount(row.totalRequests)} total requests
				</p>
			) : null}
		</div>
	);
}

function buildOverviewData(
	service: Service,
	proxyDomain: string | null,
): OverviewData {
	const endpoints: EndpointItem[] = [];
	const servers = new Map<string, ServerSummary>();
	let publicHttpCount = 0;
	let runningDeployments = 0;
	const privateHostname = `${service.hostname || service.name}.internal`;

	for (const replica of service.configuredReplicas || []) {
		servers.set(replica.serverId, {
			id: replica.serverId,
			name: replica.serverName,
			configured: replica.count,
			running: 0,
			total: 0,
		});
	}

	for (const deployment of service.deployments || []) {
		const serverId = deployment.serverId;
		const summary = servers.get(serverId) ?? {
			id: serverId,
			name: deployment.server?.name || "Unknown",
			configured: 0,
			running: 0,
			total: 0,
		};
		summary.total++;
		if (
			deployment.observedPhase === "running" ||
			deployment.observedPhase === "healthy"
		) {
			runningDeployments++;
			summary.running++;
		}
		servers.set(serverId, summary);
	}

	for (const port of service.ports || []) {
		if (port.isPublic && port.domain && port.protocol === "http") {
			publicHttpCount++;
			endpoints.push({
				key: port.id,
				kind: "public",
				typeLabel: "Public",
				label: port.domain,
				target: `HTTP :${port.port}`,
				href: `https://${port.domain}`,
			});
			continue;
		}

		if (
			port.isPublic &&
			(port.protocol === "tcp" || port.protocol === "udp") &&
			port.externalPort &&
			proxyDomain
		) {
			endpoints.push({
				key: port.id,
				kind: "tcp",
				typeLabel: port.protocol.toUpperCase(),
				label: `${port.protocol}://${proxyDomain}:${port.externalPort}`,
				target: `Container :${port.port}`,
			});
		}
	}

	endpoints.push({
		key: "internal",
		kind: "private",
		typeLabel: "Private",
		label: privateHostname,
		target: "Internal DNS",
	});

	return {
		endpoints,
		publicHttpCount,
		serverSummaries: Array.from(servers.values()).sort((a, b) =>
			a.name.localeCompare(b.name),
		),
		runningDeployments,
		status: getServiceStatus(service, runningDeployments),
		source: getSourceInfo(service),
	};
}

function getServiceStatus(
	service: Service,
	runningDeployments: number,
): ServiceStatus {
	const latestRollout = service.rollouts?.[0];
	const deployments = service.deployments || [];

	if (service.migrationStatus) return { label: "Migrating", tone: "progress" };
	if (
		service.latestBuild &&
		ACTIVE_BUILD_STATUSES.has(service.latestBuild.status)
	) {
		return { label: "Building", tone: "progress" };
	}
	if (
		latestRollout?.status === "queued" ||
		latestRollout?.status === "in_progress"
	) {
		return { label: "Deploying", tone: "progress" };
	}
	if (runningDeployments > 0) return { label: "Live", tone: "live" };

	for (const deployment of deployments) {
		if (deployment.observedPhase === "failed") {
			return { label: "Needs attention", tone: "warning" };
		}
	}
	for (const deployment of deployments) {
		if (deployment.observedPhase === "waking") {
			return { label: "Waking", tone: "progress" };
		}
	}
	for (const deployment of deployments) {
		if (isObservedStarting(deployment.observedPhase)) {
			return { label: "Starting", tone: "progress" };
		}
	}
	for (const deployment of deployments) {
		if (deployment.observedPhase === "sleeping") {
			return { label: "Sleeping", tone: "sleeping" };
		}
	}

	return {
		label: deployments.length > 0 ? "Stopped" : "Not deployed",
		tone: "muted",
	};
}

function getSourceInfo(service: Service): SourceInfo {
	if (service.sourceType === "github" && service.githubRepoUrl) {
		return {
			icon: Github,
			label: formatGithubRepo(service.githubRepoUrl),
			detail: "GitHub",
			href: service.githubRepoUrl,
			branch: service.githubBranch || "main",
		};
	}

	return {
		icon: Box,
		label: service.image,
		detail: "Docker Image",
	};
}

function buildChartRows(stats?: ServiceMetricsResponse): ChartRow[] {
	if (!stats) return [];

	return stats.buckets.map((bucket) => {
		const row: ChartRow = {
			timestamp: bucket.timestamp,
			totalRequests: bucket.totalRequests,
			p50ResponseTimeMs: bucket.p50ResponseTimeMs,
			p90ResponseTimeMs: bucket.p90ResponseTimeMs,
			p95ResponseTimeMs: bucket.p95ResponseTimeMs,
			p99ResponseTimeMs: bucket.p99ResponseTimeMs,
			ingressBytesPerSecond: bucket.ingressBytesPerSecond,
			egressBytesPerSecond: bucket.egressBytesPerSecond,
			cpuUsagePercent: bucket.cpuUsagePercent,
			memoryUsagePercent: bucket.memoryUsagePercent,
			memoryUsedBytes: bucket.memoryUsedBytes,
		};
		for (const status of stats.statusCodes) {
			const requests = bucket.statuses[status] ?? 0;
			row[getStatusDataKey(status)] = requests;
		}
		return row;
	});
}

function buildStatusSeries(stats?: ServiceMetricsResponse): StatusSeries[] {
	if (!stats) return [];

	return stats.statusCodes.map((status, index) => {
		const totalRequests = stats.buckets.reduce(
			(total, bucket) => total + (bucket.statuses[status] ?? 0),
			0,
		);

		return {
			status,
			totalDataKey: getStatusDataKey(status),
			color: getStatusColor(status, index),
			totalRequests,
		};
	});
}

function getStatusDataKey(status: string): string {
	return `${getStatusDataKeyBase(status)}_total`;
}

function getStatusDataKeyBase(status: string): string {
	const normalized = status.replace(/[^a-zA-Z0-9]/g, "_");
	return `status_${normalized || "unknown"}`;
}

function getStatusColor(status: string, index: number): string {
	const palette =
		STATUS_CODE_COLOR_PALETTES[status.charAt(0)] ??
		STATUS_CODE_COLOR_PALETTES.default;
	return palette[index % palette.length];
}

function formatGithubRepo(repoUrl: string): string {
	return repoUrl
		.replace(/^https:\/\/github\.com\//, "")
		.replace(/^git@github\.com:/, "")
		.replace(/\.git$/, "");
}

function formatResources(service: Service): string {
	const cpu = service.resourceCpuLimit;
	const memoryMb = service.resourceMemoryLimitMb;
	const cpuLabel =
		typeof cpu === "number" && Number.isFinite(cpu)
			? `${Number.isInteger(cpu) ? cpu : cpu.toFixed(1)} vCPU`
			: "CPU not set";
	const memoryLabel =
		typeof memoryMb === "number" && Number.isFinite(memoryMb)
			? `${memoryMb} MiB`
			: "Memory not set";

	return `${cpuLabel} · ${memoryLabel}`;
}

function getConfiguredReplicaCount(overview: OverviewData): number {
	return overview.serverSummaries.reduce(
		(total, server) => total + server.configured,
		0,
	);
}

function formatInstanceSummary(overview: OverviewData): string {
	const configured = getConfiguredReplicaCount(overview);
	const serverCount = overview.serverSummaries.length;

	if (configured === 0) {
		return overview.runningDeployments > 0
			? `${overview.runningDeployments} Running`
			: "No Replicas";
	}

	return `${overview.runningDeployments}/${configured} Running Across ${formatCount(serverCount, "server")}`;
}

function getPrimaryEndpoint(endpoints: EndpointItem[]): EndpointItem {
	return (
		endpoints.find((endpoint) => endpoint.kind === "public") ??
		endpoints.find((endpoint) => endpoint.kind === "tcp") ??
		endpoints[0] ?? {
			key: "none",
			kind: "private",
			typeLabel: "Private",
			label: "No endpoint",
			target: "Internal DNS",
		}
	);
}

function formatPortSummary(ports: Service["ports"]): string {
	if (ports.length === 0) return "No Ports";
	if (ports.length === 1) return formatPortLabel(ports[0]);

	return formatCount(ports.length, "port");
}

function formatPortLabel(port: Service["ports"][number]): string {
	const protocol = (port.protocol || "http").toUpperCase();
	const external = port.externalPort ? ` -> :${port.externalPort}` : "";

	return `${protocol} :${port.port}${external}`;
}

function formatCount(count: number, singular: string): string {
	const label = singular
		.split(" ")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");

	return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function formatCompactNumber(value: number): string {
	return new Intl.NumberFormat(undefined, {
		notation: "compact",
		maximumFractionDigits: value >= 1000 ? 1 : 0,
	}).format(value);
}

function formatRate(value: number): string {
	if (!Number.isFinite(value)) return "-";
	if (value >= 100) return value.toFixed(0);
	if (value >= 10) return value.toFixed(1);
	return value.toFixed(2).replace(/\.?0+$/, "");
}

function buildMetricSeries(
	mode: ServiceChartMode,
	statusSeries: StatusSeries[],
): MetricSeries[] {
	if (mode === "requests") {
		return statusSeries.map((series) => ({
			key: series.totalDataKey,
			label: series.status,
			color: series.color,
			valueFormatter: formatRequestCount,
		}));
	}

	if (mode === "latency") {
		return [
			{
				key: "p99ResponseTimeMs",
				label: "p99",
				color: "#ef4444",
				valueFormatter: formatDurationMs,
			},
			{
				key: "p95ResponseTimeMs",
				label: "p95",
				color: "#ec4899",
				valueFormatter: formatDurationMs,
			},
			{
				key: "p90ResponseTimeMs",
				label: "p90",
				color: "#f59e0b",
				valueFormatter: formatDurationMs,
			},
			{
				key: "p50ResponseTimeMs",
				label: "p50",
				color: "#3b82f6",
				valueFormatter: formatDurationMs,
			},
		];
	}

	if (mode === "traffic") {
		return [
			{
				key: "ingressBytesPerSecond",
				label: "Ingress",
				color: "#0ea5e9",
				valueFormatter: (value) => `${formatBytes(value)}/s`,
			},
			{
				key: "egressBytesPerSecond",
				label: "Egress",
				color: "#10b981",
				valueFormatter: (value) => `${formatBytes(value)}/s`,
			},
		];
	}

	return [
		{
			key: "cpuUsagePercent",
			label: "CPU",
			color: "#8b5cf6",
			valueFormatter: (value) => `${formatRate(value)}%`,
		},
		{
			key: "memoryUsagePercent",
			label: "Memory",
			color: "#14b8a6",
			valueFormatter: (value) => `${formatRate(value)}%`,
		},
	];
}

function hasMetricDataForMode(
	rows: ChartRow[],
	mode: ServiceChartMode,
	series: MetricSeries[],
): boolean {
	if (mode === "requests") {
		return rows.some((row) => row.totalRequests > 0);
	}
	return rows.some((row) =>
		series.some((item) => {
			const value = row[item.key];
			return typeof value === "number" && Number.isFinite(value);
		}),
	);
}

function getLatestValue(rows: ChartRow[], key: string): number | null {
	for (let index = rows.length - 1; index >= 0; index--) {
		const value = rows[index][key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
	}
	return null;
}

function formatLatestSeriesValue(
	rows: ChartRow[],
	series: MetricSeries,
): string {
	const value = getLatestValue(rows, series.key);
	return value == null ? "-" : series.valueFormatter(value);
}

function getAverageRequestsPerSecond(stats: ServiceMetricsResponse): number {
	const totalSeconds = getStatsDurationSeconds(stats);

	if (totalSeconds <= 0) return 0;

	return stats.totalRequests / totalSeconds;
}

function getStatsDurationSeconds(stats: ServiceMetricsResponse): number {
	const windowStart = new Date(stats.windowStart).getTime();
	const windowEnd = new Date(stats.windowEnd).getTime();

	if (
		Number.isFinite(windowStart) &&
		Number.isFinite(windowEnd) &&
		windowEnd > windowStart
	) {
		return (windowEnd - windowStart) / 1000;
	}

	return stats.buckets.length * stats.stepSeconds;
}

function formatChartValue(value: number, mode: ServiceChartMode): string {
	if (!Number.isFinite(value)) return "-";
	if (mode === "latency") return formatDurationMs(value);
	if (mode === "traffic") return `${formatBytes(value)}/s`;
	if (mode === "resources") return `${formatRate(value)}%`;
	return formatRequestCount(value);
}

function formatAxisTick(value: number, mode: ServiceChartMode): string {
	if (mode === "latency") return formatDurationMs(value);
	if (mode === "traffic") return formatBytes(value);
	if (mode === "resources") return `${formatRateTick(value)}%`;
	return formatRequestTick(value);
}

function formatRateTick(value: number): string {
	if (value >= 100) return value.toFixed(0);
	if (value >= 10) return value.toFixed(0);
	return value.toFixed(1);
}

function getYAxisMargin(mode: ServiceChartMode): number {
	if (mode === "traffic") return -4;
	if (mode === "latency") return -12;
	if (mode === "resources") return -24;
	return -20;
}

function formatRequestTick(value: number): string {
	return formatCompactNumber(value);
}

function formatRequestCount(value: number): string {
	if (!Number.isFinite(value)) return "-";

	return new Intl.NumberFormat(undefined, {
		maximumFractionDigits: 0,
	}).format(value);
}

function formatDurationMs(value: number): string {
	if (!Number.isFinite(value)) return "-";
	if (value >= 1000) {
		return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}s`;
	}
	if (value >= 100) return `${value.toFixed(0)}ms`;
	if (value >= 10) return `${value.toFixed(1)}ms`;
	return `${value.toFixed(2).replace(/\.?0+$/, "")}ms`;
}

function formatBytes(value: number): string {
	if (!Number.isFinite(value)) return "-";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let unitIndex = 0;
	let scaled = Math.max(0, value);
	while (scaled >= 1000 && unitIndex < units.length - 1) {
		scaled /= 1000;
		unitIndex++;
	}
	const maximumFractionDigits = scaled >= 100 || unitIndex === 0 ? 0 : 1;
	return `${scaled.toFixed(maximumFractionDigits)} ${units[unitIndex]}`;
}

function formatShortDate(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
	}).format(new Date(value));
}

function formatTooltipDate(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(value));
}

function formatToday(): string {
	return new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		month: "short",
	}).format(new Date());
}
