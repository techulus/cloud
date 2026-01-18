"use client";

import {
	AlertCircle,
	ArrowLeft,
	CheckCircle2,
	CircleDashed,
	Clock,
	ExternalLink,
	GitBranch,
	Loader2,
	RotateCcw,
	XCircle,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { cancelBuild, retryBuild } from "@/actions/builds";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemTitle,
} from "@/components/ui/item";
import type { Build, BuildStatus, GithubRepo, Service } from "@/db/types";
import { formatRelativeTime } from "@/lib/date";
import { fetcher } from "@/lib/fetcher";
import { LogViewer } from "@/components/logs/log-viewer";

type BuildWithDates = Omit<
	Build,
	"createdAt" | "startedAt" | "completedAt" | "claimedAt"
> & {
	createdAt: string | Date;
	startedAt: string | Date | null;
	completedAt: string | Date | null;
	claimedAt: string | Date | null;
};

const STATUS_CONFIG: Record<
	BuildStatus,
	{
		icon: typeof CheckCircle2;
		color: string;
		bgColor: string;
		label: string;
	}
> = {
	pending: {
		icon: Clock,
		color: "text-slate-500",
		bgColor: "bg-slate-500/10",
		label: "Queued",
	},
	claimed: {
		icon: CircleDashed,
		color: "text-blue-500",
		bgColor: "bg-blue-500/10",
		label: "Starting",
	},
	cloning: {
		icon: Loader2,
		color: "text-blue-500",
		bgColor: "bg-blue-500/10",
		label: "Cloning",
	},
	building: {
		icon: Loader2,
		color: "text-blue-500",
		bgColor: "bg-blue-500/10",
		label: "Building",
	},
	pushing: {
		icon: Loader2,
		color: "text-blue-500",
		bgColor: "bg-blue-500/10",
		label: "Pushing",
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
	cancelled: {
		icon: AlertCircle,
		color: "text-slate-500",
		bgColor: "bg-slate-500/10",
		label: "Cancelled",
	},
};

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

export function BuildDetails({
	projectSlug,
	envName,
	service,
	build: initialBuild,
	githubRepo,
}: {
	projectSlug: string;
	envName: string;
	service: Pick<Service, "id" | "name">;
	build: BuildWithDates;
	githubRepo: Pick<GithubRepo, "id" | "repoFullName"> | null;
}) {
	const router = useRouter();
	const [isCancelling, setIsCancelling] = useState(false);
	const [isRetrying, setIsRetrying] = useState(false);

	const { data } = useSWR<{ build: BuildWithDates }>(
		`/api/builds/${initialBuild.id}`,
		fetcher,
		{
			fallbackData: { build: initialBuild },
			refreshInterval: isActiveBuild(initialBuild.status) ? 1500 : 0,
		},
	);

	const build = data?.build || initialBuild;
	const config = STATUS_CONFIG[build.status];
	const Icon = config.icon;
	const isAnimated = ["cloning", "building", "pushing"].includes(build.status);

	const handleCancel = async () => {
		setIsCancelling(true);
		try {
			await cancelBuild(build.id);
			toast.success("Build cancelled");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to cancel build",
			);
		} finally {
			setIsCancelling(false);
		}
	};

	const handleRetry = async () => {
		setIsRetrying(true);
		try {
			const result = await retryBuild(build.id);
			toast.success("Build queued");
			router.push(
				`/dashboard/projects/${projectSlug}/${envName}/services/${service.id}/builds/${result.buildId}`,
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to retry build",
			);
		} finally {
			setIsRetrying(false);
		}
	};

	const canCancel = [
		"pending",
		"claimed",
		"cloning",
		"building",
		"pushing",
	].includes(build.status);
	const canRetry = ["failed", "cancelled"].includes(build.status);

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-4">
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={() =>
						router.push(
							`/dashboard/projects/${projectSlug}/${envName}/services/${service.id}/builds`,
						)
					}
				>
					<ArrowLeft className="size-4" />
				</Button>
				<div className="flex-1">
					<div className="flex items-center gap-3">
						<span
							className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium ${config.color} ${config.bgColor}`}
						>
							<Icon className={`size-4 ${isAnimated ? "animate-spin" : ""}`} />
							{config.label}
						</span>
						<code className="font-mono text-sm">
							{build.commitSha.slice(0, 7)}
						</code>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{canCancel && (
						<Button
							variant="outline"
							size="sm"
							onClick={handleCancel}
							disabled={isCancelling}
						>
							{isCancelling ? (
								<Loader2 className="size-4 mr-1.5 animate-spin" />
							) : (
								<XCircle className="size-4 mr-1.5" />
							)}
							Cancel
						</Button>
					)}
					{canRetry && (
						<Button
							variant="outline"
							size="sm"
							onClick={handleRetry}
							disabled={isRetrying}
						>
							{isRetrying ? (
								<Loader2 className="size-4 mr-1.5 animate-spin" />
							) : (
								<RotateCcw className="size-4 mr-1.5" />
							)}
							Retry
						</Button>
					)}
				</div>
			</div>

			<div className="grid gap-4 md:grid-cols-2">
				<Item variant="outline">
					<ItemContent>
						<ItemTitle>
							<code className="font-mono text-sm">
								{build.commitSha.slice(0, 7)}
							</code>
							{githubRepo && (
								<Link
									href={`https://github.com/${githubRepo.repoFullName}/commit/${build.commitSha}`}
									target="_blank"
									className="text-muted-foreground hover:text-foreground"
								>
									<ExternalLink className="size-3.5" />
								</Link>
							)}
						</ItemTitle>
						<ItemDescription>
							{build.commitMessage?.split("\n")[0] || "No message"}
						</ItemDescription>
						<div className="flex items-center gap-4 text-xs text-muted-foreground mt-1">
							<span className="flex items-center gap-1">
								<GitBranch className="size-3" />
								{build.branch}
							</span>
							{build.author && <span>by {build.author}</span>}
						</div>
					</ItemContent>
				</Item>

				<Item variant="outline">
					<ItemContent>
						<ItemTitle>Timing</ItemTitle>
						<ItemDescription as="div" className="space-y-1">
							<div className="flex justify-between">
								<span>Created</span>
								<span>{formatRelativeTime(build.createdAt)}</span>
							</div>
							{build.startedAt && (
								<div className="flex justify-between">
									<span>Started</span>
									<span>{formatRelativeTime(build.startedAt)}</span>
								</div>
							)}
							{build.startedAt && (
								<div className="flex justify-between">
									<span>Duration</span>
									<span>
										{formatDuration(build.startedAt, build.completedAt)}
									</span>
								</div>
							)}
						</ItemDescription>
					</ItemContent>
				</Item>
			</div>

			{build.error && (
				<Alert variant="destructive">
					<XCircle className="size-4" />
					<AlertTitle>Build Failed</AlertTitle>
					<AlertDescription>{build.error}</AlertDescription>
				</Alert>
			)}

			<div className="space-y-2">
				<h3 className="text-sm font-medium">Build Logs</h3>
				<LogViewer
					variant="build-logs"
					buildId={build.id}
					isLive={isActiveBuild(build.status)}
				/>
			</div>
		</div>
	);
}

function isActiveBuild(status: BuildStatus): boolean {
	return ["pending", "claimed", "cloning", "building", "pushing"].includes(
		status,
	);
}
