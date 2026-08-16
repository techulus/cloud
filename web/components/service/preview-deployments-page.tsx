"use client";

import { ExternalLinkIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	redeployPreview,
	removePreview,
	setPreviewDeploymentsEnabled,
} from "@/actions/previews";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

type Preview = {
	serviceId: string;
	pullRequestNumber: number;
	status: string;
	commitSha: string | null;
	url: string | null;
	error: string | null;
	updatedAt: string;
	expiresAt: string | null;
	title: string | null;
	author: string | null;
};

export function PreviewDeploymentsPage({
	serviceId,
	enabled,
	stateful,
	automaticDomain,
	repository,
	previews,
}: {
	serviceId: string;
	enabled: boolean;
	stateful: boolean;
	automaticDomain: string | null;
	repository: string;
	previews: Preview[];
}) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [isEnabled, setIsEnabled] = useState(enabled);

	useEffect(() => {
		if (
			!previews.some((preview) => !["ready", "failed"].includes(preview.status))
		) {
			return;
		}
		const interval = setInterval(() => router.refresh(), 10_000);
		return () => clearInterval(interval);
	}, [previews, router]);

	const updateEnabled = (nextEnabled: boolean) => {
		const previous = isEnabled;
		setIsEnabled(nextEnabled);
		startTransition(async () => {
			try {
				await setPreviewDeploymentsEnabled(serviceId, nextEnabled);
				toast.success(
					nextEnabled
						? "Preview deployments enabled"
						: "Preview teardown queued",
				);
				router.refresh();
			} catch (error) {
				setIsEnabled(previous);
				toast.error(error instanceof Error ? error.message : "Update failed");
			}
		});
	};

	const run = (action: () => Promise<unknown>, success: string) =>
		startTransition(async () => {
			try {
				await action();
				toast.success(success);
				router.refresh();
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Action failed");
			}
		});

	return (
		<div className="space-y-5">
			<div className="rounded-lg border bg-card p-5">
				<div className="flex items-start justify-between gap-4">
					<div className="space-y-1">
						<h1 className="text-lg font-semibold">Pull request previews</h1>
						<p className="max-w-2xl text-sm text-muted-foreground">
							Build every same-repository pull request that is ready for review
							at a stable generated URL. Each preview is one stateless replica
							and inherits this service&apos;s secrets. Drafts and forks are
							skipped.
						</p>
					</div>
					<Switch
						checked={isEnabled}
						onCheckedChange={updateEnabled}
						disabled={isPending || stateful || !automaticDomain}
						aria-label="Enable pull request preview deployments"
					/>
				</div>
				{stateful ? (
					<p className="mt-4 text-sm text-amber-600">
						Preview deployments are unavailable because volumes cannot be
						replicated. Use a stateless service to enable previews.
					</p>
				) : !automaticDomain ? (
					<p className="mt-4 text-sm text-amber-600">
						Configure Automatic Subdomain Domain and wildcard DNS before
						enabling previews.
					</p>
				) : (
					<p className="mt-4 text-xs text-muted-foreground">
						Preview URLs are generated beneath <code>{automaticDomain}</code>.
						Closing or merging a pull request removes its preview.
					</p>
				)}
			</div>

			<div className="rounded-lg border bg-card">
				<div className="border-b px-5 py-3">
					<h2 className="font-medium">Active previews</h2>
				</div>
				{previews.length === 0 ? (
					<p className="px-5 py-10 text-center text-sm text-muted-foreground">
						{isEnabled
							? "No eligible pull requests are open."
							: "Enable previews to deploy pull requests."}
					</p>
				) : (
					<div className="divide-y">
						{previews.map((preview) => (
							<div
								key={preview.serviceId}
								className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
							>
								<div className="min-w-0 space-y-1">
									<div className="flex items-center gap-2">
										<a
											href={`https://github.com/${repository}/pull/${preview.pullRequestNumber}`}
											target="_blank"
											rel="noreferrer"
											className="truncate text-sm font-medium hover:underline"
										>
											#{preview.pullRequestNumber} {preview.title}
										</a>
										<Badge
											variant={
												preview.status === "failed" ? "destructive" : "outline"
											}
											className={
												preview.status === "ready"
													? "border-emerald-500/40 text-emerald-600"
													: undefined
											}
										>
											{preview.status}
										</Badge>
									</div>
									<p className="text-xs text-muted-foreground">
										{preview.author ? `by ${preview.author} · ` : ""}
										{preview.commitSha?.slice(0, 7) ??
											"waiting for merge ref"}{" "}
										· updated {new Date(preview.updatedAt).toLocaleString()}
									</p>
									{preview.error ? (
										<p className="text-xs text-destructive">{preview.error}</p>
									) : null}
								</div>
								<div className="flex shrink-0 items-center gap-2">
									{preview.url ? (
										<Button
											variant="outline"
											size="sm"
											render={
												<a
													href={preview.url}
													target="_blank"
													rel="noreferrer"
													aria-label={`Open preview for pull request ${preview.pullRequestNumber}`}
												/>
											}
										>
											<ExternalLinkIcon /> Open
										</Button>
									) : null}
									<Button
										variant="outline"
										size="sm"
										disabled={isPending || !isEnabled}
										onClick={() =>
											run(
												() =>
													redeployPreview(serviceId, preview.pullRequestNumber),
												"Preview redeploy queued",
											)
										}
									>
										<RefreshCwIcon /> Redeploy
									</Button>
									<Button
										variant="destructive"
										size="sm"
										disabled={isPending}
										onClick={() =>
											run(
												() =>
													removePreview(serviceId, preview.pullRequestNumber),
												"Preview removal queued",
											)
										}
									>
										<Trash2Icon /> Remove
									</Button>
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
