"use client";

import {
	Activity,
	Box,
	Cpu,
	Github,
	Globe,
	HardDrive,
	type LucideIcon,
	Server,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
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
	stepSeconds: number;
	currentWindowSeconds: number;
	totalRequests: number;
	currentRequestsPerSecond: number;
	statusCodes: string[];
	currentStatuses: Array<{
		status: string;
		requests: number;
		requestsPerSecond: number;
	}>;
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

type StatusSeries = {
	status: string;
	dataKey: string;
	color: string;
	currentRequestsPerSecond: number;
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
			? `/api/services/${service.id}/request-stats?range=7d`
			: null;
	const {
		data: requestStats,
		error: requestStatsError,
		isLoading: isRequestStatsLoading,
	} = useSWR<RequestStatsResponse>(requestStatsUrl, fetcher, {
		refreshInterval: 60000,
	});

	return (
		<Card className="gap-0 py-0">
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
	const chartRows = useMemo(() => buildChartRows(stats), [stats]);
	const statusSeries = useMemo(() => buildStatusSeries(stats), [stats]);
	const hasChartData = chartRows.some((row) => row.totalRequests > 0);
	const isUnavailable = Boolean(error) || stats?.loggingEnabled === false;

	return (
		<div className="flex h-full min-h-72 flex-col gap-4 p-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					{isLoading ? (
						<Skeleton className="h-9 w-28" />
					) : (
						<p className="text-4xl font-semibold tabular-nums">
							{hasPublicHttp && stats && !isUnavailable
								? formatCompactNumber(stats.totalRequests)
								: "-"}
						</p>
					)}
					<p className="text-sm text-muted-foreground">
						{hasPublicHttp ? "requests this week" : "no public HTTP ingress"}
					</p>
				</div>
				<p className="text-sm text-muted-foreground">{formatToday()}</p>
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
							margin={{ top: 8, right: 4, left: -28, bottom: 0 }}
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
								tickFormatter={formatRateTick}
								className="text-xs"
							/>
							<Tooltip
								cursor={{ strokeDasharray: "3 3" }}
								content={(props) => (
									<RequestStatsTooltip
										{...(props as unknown as RequestTooltipProps)}
									/>
								)}
							/>
							{statusSeries.map((series) => (
								<Line
									key={series.status}
									type="monotone"
									dataKey={series.dataKey}
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
							label={`${series.status}/s`}
							value={
								stats && !isUnavailable
									? formatRate(series.currentRequestsPerSecond)
									: "-"
							}
						/>
					))}
				</div>
			)}
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
		<div className="min-w-0 border-t p-4 lg:border-t-0 lg:border-l">
			<div className="grid gap-3 sm:grid-cols-2">
				<SummaryItem icon={Activity} label="Status">
					<StatusValue status={overview.status} />
				</SummaryItem>
				<SummaryItem icon={Server} label="Instances">
					<p className="text-base font-medium">
						{formatInstanceSummary(overview)}
					</p>
					<ServerList servers={overview.serverSummaries} />
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
					icon={Cpu}
					label="Capacity"
					primary={formatResources(service)}
				>
					<ConfigChip>{formatReplicaCompact(overview)}</ConfigChip>
					<ConfigChip>{formatPlacementLabel(service)}</ConfigChip>
					{overview.serverSummaries.length > 0 ? (
						<ConfigChip>
							{formatCount(overview.serverSummaries.length, "server")}
						</ConfigChip>
					) : null}
				</ConfigDigestItem>

				<ConfigDigestItem
					icon={Globe}
					label="Network"
					primary={<EndpointPrimary endpoint={primaryEndpoint} />}
				>
					<ConfigChip>{formatEndpointCount(overview.endpoints)}</ConfigChip>
					<ConfigChip>{formatPortSummary(service.ports || [])}</ConfigChip>
					{primaryEndpoint.kind !== "private" ? (
						<ConfigChip>{`${service.hostname || service.name}.internal`}</ConfigChip>
					) : null}
				</ConfigDigestItem>

				<ConfigDigestItem
					icon={HardDrive}
					label="Data & ops"
					primary={formatDataSummary(service)}
				>
					<ConfigChip>{formatBackupLabel(service)}</ConfigChip>
					<ConfigChip>{formatDeployScheduleLabel(service)}</ConfigChip>
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
		<div className={cn("min-w-0 rounded-md border bg-muted/20 p-4", className)}>
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
		<div className={cn("min-w-0 rounded-md border bg-muted/20 p-4", className)}>
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
		<div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
			{message}
		</div>
	);
}

