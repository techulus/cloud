"use client";

import {
	ArrowLeft,
	CheckCircle2,
	Loader2,
	RotateCcw,
	XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemTitle,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import type { Rollout, RolloutStatus, Service } from "@/db/types";
import { formatRelativeTime } from "@/lib/date";
import { LogViewer } from "@/components/logs/log-viewer";

type RolloutWithDates = Omit<Rollout, "createdAt" | "completedAt"> & {
	createdAt: string | Date;
	completedAt: string | Date | null;
};

const STATUS_CONFIG: Record<
	RolloutStatus,
	{
		icon: typeof CheckCircle2;
		color: string;
		bgColor: string;
		label: string;
	}
> = {
	in_progress: {
		icon: Loader2,
		color: "text-blue-500",
		bgColor: "bg-blue-500/10",
		label: "In Progress",
	},
	completed: {
		icon: CheckCircle2,
		color: "text-green-500",
		bgColor: "bg-green-500/10",
		label: "Completed",
	},
	failed: {
		icon: XCircle,
		color: "text-red-500",
		bgColor: "bg-red-500/10",
		label: "Failed",
	},
	rolled_back: {
		icon: RotateCcw,
		color: "text-orange-500",
		bgColor: "bg-orange-500/10",
		label: "Rolled Back",
	},
};

const STAGE_LABELS: Record<string, string> = {
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

function formatDuration(
	start: string | Date,
	end: string | Date | null,
): string {
	const startDate = new Date(start);
	const endDate = end ? new Date(end) : new Date();
	const diff = endDate.getTime() - startDate.getTime();
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	if (minutes > 0) {
		return `${minutes}m ${seconds % 60}s`;
	}
	return `${seconds}s`;
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
	const Icon = config.icon;
	const isLive = rollout.status === "in_progress";

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
						<span
							className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium ${config.color} ${config.bgColor}`}
						>
							<Icon className={`size-4 ${isLive ? "animate-spin" : ""}`} />
							{config.label}
						</span>
						{rollout.currentStage && isLive && (
							<span className="text-sm text-muted-foreground">
								{formatStage(rollout.currentStage)}
							</span>
						)}
						<span className="text-sm text-muted-foreground">
							Started {formatRelativeTime(rollout.createdAt)}
						</span>
						<span className="text-sm text-muted-foreground">
							Duration: {formatDuration(rollout.createdAt, rollout.completedAt)}
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
