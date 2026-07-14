"use client";

import {
	ArrowRight,
	CheckCircle2,
	Clock,
	GitCommitHorizontal,
	Loader2,
	RotateCcw,
	XCircle,
} from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import useSWRInfinite from "swr/infinite";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { RolloutStatus } from "@/db/types";
import { formatDateTime, formatRelativeTime } from "@/lib/date";
import { fetcher } from "@/lib/fetcher";
import type {
	ServiceRevisionChangelogItem,
	ServiceRevisionChangelogResponse,
} from "@/lib/service-revision-changes";

const STATUS_CONFIG: Record<
	RolloutStatus,
	{ label: string; icon: typeof Clock; className: string }
> = {
	queued: { label: "Queued", icon: Clock, className: "text-slate-600" },
	in_progress: {
		label: "In progress",
		icon: Loader2,
		className: "text-blue-600",
	},
	completed: {
		label: "Completed",
		icon: CheckCircle2,
		className: "text-emerald-600",
	},
	failed: { label: "Failed", icon: XCircle, className: "text-red-600" },
	rolled_back: {
		label: "Rolled back",
		icon: RotateCcw,
		className: "text-orange-600",
	},
};

function RolloutBadge({
	rollout,
	serviceId,
	projectSlug,
	envName,
}: {
	rollout: NonNullable<ServiceRevisionChangelogItem["rollout"]>;
	serviceId: string;
	projectSlug: string;
	envName: string;
}) {
	const config = STATUS_CONFIG[rollout.status] ?? {
		label: rollout.status,
		icon: Clock,
		className: "text-muted-foreground",
	};
	const Icon = config.icon;

	return (
		<Badge
			variant="outline"
			className={config.className}
			render={
				<Link
					href={`/dashboard/projects/${projectSlug}/${envName}/services/${serviceId}/rollouts/${rollout.id}`}
				/>
			}
		>
			<Icon
				className={rollout.status === "in_progress" ? "animate-spin" : ""}
			/>
			{config.label}
		</Badge>
	);
}

function ChangelogSkeleton() {
	return (
		<div className="mx-auto grid max-w-5xl gap-2">
			{[1, 2, 3].map((item) => (
				<div key={item} className="space-y-3 rounded-lg border p-4">
					<Skeleton className="h-5 w-52" />
					<Skeleton className="h-16 w-full" />
				</div>
			))}
		</div>
	);
}

function RevisionChanges({ item }: { item: ServiceRevisionChangelogItem }) {
	if (item.comparison.kind === "initial") {
		return (
			<p className="text-sm text-muted-foreground">
				Initial service configuration captured.
			</p>
		);
	}

	if (item.comparison.kind === "unavailable") {
		return (
			<p className="text-sm text-muted-foreground">
				Changes are unavailable for this revision format.
			</p>
		);
	}

	if (item.comparison.changes.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				No configuration changes — redeploy.
			</p>
		);
	}

	return (
		<div className="divide-y">
			{item.comparison.changes.map((change) => (
				<div
					key={`${change.field}:${change.from}:${change.to}`}
					className="grid gap-2 py-2.5 text-sm sm:grid-cols-[minmax(8rem,0.65fr)_minmax(0,1.35fr)] sm:gap-4"
				>
					<div className="font-medium text-foreground">{change.field}</div>
					<div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-muted-foreground">
						<span className="break-words">{change.from}</span>
						<ArrowRight className="size-3.5 shrink-0" />
						<span className="break-words text-foreground">{change.to}</span>
					</div>
				</div>
			))}
		</div>
	);
}

export function ChangelogHistory({
	serviceId,
	projectSlug,
	envName,
}: {
	serviceId: string;
	projectSlug: string;
	envName: string;
}) {
	const { data, error, isLoading, isValidating, mutate, size, setSize } =
		useSWRInfinite<ServiceRevisionChangelogResponse>(
			(pageIndex, previousPage) => {
				if (previousPage && !previousPage.nextCursor) return null;
				const cursor = pageIndex === 0 ? null : previousPage?.nextCursor;
				return `/api/services/${serviceId}/revisions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
			},
			fetcher,
			{
				refreshInterval: (pages) =>
					pages?.some((page) =>
						page.revisions.some(
							(revision) =>
								revision.rollout?.status === "queued" ||
								revision.rollout?.status === "in_progress",
						),
					)
						? 3000
						: 0,
				revalidateOnFocus: true,
			},
		);

	const revisions = useMemo(() => {
		const byId = new Map<string, ServiceRevisionChangelogItem>();
		for (const page of data ?? []) {
			for (const revision of page.revisions) byId.set(revision.id, revision);
		}
		return [...byId.values()];
	}, [data]);
	const hasMore = data?.[data.length - 1]?.nextCursor != null;
	const isLoadingMore = isValidating && Boolean(data?.[size - 1] === undefined);

	if (isLoading) return <ChangelogSkeleton />;

	if (error) {
		return (
			<Empty className="mx-auto max-w-5xl border py-12">
				<EmptyMedia variant="icon">
					<XCircle />
				</EmptyMedia>
				<EmptyTitle>Unable to load changelog</EmptyTitle>
				<EmptyDescription>
					Revision history could not be loaded. Try again.
				</EmptyDescription>
				<Button variant="outline" onClick={() => void mutate()}>
					Retry
				</Button>
			</Empty>
		);
	}

	return (
		<div className="mx-auto max-w-5xl">
			{revisions.length === 0 ? (
				<Empty className="border py-12">
					<EmptyMedia variant="icon">
						<GitCommitHorizontal />
					</EmptyMedia>
					<EmptyTitle>No revisions yet</EmptyTitle>
					<EmptyDescription>
						Deploy this service to create its first revision.
					</EmptyDescription>
				</Empty>
			) : (
				<div className="grid gap-2">
					{revisions.map((revision) => (
						<article
							key={revision.id}
							className="space-y-3 rounded-lg border p-4"
						>
							<div className="flex flex-wrap items-start justify-between gap-2">
								<div>
									<div className="font-medium">
										{revision.comparison.kind === "initial"
											? "Initial revision"
											: revision.comparison.kind === "changes" &&
													revision.comparison.changes.length === 0
												? "Redeployed"
												: "Configuration updated"}
									</div>
									<div
										className="text-xs text-muted-foreground"
										title={formatDateTime(revision.createdAt)}
									>
										{formatRelativeTime(revision.createdAt)} ·{" "}
										{revision.id.slice(0, 8)}
									</div>
								</div>
								{revision.rollout ? (
									<RolloutBadge
										rollout={revision.rollout}
										serviceId={serviceId}
										projectSlug={projectSlug}
										envName={envName}
									/>
								) : null}
							</div>
							<RevisionChanges item={revision} />
						</article>
					))}
				</div>
			)}

			{hasMore ? (
				<div className="flex justify-center pt-4">
					<Button
						variant="outline"
						disabled={isLoadingMore}
						onClick={() => void setSize(size + 1)}
					>
						{isLoadingMore ? <Loader2 className="animate-spin" /> : null}
						Load older revisions
					</Button>
				</div>
			) : null}
		</div>
	);
}
