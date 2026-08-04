"use client";

import {
	type Activity,
	AlertTriangle,
	Ban,
	CheckCircle2,
	Clock3,
	Database,
	Radio,
	ShieldCheck,
	XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import useSWR from "swr";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import type {
	CrowdSecAlert,
	CrowdSecDecision,
	CrowdSecHealth,
} from "@/db/schema";
import { formatDateTime, formatRelativeTime, getTimestamp } from "@/lib/date";
import { fetcher } from "@/lib/fetcher";

type ServerStatus = "pending" | "online" | "offline" | "unknown";
type HealthState = "healthy" | "degraded" | "stale" | "not-reported";

type SecurityStatusResponse = {
	status: ServerStatus;
	crowdsecHealth: CrowdSecHealth | null;
};

const STALE_AFTER_MS = 120_000;

const statePresentation = {
	healthy: {
		label: "Healthy",
		icon: CheckCircle2,
		className: "text-emerald-600 dark:text-emerald-400",
	},
	degraded: {
		label: "Degraded",
		icon: AlertTriangle,
		className: "text-amber-600 dark:text-amber-400",
	},
	stale: {
		label: "Stale",
		icon: Clock3,
		className: "text-amber-600 dark:text-amber-400",
	},
	"not-reported": {
		label: "Not reported",
		icon: XCircle,
		className: "text-muted-foreground",
	},
} satisfies Record<HealthState, object>;

function Status({ state }: { state: HealthState }) {
	const presentation = statePresentation[state];
	return (
		<StatusBadge
			icon={presentation.icon}
			label={presentation.label}
			className={presentation.className}
		/>
	);
}

function isOlderThan(value: string | undefined, now: number) {
	const timestamp = getTimestamp(value);
	return !Number.isFinite(timestamp) || now - timestamp > STALE_AFTER_MS;
}

function getOverallState(
	status: ServerStatus,
	health: CrowdSecHealth | null,
	now: number,
): HealthState {
	if (!health) return "not-reported";
	if (status !== "online" || isOlderThan(health.checkedAt, now)) return "stale";

	const bouncerFailed =
		!health.bouncer.available ||
		!health.bouncer.registered ||
		health.bouncer.revoked ||
		isOlderThan(health.bouncer.lastPullAt, now);
	if (
		!health.lapi.available ||
		!health.metrics.available ||
		bouncerFailed ||
		!health.decisions.available ||
		!health.alerts.available
	) {
		return "degraded";
	}
	return "healthy";
}

function ComponentCard({
	title,
	description,
	available,
	icon: Icon,
	children,
}: {
	title: string;
	description: string;
	available: boolean;
	icon: typeof Activity;
	children?: React.ReactNode;
}) {
	return (
		<Card size="sm">
			<CardHeader className="flex-row items-start justify-between gap-3">
				<div>
					<CardTitle className="flex items-center gap-2">
						<Icon className="size-4 text-muted-foreground" aria-hidden="true" />
						{title}
					</CardTitle>
					<CardDescription className="mt-1">{description}</CardDescription>
				</div>
				<StatusBadge
					icon={available ? CheckCircle2 : XCircle}
					label={available ? "Available" : "Unavailable"}
					className={
						available
							? "text-emerald-600 dark:text-emerald-400"
							: "text-destructive"
					}
					size="sm"
				/>
			</CardHeader>
			{children && <CardContent>{children}</CardContent>}
		</Card>
	);
}

function DateValue({ value }: { value?: string }) {
	if (!value) return <span>Never</span>;
	return (
		<time dateTime={value} title={formatDateTime(value)}>
			{formatRelativeTime(value)} ({formatDateTime(value)})
		</time>
	);
}

function formatBouncerError(error: string) {
	switch (error) {
		case "command_failed":
			return "CrowdSec status command failed";
		case "invalid_output":
			return "CrowdSec returned an invalid status response";
		default:
			return "CrowdSec bouncer status is unavailable";
	}
}

export function ServerSecurityPage({
	serverId,
	initialServerStatus,
	initialHealth,
}: {
	serverId: string;
	initialServerStatus: ServerStatus;
	initialHealth: CrowdSecHealth | null;
}) {
	const { data } = useSWR<SecurityStatusResponse>(
		`/api/servers/${serverId}/security`,
		fetcher,
		{ refreshInterval: 10_000 },
	);
	const status = data === undefined ? initialServerStatus : data.status;
	const health = data === undefined ? initialHealth : data.crowdsecHealth;
	const [now, setNow] = useState<number | null>(null);
	useEffect(() => {
		const refreshNow = () => setNow(Date.now());
		refreshNow();
		const interval = window.setInterval(refreshNow, 10_000);
		return () => window.clearInterval(interval);
	}, []);
	// Match the snapshot on the server render; the client clock takes over after
	// hydration so stale state advances without creating a hydration mismatch.
	const currentTime = now ?? getTimestamp(health?.checkedAt, 0);
	const overallState = getOverallState(status, health, currentTime);
	const bouncerAvailable = Boolean(
		health?.bouncer.available &&
			health.bouncer.registered &&
			!health.bouncer.revoked &&
			!isOlderThan(health.bouncer.lastPullAt, currentTime),
	);
	const bouncerRegistration = health?.bouncer.revoked
		? "Revoked"
		: health?.bouncer.registered
			? "Registered"
			: "Missing";

	return (
		<div className="space-y-4">
			<Card>
				<CardHeader className="flex-row items-start justify-between gap-4">
					<div className="space-y-1">
						<CardTitle className="flex items-center gap-2 text-lg">
							<ShieldCheck className="size-5" aria-hidden="true" />
							CrowdSec Protection
						</CardTitle>
						<CardDescription>
							Threat detection and automated blocking for public traffic.
						</CardDescription>
					</div>
					<Status state={overallState} />
				</CardHeader>
				<CardContent className="text-sm text-muted-foreground">
					Last checked: <DateValue value={health?.checkedAt} />
				</CardContent>
			</Card>

			<div className="grid gap-4 md:grid-cols-3">
				<ComponentCard
					title="LAPI"
					description="CrowdSec local API connectivity"
					available={health?.lapi.available ?? false}
					icon={Database}
				/>
				<ComponentCard
					title="Traefik acquisition"
					description="Access-log ingestion counters"
					available={health?.metrics.available ?? false}
					icon={Radio}
				>
					<dl className="grid grid-cols-3 gap-2 text-center">
						{[
							["Read", health?.metrics.reads],
							["Parsed", health?.metrics.parsed],
							["Unparsed", health?.metrics.unparsed],
						].map(([label, value]) => (
							<div key={label} className="rounded-md bg-muted/50 p-2">
								<dt className="text-xs text-muted-foreground">{label}</dt>
								<dd className="mt-1 font-mono font-semibold tabular-nums">
									{value ?? "—"}
								</dd>
							</div>
						))}
					</dl>
				</ComponentCard>
				<ComponentCard
					title="Traefik bouncer"
					description="Automated decision enforcement"
					available={bouncerAvailable}
					icon={Ban}
				>
					<dl className="space-y-2 text-xs">
						<div className="flex justify-between gap-2">
							<dt className="text-muted-foreground">Registration</dt>
							<dd>{bouncerRegistration}</dd>
						</div>
						<div className="flex justify-between gap-2">
							<dt className="text-muted-foreground">Last decision pull</dt>
							<dd className="text-right">
								<DateValue value={health?.bouncer.lastPullAt} />
							</dd>
						</div>
						{health?.bouncer.error && (
							<div className="text-destructive">
								{formatBouncerError(health.bouncer.error)}
							</div>
						)}
					</dl>
				</ComponentCard>
			</div>

			<SecurityList
				title="Active blocks"
				description="Current CrowdSec decisions. Active blocks do not indicate degraded health."
				available={health?.decisions.available ?? false}
				truncated={health?.decisions.truncated ?? false}
				records={health?.decisions.records ?? []}
				kind="decisions"
			/>
			<SecurityList
				title="Recent threats"
				description="Threats detected during the last 24 hours."
				available={health?.alerts.available ?? false}
				truncated={health?.alerts.truncated ?? false}
				records={health?.alerts.records ?? []}
				kind="alerts"
			/>
		</div>
	);
}

type SecurityListProps =
	| {
			title: string;
			description: string;
			available: boolean;
			truncated: boolean;
			records: CrowdSecDecision[];
			kind: "decisions";
	  }
	| {
			title: string;
			description: string;
			available: boolean;
			truncated: boolean;
			records: CrowdSecAlert[];
			kind: "alerts";
	  };

function SecurityList(props: SecurityListProps) {
	const { title, description, available, truncated, records, kind } = props;
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{!available ? (
					<p className="rounded-md border border-dashed p-4 text-muted-foreground">
						{title} are unavailable from the latest check.
					</p>
				) : records.length === 0 ? (
					<p className="rounded-md border border-dashed p-4 text-muted-foreground">
						{kind === "decisions"
							? "No active blocks."
							: "No threats detected in the last 24 hours."}
					</p>
				) : kind === "decisions" ? (
					<DecisionRows records={records as CrowdSecDecision[]} />
				) : (
					<AlertRows records={records as CrowdSecAlert[]} />
				)}
				{available && truncated && (
					<p className="text-xs text-muted-foreground">
						Showing the newest reported records; additional results were
						truncated.
					</p>
				)}
			</CardContent>
		</Card>
	);
}

