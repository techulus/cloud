"use client";

import { CheckCircle2, Clock, Loader2, RotateCcw, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import type { RolloutStatus } from "@/db/types";
import { formatElapsedDurationBetween, formatRelativeTime } from "@/lib/date";
import { fetcher } from "@/lib/fetcher";

type RolloutListItem = {
	id: string;
	serviceId: string;
	status: RolloutStatus;
	currentStage: string | null;
	createdAt: string;
	completedAt: string | null;
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

const STATUS_TITLES: Record<Exclude<RolloutStatus, "in_progress">, string> = {
	queued: "Waiting to begin deployment",
	completed: "Deployment completed successfully",
	failed: "Deployment failed",
	rolled_back: "Deployment rolled back",
};

function RolloutStatusBadge({ status }: { status: RolloutStatus }) {
	const config = STATUS_CONFIG[status];
	const isAnimated = status === "in_progress";

	return (
		<StatusBadge
			icon={config.icon}
			label={config.label}
			isAnimated={isAnimated}
			className={config.color}
		/>
	);
}

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
	if (!stage) return "Starting";
	return STAGE_LABELS[stage] || stage;
}

function RolloutHistorySkeleton({ actions }: { actions?: React.ReactNode }) {
	return (
		<div className="space-y-4 max-w-5xl mx-auto">
			<div className="flex items-center justify-between gap-4">
				<Skeleton className="h-7 w-36" />
				{actions ? <div className="shrink-0">{actions}</div> : null}
			</div>

			<div className="grid gap-2">
				{[1, 2, 3].map((item) => (
					<div
						key={item}
						className="flex items-center gap-3 rounded-lg border p-4"
					>
						<Skeleton className="h-7 w-28 rounded-md" />
						<div className="min-w-0 flex-1 space-y-2">
							<Skeleton className="h-4 w-48 max-w-full" />
							<Skeleton className="h-3 w-64 max-w-full" />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

export function RolloutHistory({
	serviceId,
	projectSlug,
	envName,
	actions,
}: {
	serviceId: string;
	projectSlug: string;
	envName: string;
	actions?: React.ReactNode;
}) {
	const [hasInProgress, setHasInProgress] = useState(false);

	const { data, isLoading } = useSWR<{ rollouts: RolloutListItem[] }>(
		`/api/services/${serviceId}/rollouts`,
		fetcher,
		{
			refreshInterval: hasInProgress ? 3000 : 30000,
			revalidateOnFocus: true,
			onSuccess: (data) => {
				setHasInProgress(
					data?.rollouts?.some(
						(r) => r.status === "queued" || r.status === "in_progress",
					) ?? false,
				);
			},
		},
	);

	const rollouts = data?.rollouts || [];

	if (isLoading) {
		return <RolloutHistorySkeleton actions={actions} />;
	}

	return (
		<div className="space-y-4 max-w-5xl mx-auto">
			<div className="flex items-center justify-between gap-4">
				<h2 className="text-lg font-semibold">Rollout History</h2>
				{actions}
			</div>

			{rollouts.length === 0 ? (
				<Empty className="border py-10">
					<EmptyMedia variant="icon">
						<Clock />
					</EmptyMedia>
					<EmptyTitle>No rollouts yet</EmptyTitle>
					<EmptyDescription>
						Deploy your service to see rollout history here.
					</EmptyDescription>
				</Empty>
			) : (
				<ItemGroup>
					{rollouts.map((rollout) => (
						<Link
							key={rollout.id}
							href={`/dashboard/projects/${projectSlug}/${envName}/services/${serviceId}/rollouts/${rollout.id}`}
						>
							<Item variant="outline">
								<RolloutStatusBadge status={rollout.status} />
								<ItemContent>
									<ItemTitle>
										<span className="truncate">
											{rollout.status === "in_progress"
												? `Deploying — ${formatStage(rollout.currentStage)}`
												: STATUS_TITLES[rollout.status]}
										</span>
									</ItemTitle>
									<ItemDescription>
										<span>{formatRelativeTime(rollout.createdAt)}</span>
										<span className="ml-3">
											Duration:{" "}
											{formatElapsedDurationBetween(
												rollout.createdAt,
												rollout.completedAt,
											)}
										</span>
									</ItemDescription>
								</ItemContent>
							</Item>
						</Link>
					))}
				</ItemGroup>
			)}
		</div>
	);
}
