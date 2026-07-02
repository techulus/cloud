"use client";

import {
	Activity,
	ArrowUpRight,
	Box,
	Cpu,
	GitBranch,
	Github,
	Globe,
	Lock,
	type LucideIcon,
	Network,
	Server,
} from "lucide-react";
import Link from "next/link";
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
import { buttonVariants } from "@/components/ui/button";
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
	currentErrorsPerSecond: number;
	buckets: Array<{
		timestamp: string;
		requests: number;
		errors: number;
	}>;
};

type EndpointItem = {
	key: string;
	label: string;
	meta: string;
	href?: string;
	icon: "http" | "tcp" | "internal";
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
	configuredReplicas: number;
	totalDeployments: number;
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
	requestsPerSecond: number;
	errorsPerSecond: number;
	requests: number;
	errors: number;
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

export function ServiceDetailsOverview({ service }: { service: Service }) {
	const { projectSlug, envName, proxyDomain } = useService();
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
	const basePath = `/dashboard/projects/${projectSlug}/${envName}/services/${service.id}`;
	const titleEndpoint = overview.endpoints[0]?.label || service.name;
	const hiddenEndpointCount = Math.max(0, overview.endpoints.length - 1);

	return (
		<Card className="gap-0 py-0">
			<div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex min-w-0 items-center gap-2">
					<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
						<Globe className="size-4" />
					</div>
					<div className="min-w-0">
						<div className="flex min-w-0 items-center gap-2">
							<p className="truncate font-mono text-base font-semibold">
								{titleEndpoint}
							</p>
							{hiddenEndpointCount > 0 && (
								<Badge variant="secondary">+{hiddenEndpointCount}</Badge>
							)}
						</div>
					</div>
				</div>
				{overview.publicHttpCount > 0 && (
					<div className="flex flex-wrap items-center gap-2">
						<Link
							href={`${basePath}/requests`}
							className={buttonVariants({ variant: "outline", size: "sm" })}
						>
							Requests
							<ArrowUpRight data-icon="inline-end" />
						</Link>
					</div>
				)}
			</div>

			<div className="grid lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
				<RequestStatsPanel
					hasPublicHttp={overview.publicHttpCount > 0}
					stats={requestStats}
					error={requestStatsError}
					isLoading={isRequestStatsLoading}
				/>

				<div className="grid gap-x-8 gap-y-6 p-4 sm:grid-cols-2 lg:border-l">
					<StatusItem status={overview.status} />
					<InstancesItem overview={overview} />
					<DetailItem icon={Cpu} label="Resources">
						<p>{formatResources(service)}</p>
					</DetailItem>
					<DetailItem icon={overview.source.icon} label="Source">
						<SourceDetails source={overview.source} />
					</DetailItem>
					<DetailItem icon={Globe} label="Endpoints">
						<EndpointList endpoints={overview.endpoints} />
					</DetailItem>
				</div>
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
	const hasChartData = chartRows.some(
		(row) => row.requests > 0 || row.errors > 0,
	);
	const isUnavailable = Boolean(error) || stats?.loggingEnabled === false;

	return (
		<div className="space-y-4 p-4">
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

			<div className="h-40 min-w-0">
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
							<Line
								type="monotone"
								dataKey="requestsPerSecond"
								name="Requests/s"
								stroke="#0ea5e9"
								strokeWidth={2}
								dot={false}
								connectNulls
								isAnimationActive={false}
							/>
							<Line
								type="monotone"
								dataKey="errorsPerSecond"
								name="Errors/s"
								stroke="#ef4444"
								strokeWidth={2}
								dot={false}
								connectNulls
								isAnimationActive={false}
							/>
						</LineChart>
					</ResponsiveContainer>
				)}
			</div>

			<div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
				<LegendMetric
					color="bg-sky-500"
					label="Requests/s"
					value={
						stats && !isUnavailable
							? formatRate(stats.currentRequestsPerSecond)
							: "-"
					}
				/>
				<LegendMetric
					color="bg-red-500"
					label="Errors/s"
					value={
						stats && !isUnavailable
							? formatRate(stats.currentErrorsPerSecond)
							: "-"
					}
				/>
			</div>
		</div>
	);
}

function StatusItem({ status }: { status: ServiceStatus }) {
	const classes = STATUS_TONE_CLASSES[status.tone];

	return (
		<DetailItem icon={Activity} label="Status">
			<div className="flex items-center gap-2">
				<span className={cn("size-2 rounded-full", classes.dot)} />
				<span className={cn("font-medium", classes.text)}>{status.label}</span>
			</div>
		</DetailItem>
	);
}