function DecisionRows({ records }: { records: CrowdSecDecision[] }) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-3xl text-left text-sm">
				<caption className="sr-only">Active CrowdSec blocks</caption>
				<thead className="border-b text-xs text-muted-foreground">
					<tr>
						<th className="px-2 py-2 font-medium">Target</th>
						<th className="px-2 py-2 font-medium">Action</th>
						<th className="px-2 py-2 font-medium">Reason</th>
						<th className="px-2 py-2 font-medium">Origin</th>
						<th className="px-2 py-2 font-medium">Expiry</th>
					</tr>
				</thead>
				<tbody className="divide-y">
					{records.map((record, index) => (
						<tr key={`${record.scope}-${record.value}-${index}`}>
							<td className="px-2 py-3">
								<span className="text-xs text-muted-foreground">
									{record.scope}
								</span>
								<div className="font-mono">{record.value}</div>
							</td>
							<td className="px-2 py-3">{record.action}</td>
							<td className="px-2 py-3">{record.reason || "—"}</td>
							<td className="px-2 py-3">{record.origin || "—"}</td>
							<td className="px-2 py-3">
								<DateValue value={record.expiresAt} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function AlertRows({ records }: { records: CrowdSecAlert[] }) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-3xl text-left text-sm">
				<caption className="sr-only">Recent CrowdSec threats</caption>
				<thead className="border-b text-xs text-muted-foreground">
					<tr>
						<th className="px-2 py-2 font-medium">Detected</th>
						<th className="px-2 py-2 font-medium">Scenario</th>
						<th className="px-2 py-2 font-medium">Source IP</th>
						<th className="px-2 py-2 font-medium">Country</th>
						<th className="px-2 py-2 text-right font-medium">Events</th>
					</tr>
				</thead>
				<tbody className="divide-y">
					{records.map((record) => (
						<tr key={record.id}>
							<td className="px-2 py-3">
								<DateValue value={record.detectedAt} />
							</td>
							<td className="px-2 py-3">{record.scenario || "—"}</td>
							<td className="px-2 py-3 font-mono">{record.sourceIp || "—"}</td>
							<td className="px-2 py-3">{record.country || "—"}</td>
							<td className="px-2 py-3 text-right font-mono tabular-nums">
								{record.eventCount}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
