"use client";

import cronstrue from "cronstrue";
import { Ban, CheckCircle2, XCircle } from "lucide-react";
import { memo } from "react";
import { LocalDate } from "@/components/core/local-date";
import { ConfigSection } from "@/components/service/details/config-section";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ServiceCron, ServiceWithDetails as Service } from "@/db/types";

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

	return (
		<ConfigSection
			title="Crons"
			summary={crons.length > 0 ? `${crons.length}` : "None"}
			summaryMuted={crons.length === 0}
		>
			<div className="space-y-4">
				<p className="text-sm text-muted-foreground">
					Cron jobs are managed in{" "}
					<code className="font-mono">techulus.yml</code>. Schedules run in UTC
					and are read-only here.
				</p>

				{crons.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No cron jobs configured.
					</p>
				) : (
					<div className="space-y-3">
						{crons.map((cron) => (
							<div key={cron.id} className="space-y-3 rounded-md border p-3">
								<div className="space-y-1">
									<p className="break-all font-mono text-sm font-medium">
										{cron.path}
									</p>
									<p className="font-mono text-xs">{cron.schedule}</p>
									<p className="text-xs text-muted-foreground">
										{describeSchedule(cron.schedule)} (UTC)
									</p>
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
