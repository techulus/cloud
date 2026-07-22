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
import {
	cancelBuild,
	retryBuild,
	triggerBuild,
	triggerManualBuild,
} from "@/actions/builds";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
import { StatusBadge } from "@/components/ui/status-badge";
import type { Build, BuildStatus } from "@/db/types";
import { formatElapsedDurationBetween, formatRelativeTime } from "@/lib/date";
import { fetcher } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

type BuildListItem = Pick<
	Build,
	"id" | "commitSha" | "commitMessage" | "branch" | "author" | "status"
> & {
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
};

type Commit = {
	sha: string;
	message: string;
	author: string | null;
	date: string;
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
		color: "text-slate-500",
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
		color: "text-slate-500",
		label: "Cancelled",
	},
};

function BuildStatusBadge({
	status,
	className,
	size,
}: {
	status: BuildStatus;
	className?: string;
	size?: "default" | "sm";
}) {
	const config = STATUS_CONFIG[status];
	const isAnimated = ["cloning", "building", "pushing"].includes(status);

	return (
		<StatusBadge
			icon={config.icon}
			label={config.label}
			isAnimated={isAnimated}
			className={cn(config.color, className)}
			size={size}
		/>
	);
}

export function BuildsViewer({
	serviceId,
	hasGithubAppRepo,
	projectSlug,
	envName,
}: {
	serviceId: string;
	hasGithubAppRepo: boolean;
	projectSlug: string;
	envName: string;
}) {
	const router = useRouter();
	const [isTriggering, setIsTriggering] = useState(false);
	const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
	const [selectedSha, setSelectedSha] = useState<string | null>(null);
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
	const {
		data: commitData,
		error: commitError,
		isLoading: commitsLoading,
	} = useSWR<{ branch: string; commits: Commit[] }>(
		isCommitDialogOpen && hasGithubAppRepo
			? `/api/services/${serviceId}/github/commits`
			: null,
		fetcher,
		{
			onSuccess: (result) =>
				setSelectedSha((current) => current ?? result.commits[0]?.sha ?? null),
		},
	);

	const handleTriggerBuild = async () => {
		if (hasGithubAppRepo) {
			setSelectedSha(null);
			setIsCommitDialogOpen(true);
			return;
		}
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

	const handleDeployCommit = async () => {
		if (!selectedSha) return;
		setIsTriggering(true);
		try {
			await triggerManualBuild(serviceId, selectedSha);
			toast.success("Commit queued for deployment");
			setIsCommitDialogOpen(false);
			await mutate();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to deploy commit",
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
			<Dialog
				open={isCommitDialogOpen}
				onOpenChange={(open) => !isTriggering && setIsCommitDialogOpen(open)}
			>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Deploy a commit</DialogTitle>
						<DialogDescription>
							Choose one of the latest commits from the configured source
							branch.
						</DialogDescription>
					</DialogHeader>
					<div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
						<span className="text-muted-foreground">Source branch</span>{" "}
						<code className="ml-2 font-mono">{commitData?.branch ?? "…"}</code>
					</div>
					<div className="max-h-[50vh] overflow-y-auto rounded-md border">
						{commitsLoading ? (
							<div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
								<Spinner /> Loading commits…
							</div>
						) : commitError ? (
							<div className="p-6 text-center text-destructive">
								{commitError.message || "Failed to load commits"}
							</div>
						) : commitData?.commits.length === 0 ? (
							<div className="p-8 text-center text-muted-foreground">
								No commits found on this branch.
							</div>
						) : (
							<div role="radiogroup" aria-label="Commit to deploy">
								{commitData?.commits.map((commit) => (
									<label
										key={commit.sha}
										className="flex cursor-pointer gap-3 border-b p-3 last:border-b-0 hover:bg-muted/50 has-[:checked]:bg-muted"
									>
										<input
											type="radio"
											name="commit"
											value={commit.sha}
											checked={selectedSha === commit.sha}
											onChange={() => setSelectedSha(commit.sha)}
											className="mt-1 accent-primary"
										/>
										<div className="min-w-0 flex-1">
											<div className="truncate font-medium">
												{commit.message.split("\n")[0] || "No message"}
											</div>
											<div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
												<code>{commit.sha.slice(0, 7)}</code>
												{commit.author && <span>by {commit.author}</span>}
												{commit.date && (
													<span>{formatRelativeTime(commit.date)}</span>
												)}
											</div>
										</div>
									</label>
								))}
							</div>
						)}
					</div>
					<DialogFooter>
						<DialogClose
							render={<Button variant="outline" />}
							disabled={isTriggering}
						>
							Cancel
						</DialogClose>
						<Button
							onClick={handleDeployCommit}
							disabled={!selectedSha || isTriggering || Boolean(commitError)}
						>
							{isTriggering && <Loader2 className="size-4 animate-spin" />}
							Deploy commit
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
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
							<BuildStatusBadge
								status={build.status}
								className="max-sm:hidden"
							/>
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
									<BuildStatusBadge
										status={build.status}
										size="sm"
										className="mr-3 sm:hidden"
									/>
									<span className="inline-flex items-center gap-1">
										<GitBranch className="size-3" />
										{build.branch}
									</span>
									{build.author && (
										<span className="ml-3 max-sm:hidden">
											by {build.author}
										</span>
									)}
									<span className="ml-3">
										{formatRelativeTime(build.createdAt)}
									</span>
									{build.startedAt && (
										<span className="ml-3">
											<span className="max-sm:hidden">Duration: </span>
											{formatElapsedDurationBetween(
												build.startedAt,
												build.completedAt,
											)}
										</span>
									)}
								</ItemDescription>
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
