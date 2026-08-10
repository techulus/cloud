"use client";

import cronstrue from "cronstrue";
import {
	AlertTriangle,
	Ban,
	CheckCircle2,
	Loader2,
	Play,
	XCircle,
} from "lucide-react";
import { memo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { runServiceCron } from "@/actions/crons";
import { LocalDate } from "@/components/core/local-date";
import { ConfigSection } from "@/components/service/details/config-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import type {
	Secret,
	ServiceCron,
	ServiceWithDetails as Service,
} from "@/db/types";
import { fetcher } from "@/lib/fetcher";

const STATUS_CONFIG = {
	succeeded: {
		icon: CheckCircle2,
		label: "Succeeded",
		className: "text-green-500",
	},
	failed: { icon: XCircle, label: "Failed", className: "text-red-500" },
	skipped: { icon: Ban, label: "Skipped", className: "text-orange-500" },
} as const;

function describeSchedule(schedule: string) {
	try {
		return cronstrue.toString(schedule, { verbose: true });
	} catch {
		return "Invalid cron expression";
	}
}

function CronStatus({
	status,
}: {
	status: NonNullable<ServiceCron["lastStatus"]>;
}) {
	const config = STATUS_CONFIG[status];
	return (
		<StatusBadge
			icon={config.icon}
			label={config.label}
			className={config.className}
			size="sm"
		/>
	);
}

function formatDuration(durationMs: number) {
	return durationMs < 1000
		? `${durationMs}ms`
		: `${(durationMs / 1000).toFixed(2)}s`;
}

export const CronsSection = memo(function CronsSection({
	service,
}: {
	service: Service;
}) {
	const crons = service.crons ?? [];
	const { data: secrets } = useSWR<Pick<Secret, "id" | "key" | "createdAt">[]>(
		crons.length > 0 ? `/api/services/${service.id}/secrets` : null,
		fetcher,
	);
	const hasCronBaseUrl = secrets?.some(
		(secret) => secret.key === "CRON_BASE_URL",
	);
	const [runningCronId, setRunningCronId] = useState<string | null>(null);

	const handleRun = async (cronId: string) => {
		setRunningCronId(cronId);
		try {
			await runServiceCron(cronId);
			toast.success("Cron run queued");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to queue cron run",
			);
		} finally {
			setRunningCronId(null);
		}
	};

	return (
		<ConfigSection
			title="Crons"
			summary={crons.length > 0 ? `${crons.length}` : "None"}
			summaryMuted={crons.length === 0}
		>
			<div className="space-y-4">
				<p className="text-sm text-muted-foreground">
					Cron schedules are configured in{" "}
					<code className="font-mono">techulus.yml</code> and run in UTC.
				</p>

				{crons.length > 0 && secrets !== undefined && !hasCronBaseUrl && (
					<Alert className="border-yellow-500/50 bg-yellow-500/10">
						<AlertTriangle className="text-yellow-600" />
						<AlertTitle className="text-yellow-700 dark:text-yellow-500">
							Cron base URL required
						</AlertTitle>
						<AlertDescription className="text-yellow-700/80 dark:text-yellow-500/80">
							Cron jobs will not run until the{" "}
							<code className="font-mono">CRON_BASE_URL</code> secret is set.
						</AlertDescription>
					</Alert>
				)}

				{crons.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No cron jobs configured.
					</p>
				) : (
					<div className="space-y-3">
						{crons.map((cron) => (
							<div key={cron.id} className="space-y-3 rounded-md border p-3">
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0 space-y-1">
										<p className="break-all font-mono text-sm font-medium">
											{cron.path}
										</p>
										<p className="font-mono text-xs">{cron.schedule}</p>
										<p className="text-xs text-muted-foreground">
											{describeSchedule(cron.schedule)} (UTC)
										</p>
									</div>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => handleRun(cron.id)}
										disabled={runningCronId !== null}
									>
										{runningCronId === cron.id ? (
											<Loader2 className="animate-spin" />
										) : (
											<Play />
										)}
										{runningCronId === cron.id ? "Queuing…" : "Run now"}
									</Button>
								</div>

								{cron.lastStatus ? (
									<div className="space-y-2 text-sm">
										<div className="flex flex-wrap items-center gap-2">
											<CronStatus status={cron.lastStatus} />
											<span className="text-muted-foreground">
												<LocalDate
													value={cron.lastFinishedAt ?? cron.lastStartedAt}
												/>
											</span>
										</div>
										<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
											<span>HTTP status: {cron.lastStatusCode ?? "—"}</span>
											<span>
												Duration:{" "}
												{cron.lastDurationMs == null
													? "—"
													: formatDuration(cron.lastDurationMs)}
											</span>
										</div>
										{cron.lastError && (
											<p className="break-words text-xs text-destructive">
												{cron.lastError}
											</p>
										)}
									</div>
								) : (
									<p className="text-sm text-muted-foreground">Never run.</p>
								)}
							</div>
						))}
					</div>
				)}
			</div>
		</ConfigSection>
	);
});