function InstancesItem({ overview }: { overview: OverviewData }) {
	const serverCount = overview.serverSummaries.length;
	const serverLabel = serverCount === 1 ? "server" : "servers";

	return (
		<DetailItem icon={Server} label="Instances">
			<div className="space-y-2">
				<div>
					<p>
						<span className="font-medium">{overview.runningDeployments}</span>{" "}
						running
						{serverCount > 0 ? ` across ${serverCount} ${serverLabel}` : ""}
					</p>
					<p className="text-xs text-muted-foreground">
						{overview.configuredReplicas} configured ·{" "}
						{overview.totalDeployments} total
					</p>
				</div>
				<ServerList servers={overview.serverSummaries} />
			</div>
		</DetailItem>
	);
}

function DetailItem({
	icon: Icon,
	label,
	children,
}: {
	icon: LucideIcon;
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="min-w-0 space-y-2">
			<div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
				<Icon className="size-4" />
				<span>{label}</span>
			</div>
			<div className="min-w-0 text-sm text-foreground">{children}</div>
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
							: `${server.running} running`}
					</span>
				</Badge>
			))}
		</div>
	);
}

function SourceDetails({ source }: { source: SourceInfo }) {
	const content = (
		<div className="min-w-0 space-y-1">
			<p className="break-all font-medium">{source.label}</p>
			<div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
				{source.branch ? <GitBranch className="size-3" /> : null}
				<span className="truncate">{source.branch || source.detail}</span>
			</div>
		</div>
	);

	if (!source.href) return content;

	return (
		<a
			href={source.href}
			target="_blank"
			rel="noopener noreferrer"
			className="block hover:text-primary"
		>
			{content}
		</a>
	);
}

function EndpointList({ endpoints }: { endpoints: EndpointItem[] }) {
	if (endpoints.length === 0) {
		return <p className="text-muted-foreground">No endpoints yet</p>;
	}

	return (
		<div className="space-y-1.5">
			{endpoints.map((endpoint) => {
				const Icon =
					endpoint.icon === "http"
						? Globe
						: endpoint.icon === "tcp"
							? Network
							: Lock;
				const content = (
					<div
						key={`${endpoint.key}-content`}
						className="flex min-w-0 items-center gap-2"
					>
						<Icon className="size-3.5 shrink-0 text-muted-foreground" />
						<div className="min-w-0">
							<p className="truncate font-medium">{endpoint.label}</p>
							<p className="truncate text-xs text-muted-foreground">
								{endpoint.meta}
							</p>
						</div>
					</div>
				);

				return endpoint.href ? (
					<a
						key={endpoint.key}
						href={endpoint.href}
						target="_blank"
						rel="noopener noreferrer"
						className="block hover:text-primary"
					>
						{content}
					</a>
				) : (
					<div key={endpoint.key}>{content}</div>
				);
			})}
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
			<span className={cn("size-2.5 rounded-full", color)} />
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

	return (
		<div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
			<p className="mb-1 font-medium">{formatTooltipDate(String(label))}</p>
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
							{formatRate(Number(item.value))}
						</span>
					</div>
				))}
			</div>
			{row ? (
				<p className="mt-1 text-muted-foreground">
					{row.requests} requests · {row.errors} 5xx
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
	let totalDeployments = 0;
	let configuredReplicas = 0;

	for (const replica of service.configuredReplicas || []) {
		configuredReplicas += replica.count;
		servers.set(replica.serverId, {
			id: replica.serverId,
			name: replica.serverName,
			configured: replica.count,
			running: 0,
			total: 0,
		});
	}

	for (const deployment of service.deployments || []) {
		totalDeployments++;
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
				label: port.domain,
				meta: `HTTP :${port.port}`,
				href: `https://${port.domain}`,
				icon: "http",
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
				label: `${port.protocol}://${proxyDomain}:${port.externalPort}`,
				meta: `Container :${port.port}`,
				icon: "tcp",
			});
		}
	}

	if (runningDeployments > 0) {
		endpoints.push({
			key: "internal",
			label: `${service.hostname || service.name}.internal`,
			meta: "Internal DNS",
			icon: "internal",
		});
	}

	return {
		endpoints,
		publicHttpCount,
		serverSummaries: Array.from(servers.values()).sort((a, b) =>
			a.name.localeCompare(b.name),
		),
		runningDeployments,
		configuredReplicas,
		totalDeployments,
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
		detail: "Docker image",
	};
}

function buildChartRows(stats?: RequestStatsResponse): ChartRow[] {
	if (!stats) return [];

	return stats.buckets.map((bucket) => ({
		timestamp: bucket.timestamp,
		requests: bucket.requests,
		errors: bucket.errors,
		requestsPerSecond: bucket.requests / stats.stepSeconds,
		errorsPerSecond: bucket.errors / stats.stepSeconds,
	}));
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
