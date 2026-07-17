"use client";

import {
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
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
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

	return (
		<StatusBadge
			icon={config.icon}
			label={config.label}
			isAnimated={rollout.status === "in_progress"}
			className={config.className}
			render={
				<Link
					href={`/dashboard/projects/${projectSlug}/${envName}/services/${serviceId}/rollouts/${rollout.id}`}
				/>
			}
		/>
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
		<div className="space-y-1.5 font-mono text-sm">
			{item.comparison.changes.map((change) => (
				<div
					key={`${change.field}:${change.from}:${change.to}`}
					className="flex items-baseline justify-between gap-4"
				>
					<span className="shrink-0 text-muted-foreground">{change.field}</span>
					<span className="flex min-w-0 items-baseline justify-end gap-1.5">
						<span
							className="truncate text-muted-foreground"
							title={change.from}
						>
							{change.from}
						</span>
						<span className="shrink-0 text-muted-foreground">→</span>
						<span className="truncate font-medium" title={change.to}>
							{change.to}
						</span>
					</span>
				</div>
			))}
		</div>
	);
}

function actorByline(item: ServiceRevisionChangelogItem): string {
	if (item.actor?.type === "user") return `by ${item.actor.name}`;
	if (item.actor?.type === "github")
		return `by @${item.actor.login} via GitHub`;
	if (item.actor?.type === "system") return "by System";
	return "actor unknown";
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
				<div>
					{revisions.map((revision, index) => (
						<article key={revision.id} className="relative pb-6 pl-6 last:pb-0">
							{index < revisions.length - 1 ? (
								<span className="absolute top-5 -bottom-1 left-[3.5px] w-px bg-border" />
							) : null}
							<div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
								<span className="-left-6 absolute top-1/2 size-2 -translate-y-1/2 rounded-full bg-muted-foreground/40" />
								<div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
									<span className="text-sm">
										{revision.comparison.kind === "initial"
											? "Initial revision"
											: revision.comparison.kind === "changes" &&
													revision.comparison.changes.length === 0
												? "Redeployed"
												: "Configuration updated"}
									</span>
									<span
										className="text-xs text-muted-foreground"
										title={formatDateTime(revision.createdAt)}
									>
										{formatRelativeTime(revision.createdAt)} ·{" "}
										{revision.id.slice(0, 8)}
										{" · "}
										{actorByline(revision)}
									</span>
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
							<div className="mt-2 rounded-md border px-3 py-2.5">
								<RevisionChanges item={revision} />
							</div>
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
