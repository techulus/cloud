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
import { fetcher } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

type RequestStatsResponse = {
	loggingEnabled: boolean;
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
	tone: "live" | "progress" | "warning" | "muted";
};

type ChartRow = {
	timestamp: string;
	totalRequests: number;
} & Record<string, string | number>;

type RequestChartMode = "rate" | "total";

type StatusSeries = {
	status: string;
	rateDataKey: string;
	totalDataKey: string;
	color: string;
	averageRequestsPerSecond: number;
	totalRequests: number;
};

type RequestTooltipPayload = {
	name?: string;
	value?: unknown;
	color?: string;
	dataKey?: string;
	payload?: ChartRow;
};

type RequestTooltipProps = {
	active?: boolean;
	label?: string | number;
	mode: RequestChartMode;
	payload?: readonly RequestTooltipPayload[];
};

const STATUS_TONE_CLASSES: Record<
	ServiceStatus["tone"],
	{ dot: string; text: string }
> = {
	live: { dot: "bg-teal-500", text: "text-teal-700 dark:text-teal-400" },
	progress: { dot: "bg-blue-500", text: "text-blue-700 dark:text-blue-400" },
	warning: { dot: "bg-red-500", text: "text-red-700 dark:text-red-400" },
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
	const requestStatsUrl =
		overview.publicHttpCount > 0
			? `/api/services/${service.id}/request-stats?range=week`
			: null;
	const {
		data: requestStats,
		error: requestStatsError,
		isLoading: isRequestStatsLoading,
	} = useSWR<RequestStatsResponse>(requestStatsUrl, fetcher, {
		refreshInterval: 60000,
	});

	return (
		<Card className="gap-0 border border-border py-0 ring-0">
			<div className="grid items-stretch lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
				<RequestStatsPanel
					hasPublicHttp={overview.publicHttpCount > 0}
					stats={requestStats}
					error={requestStatsError}
					isLoading={isRequestStatsLoading}
				/>

				<ServiceConfigPanel service={service} overview={overview} />
			</div>
		</Card>
	);
}

