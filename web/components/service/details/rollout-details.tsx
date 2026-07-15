"use client";

import {
	ArrowLeft,
	CheckCircle2,
	Clock,
	Loader2,
	RotateCcw,
	XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { LogViewer } from "@/components/logs/log-viewer";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Rollout, RolloutStatus, Service } from "@/db/types";
import { formatElapsedDurationBetween, formatRelativeTime } from "@/lib/date";

type RolloutWithDates = Omit<Rollout, "createdAt" | "completedAt"> & {
	createdAt: string | Date;
	completedAt: string | Date | null;
};

const STATUS_CONFIG: Record<
	RolloutStatus,
	{
		icon: typeof CheckCircle2;
		color: string;
		label: string;
	}
> = {
	queued: {
		icon: Clock,
		color: "text-slate-500",
		label: "Queued",
	},
	in_progress: {
		icon: Loader2,
		color: "text-blue-500",
		label: "In Progress",
	},
	completed: {
		icon: CheckCircle2,
		color: "text-green-500",
		label: "Completed",
	},
	failed: {
		icon: XCircle,
		color: "text-red-500",
		label: "Failed",
	},
	rolled_back: {
		icon: RotateCcw,
		color: "text-orange-500",
		label: "Rolled Back",
	},
};

const STAGE_LABELS: Record<string, string> = {
	queued: "Queued",
	preparing: "Preparing",
	certificates: "Issuing Certificates",
	deploying: "Deploying",
	health_check: "Health Check",
	dns_sync: "DNS Sync",
	completed: "Completed",
};

function formatStage(stage: string | null): string {
	if (!stage) return "—";
	return STAGE_LABELS[stage] || stage;
}

export function RolloutDetails({
	projectSlug,
	envName,
	service,
	rollout,
}: {
	projectSlug: string;
	envName: string;
	service: Pick<Service, "id" | "name">;
	rollout: RolloutWithDates;
}) {
	const router = useRouter();
	const config = STATUS_CONFIG[rollout.status as RolloutStatus];
	const isLive =
		rollout.status === "queued" || rollout.status === "in_progress";
	const isAnimated = rollout.status === "in_progress";

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-4">
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={() =>
						router.push(
							`/dashboard/projects/${projectSlug}/${envName}/services/${service.id}`,
						)
					}
				>
					<ArrowLeft className="size-4" />
				</Button>
				<div className="flex-1 min-w-0">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
						<StatusBadge
							icon={config.icon}
							label={config.label}
							isAnimated={isAnimated}
							className={config.color}
						/>
						{rollout.currentStage && isLive && (
							<span className="text-sm text-muted-foreground">
								{formatStage(rollout.currentStage)}
							</span>
						)}
						<span className="text-sm text-muted-foreground">
							Started {formatRelativeTime(rollout.createdAt)}
						</span>
						<span className="text-sm text-muted-foreground">
							Duration:{" "}
							{formatElapsedDurationBetween(
								rollout.createdAt,
								rollout.completedAt,
							)}
						</span>
					</div>
				</div>
			</div>

			<div className="space-y-2">
				<h3 className="text-sm font-medium">Rollout Logs</h3>
				<LogViewer
					variant="rollout-logs"
					rolloutId={rollout.id}
					isLive={isLive}
				/>
			</div>
		</div>
	);
}