function RequestStatsTooltip({ active, payload, label }: RequestTooltipProps) {
	if (!active || !payload?.length) return null;

	const row = payload[0]?.payload;
	const visiblePayload = payload.filter((item) => Number(item.value) > 0);
	const items = visiblePayload.length > 0 ? visiblePayload : payload;

	return (
		<div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
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
							{formatRate(Number(item.value))}/s
						</span>
					</div>
				))}
			</div>
			{row ? (
				<p className="mt-1 text-muted-foreground">
					{row.totalRequests} total requests
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
		if (deployment.status === "running") {
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
		if (deployment.status === "failed" || deployment.status === "rolled_back") {
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
			row[getStatusDataKey(status)] =
				(bucket.statuses[status] ?? 0) / stats.stepSeconds;
		}
		return row;
	});
}

function buildStatusSeries(stats?: RequestStatsResponse): StatusSeries[] {
	if (!stats) return [];

	const currentByStatus = new Map(
		stats.currentStatuses.map((status) => [status.status, status]),
	);

	return stats.statusCodes.map((status, index) => ({
		status,
		dataKey: getStatusDataKey(status),
		color: getStatusColor(status, index),
		currentRequestsPerSecond:
			currentByStatus.get(status)?.requestsPerSecond ?? 0,
	}));
}

function getStatusDataKey(status: string): string {
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

function getLockedServerLabel(service: Service): string | null {
	if (!service.lockedServerId) return null;

	return (
		service.lockedServer?.name ??
		service.configuredReplicas.find(
			(replica) => replica.serverId === service.lockedServerId,
		)?.serverName ??
		service.lockedServerId
	);
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

function formatReplicaCompact(overview: OverviewData): string {
	const configured = getConfiguredReplicaCount(overview);

	if (configured === 0) return "No Replicas";

	return `${overview.runningDeployments}/${configured} Running`;
}

function formatPlacementLabel(service: Service): string {
	const lockedServer = getLockedServerLabel(service);

	if (service.stateful) {
		return lockedServer ? `Stateful on ${lockedServer}` : "Stateful";
	}

	return lockedServer ? `Pinned to ${lockedServer}` : "Stateless";
}

function formatEndpointCount(endpoints: EndpointItem[]): string {
	const publicCount = endpoints.filter(
		(endpoint) => endpoint.kind !== "private",
	).length;

	if (publicCount === 0) return "Private Only";

	return `${formatCount(publicCount, "public endpoint")} + Private`;
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

function formatDataSummary(service: Service): string {
	const volumeCount = service.volumes?.length ?? 0;
	const secretCount = service.secrets?.length ?? 0;
	const parts = [];

	if (volumeCount > 0) parts.push(formatCount(volumeCount, "volume"));
	if (secretCount > 0) parts.push(formatCount(secretCount, "secret"));

	return parts.length > 0 ? parts.join(" · ") : "No Volumes or Secrets";
}

function formatBackupLabel(service: Service): string {
	if ((service.volumes?.length ?? 0) === 0) return "No Backups";
	if (!service.backupEnabled) return "Manual Backups";

	return service.backupSchedule
		? `Backup ${service.backupSchedule}`
		: "Backups On";
}

function formatDeployScheduleLabel(service: Service): string {
	return service.deploymentSchedule
		? `Deploy ${service.deploymentSchedule}`
		: "Manual Deploy";
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

function formatRateTick(value: number): string {
	if (value >= 100) return value.toFixed(0);
	if (value >= 10) return value.toFixed(0);
	return value.toFixed(1);
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