function RequestStatsPanel({
	hasPublicHttp,
	stats,
	error,
	isLoading,
}: {
	hasPublicHttp: boolean;
	stats?: RequestStatsResponse;
	error?: unknown;
	isLoading: boolean;
}) {
	const [chartMode, setChartMode] = useState<RequestChartMode>("total");
	const chartRows = useMemo(() => buildChartRows(stats), [stats]);
	const statusSeries = useMemo(() => buildStatusSeries(stats), [stats]);
	const hasChartData = chartRows.some((row) => row.totalRequests > 0);
	const isUnavailable = Boolean(error) || stats?.loggingEnabled === false;
	const hasMetricData = hasPublicHttp && stats && !isUnavailable;

	return (
		<div className="flex h-full min-h-72 flex-col gap-4 p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					{isLoading ? (
						<div className="flex flex-wrap items-end gap-x-5 gap-y-2">
							<Skeleton className="h-9 w-28" />
							<Skeleton className="h-7 w-20" />
						</div>
					) : hasPublicHttp ? (
						<div className="flex flex-wrap items-end gap-x-5 gap-y-2">
							<div>
								<p className="text-4xl font-semibold tabular-nums">
									{hasMetricData
										? formatCompactNumber(stats.totalRequests)
										: "-"}
								</p>
								<p className="text-sm text-muted-foreground">
									requests this week
								</p>
							</div>
							<div>
								<p className="text-2xl font-semibold tabular-nums">
									{hasMetricData
										? formatRate(getAverageRequestsPerSecond(stats))
										: "-"}
								</p>
								<p className="text-sm text-muted-foreground">
									avg RPS this week
								</p>
							</div>
						</div>
					) : (
						<>
							<p className="text-4xl font-semibold tabular-nums">-</p>
							<p className="text-sm text-muted-foreground">
								no public HTTP ingress
							</p>
						</>
					)}
				</div>
				<div className="flex flex-col items-end gap-2">
					<p className="text-sm text-muted-foreground">{formatToday()}</p>
					<RequestChartModeToggle
						value={chartMode}
						onChange={setChartMode}
						disabled={
							!hasPublicHttp || isLoading || isUnavailable || !hasChartData
						}
					/>
				</div>
			</div>

			<div className="min-h-40 min-w-0 flex-1">
				{!hasPublicHttp ? (
					<RequestStatsState message="No public HTTP ingress" />
				) : isLoading ? (
					<Skeleton className="h-full rounded-lg" />
				) : isUnavailable ? (
					<RequestStatsState message="Request stats unavailable" />
				) : !hasChartData ? (
					<RequestStatsState message="No requests in this range" />
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
								left: chartMode === "rate" ? -28 : -20,
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
								tickFormatter={
									chartMode === "rate" ? formatRateTick : formatRequestTick
								}
								className="text-xs"
							/>
							<Tooltip
								cursor={{ strokeDasharray: "3 3" }}
								content={(props) => (
									<RequestStatsTooltip
										{...(props as unknown as RequestTooltipProps)}
										mode={chartMode}
									/>
								)}
							/>
							{statusSeries.map((series) => (
								<Line
									key={series.status}
									type="monotone"
									dataKey={
										chartMode === "rate"
											? series.rateDataKey
											: series.totalDataKey
									}
									name={series.status}
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

			{statusSeries.length > 0 && (
				<div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
					{statusSeries.map((series) => (
						<LegendMetric
							key={series.status}
							color={series.color}
							label={
								chartMode === "rate" ? `${series.status}/s` : series.status
							}
							value={
								stats && !isUnavailable
									? chartMode === "rate"
										? formatRate(series.averageRequestsPerSecond)
										: formatRequestCount(series.totalRequests)
									: "-"
							}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function RequestChartModeToggle({
	value,
	onChange,
	disabled,
}: {
	value: RequestChartMode;
	onChange: (value: RequestChartMode) => void;
	disabled: boolean;
}) {
	const options: Array<{ value: RequestChartMode; label: string }> = [
		{ value: "total", label: "Total" },
		{ value: "rate", label: "RPS" },
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

function RequestStatsState({ message }: { message: string }) {
	return (
		<div className="flex h-full items-center justify-center rounded-lg border border-border border-dashed text-sm text-muted-foreground">
			{message}
		</div>
	);
}

function RequestStatsTooltip({
	active,
	payload,
	label,
	mode,
}: RequestTooltipProps) {
	if (!active || !payload?.length) return null;

	const row = payload[0]?.payload;
	const visiblePayload = payload.filter((item) => Number(item.value) > 0);
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

	for (const deployment of service.deployments || []) {
		if (deployment.observedPhase === "failed") {
			return { label: "Needs attention", tone: "warning" };
		}
	}

	return {
		label: service.deployments.length > 0 ? "Stopped" : "Not deployed",
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

function buildChartRows(stats?: RequestStatsResponse): ChartRow[] {
	if (!stats) return [];

	return stats.buckets.map((bucket) => {
		const row: ChartRow = {
			timestamp: bucket.timestamp,
			totalRequests: bucket.totalRequests,
		};
		for (const status of stats.statusCodes) {
			const requests = bucket.statuses[status] ?? 0;
			row[getStatusRateDataKey(status)] = requests / stats.stepSeconds;
			row[getStatusTotalDataKey(status)] = requests;
		}
		return row;
	});
}

function buildStatusSeries(stats?: RequestStatsResponse): StatusSeries[] {
	if (!stats) return [];

	const totalSeconds = getStatsDurationSeconds(stats);

	return stats.statusCodes.map((status, index) => {
		const totalRequests = stats.buckets.reduce(
			(total, bucket) => total + (bucket.statuses[status] ?? 0),
			0,
		);

		return {
			status,
			rateDataKey: getStatusRateDataKey(status),
			totalDataKey: getStatusTotalDataKey(status),
			color: getStatusColor(status, index),
			averageRequestsPerSecond:
				totalSeconds > 0 ? totalRequests / totalSeconds : 0,
			totalRequests,
		};
	});
}

function getStatusRateDataKey(status: string): string {
	return `${getStatusDataKeyBase(status)}_rate`;
}

function getStatusTotalDataKey(status: string): string {
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

function getAverageRequestsPerSecond(stats: RequestStatsResponse): number {
	const totalSeconds = getStatsDurationSeconds(stats);

	if (totalSeconds <= 0) return 0;

	return stats.totalRequests / totalSeconds;
}

function getStatsDurationSeconds(stats: RequestStatsResponse): number {
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

function formatChartValue(value: number, mode: RequestChartMode): string {
	if (mode === "rate") return `${formatRate(value)}/s`;

	return formatRequestCount(value);
}

function formatRateTick(value: number): string {
	if (value >= 100) return value.toFixed(0);
	if (value >= 10) return value.toFixed(0);
	return value.toFixed(1);
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
