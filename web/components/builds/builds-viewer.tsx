"use client";

import {
	AlertCircle,
	CheckCircle2,
	CircleDashed,
	Clock,
	GitBranch,
	GitCommit,
	Hammer,
	Loader2,
	Play,
	RotateCcw,
	XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { cancelBuild, retryBuild, triggerBuild } from "@/actions/builds";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import type { Build, BuildStatus } from "@/db/types";
import { formatRelativeTime } from "@/lib/date";
import { fetcher } from "@/lib/fetcher";

type BuildListItem = Pick<
	Build,
	| "id"
	| "commitSha"
	| "commitMessage"
	| "branch"
	| "author"
	| "status"
	| "error"
> & {
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
};

const STATUS_CONFIG: Record<
	BuildStatus,
	{
		icon: typeof CheckCircle2;
		color: string;
		label: string;
	}
> = {
	pending: {
		icon: Clock,
		color: "text-zinc-500",
		label: "Queued",
	},
	claimed: {
		icon: CircleDashed,
		color: "text-blue-500",
		label: "Starting",
	},
	cloning: {
		icon: Loader2,
		color: "text-blue-500",
		label: "Cloning",
	},
	building: {
		icon: Loader2,
		color: "text-blue-500",
		label: "Building",
	},
	pushing: {
		icon: Loader2,
		color: "text-blue-500",
		label: "Pushing",
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
	cancelled: {
		icon: AlertCircle,
		color: "text-zinc-500",
		label: "Cancelled",
	},
};

function StatusBadge({ status }: { status: BuildStatus }) {
	const config = STATUS_CONFIG[status];
	const Icon = config.icon;
	const isAnimated = ["cloning", "building", "pushing"].includes(status);

	return (
		<span
			className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ${config.color} bg-current/10`}
		>
			<Icon className={`size-3.5 ${isAnimated ? "animate-spin" : ""}`} />
			{config.label}
		</span>
	);
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

export function BuildsViewer({
	serviceId,
	projectSlug,
	envName,
}: {
	serviceId: string;
	projectSlug: string;
	envName: string;
}) {
	const router = useRouter();
	const [isTriggering, setIsTriggering] = useState(false);
	const [cancellingId, setCancellingId] = useState<string | null>(null);
	const [retryingId, setRetryingId] = useState<string | null>(null);

	const { data, isLoading, mutate } = useSWR<{ builds: BuildListItem[] }>(
		`/api/services/${serviceId}/builds`,
		fetcher,
		{
			refreshInterval: 5000,
		},
	);

	const builds = data?.builds || [];

	const handleTriggerBuild = async () => {
		setIsTriggering(true);
		try {
			await triggerBuild(serviceId);
			toast.success("Build triggered");
			mutate();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to trigger build",
			);
		} finally {
			setIsTriggering(false);
		}
	};

	const handleCancelBuild = async (buildId: string) => {
		setCancellingId(buildId);
		try {
			await cancelBuild(buildId);
			toast.success("Build cancelled");
			mutate();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to cancel build",
			);
		} finally {
			setCancellingId(null);
		}
	};

	const handleRetryBuild = async (buildId: string) => {
		setRetryingId(buildId);
		try {
			await retryBuild(buildId);
			toast.success("Build queued");
			mutate();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to retry build",
			);
		} finally {
			setRetryingId(null);
		}
	};

	const canCancel = (status: BuildStatus) =>
		["pending", "claimed", "cloning", "building", "pushing"].includes(status);

	const canRetry = (status: BuildStatus) =>
		["failed", "cancelled"].includes(status);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Spinner className="size-6" />
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-lg font-semibold">Builds</h2>
					<p className="text-sm text-muted-foreground">
						Builds are triggered automatically on push to the deploy branch.
					</p>
				</div>
				<Button onClick={handleTriggerBuild} disabled={isTriggering} size="sm">
					{isTriggering ? (
						<Loader2 className="size-4 mr-1.5 animate-spin" />
					) : (
						<Play className="size-4 mr-1.5" />
					)}
					Build
				</Button>
			</div>

			{builds.length === 0 ? (
				<Empty className="border py-10">
					<EmptyMedia variant="icon">
						<Hammer />
					</EmptyMedia>
					<EmptyTitle>No builds yet</EmptyTitle>
					<EmptyDescription>
						Push to your repository to trigger a build.
					</EmptyDescription>
				</Empty>
			) : (
				<ItemGroup>
					{builds.map((build) => (
						<Item
							key={build.id}
							variant="outline"
							className="cursor-pointer hover:bg-muted/50"
							onClick={() =>
								router.push(
									`/dashboard/projects/${projectSlug}/${envName}/services/${serviceId}/builds/${build.id}`,
								)
							}
						>
							<StatusBadge status={build.status} />
							<ItemContent>
								<ItemTitle>
									<GitCommit className="size-3.5 text-muted-foreground" />
									<code className="font-mono text-xs">
										{build.commitSha.slice(0, 7)}
									</code>
									<span className="truncate text-muted-foreground font-normal">
										{build.commitMessage?.split("\n")[0] || "No message"}
									</span>
								</ItemTitle>
								<ItemDescription>
									<span className="inline-flex items-center gap-1">
										<GitBranch className="size-3" />
										{build.branch}
									</span>
									{build.author && (
										<span className="ml-3">by {build.author}</span>
									)}
									<span className="ml-3">
										{formatRelativeTime(build.createdAt)}
									</span>
									{build.startedAt && (
										<span className="ml-3">
											Duration:{" "}
											{formatDuration(build.startedAt, build.completedAt)}
										</span>
									)}
								</ItemDescription>
								{build.error && (
									<div className="mt-1 text-xs text-red-500 bg-red-500/10 rounded p-2">
										{build.error}
									</div>
								)}
							</ItemContent>
							<ItemActions onClick={(e) => e.stopPropagation()}>
								{canCancel(build.status) && (
									<Button
										variant="outline"
										size="sm"
										onClick={() => handleCancelBuild(build.id)}
										disabled={cancellingId === build.id}
									>
										{cancellingId === build.id ? (
											<Loader2 className="size-4 animate-spin" />
										) : (
											<XCircle className="size-4" />
										)}
									</Button>
								)}
								{canRetry(build.status) && (
									<Button
										variant="outline"
										size="sm"
										onClick={() => handleRetryBuild(build.id)}
										disabled={retryingId === build.id}
									>
										{retryingId === build.id ? (
											<Loader2 className="size-4 animate-spin" />
										) : (
											<RotateCcw className="size-4" />
										)}
									</Button>
								)}
							</ItemActions>
						</Item>
					))}
				</ItemGroup>
			)}
		</div>
	);
}
