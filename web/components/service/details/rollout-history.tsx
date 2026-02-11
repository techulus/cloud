"use client";

import { useState } from "react";
import { CheckCircle2, Clock, Loader2, RotateCcw, XCircle } from "lucide-react";
import Link from "next/link";
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
import { Spinner } from "@/components/ui/spinner";
import type { RolloutStatus } from "@/db/types";
import { formatRelativeTime } from "@/lib/date";
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

function StatusBadge({ status }: { status: RolloutStatus }) {
	const config = STATUS_CONFIG[status];
	const Icon = config.icon;
	const isAnimated = status === "in_progress";

	return (
		<span
			className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ${config.color} bg-current/10`}
		>
			<Icon className={`size-3.5 ${isAnimated ? "animate-spin" : ""}`} />
			{config.label}
		</span>
	);
}

const STAGE_LABELS: Record<string, string> = {
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

function formatDuration(start: string, end: string | null): string {
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
					data?.rollouts?.some((r) => r.status === "in_progress") ?? false,
				);
			},
		},
	);

	const rollouts = data?.rollouts || [];

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Spinner className="size-6" />
			</div>
		);
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
								<StatusBadge status={rollout.status} />
								<ItemContent>
									<ItemTitle>
										<span className="truncate">
											{rollout.status === "in_progress"
												? `Deploying — ${formatStage(rollout.currentStage)}`
												: STATUS_CONFIG[rollout.status].label}
										</span>
									</ItemTitle>
									<ItemDescription>
										<span>{formatRelativeTime(rollout.createdAt)}</span>
										<span className="ml-3">
											Duration:{" "}
											{formatDuration(rollout.createdAt, rollout.completedAt)}
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
