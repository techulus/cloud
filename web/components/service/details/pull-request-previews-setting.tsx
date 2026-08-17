"use client";

import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";
import { setPreviewDeploymentsEnabled } from "@/actions/previews";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ServiceWithDetails as Service } from "@/db/types";
import { pullRequestNumberFromMergeRef } from "@/lib/service-revision-spec";

function previewPullRequestNumber(previewGitRef: string | null) {
	if (!previewGitRef) return null;
	try {
		return pullRequestNumberFromMergeRef(previewGitRef);
	} catch {
		return null;
	}
}

export function PullRequestPreviewsSetting({
	service,
	projectSlug,
	autoSubdomainDomain,
	onUpdate,
}: {
	service: Service;
	projectSlug: string;
	autoSubdomainDomain: string | null;
	onUpdate?: () => void;
}) {
	const [isPending, startTransition] = useTransition();
	const pullRequestNumber = previewPullRequestNumber(service.previewGitRef);

	if (service.previewOfService && pullRequestNumber) {
		return (
			<div className="rounded-md border p-3 text-sm">
				<p className="font-medium">
					Preview source:{" "}
					<a
						href={`${service.githubRepoUrl}/pull/${pullRequestNumber}`}
						target="_blank"
						rel="noreferrer"
						className="text-primary hover:underline"
					>
						PR #{pullRequestNumber}
					</a>
				</p>
				<code className="text-xs text-muted-foreground">
					{service.previewGitRef}
				</code>
			</div>
		);
	}
	if (!service.hasGithubAppRepo) return null;

	const updateEnabled = (enabled: boolean) => {
		startTransition(async () => {
			try {
				await setPreviewDeploymentsEnabled(service.id, enabled);
				toast.success(
					enabled ? "Pull request previews enabled" : "Preview teardown queued",
				);
				onUpdate?.();
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Update failed");
			}
		});
	};

	return (
		<div className="flex items-start justify-between gap-4 rounded-md border p-3">
			<div className="space-y-1">
				<Label htmlFor="pull-request-previews">Pull Request Previews</Label>
				<p className="text-xs text-muted-foreground">
					Deploy same-repository pull requests that are ready for review as
					visible services in{" "}
					{service.previewDeploymentsEnabled ? (
						<Link
							href={`/dashboard/projects/${projectSlug}/previews`}
							className="text-primary hover:underline"
						>
							the previews environment
						</Link>
					) : (
						"a previews environment"
					)}
					. Secrets are copied when each service is created.
				</p>
				{service.stateful ? (
					<p className="text-xs text-amber-600">
						Preview deployments require a stateless service.
					</p>
				) : !autoSubdomainDomain ? (
					<p className="text-xs text-amber-600">
						Configure Automatic Subdomain Domain to give previews public URLs.
					</p>
				) : null}
			</div>
			<Switch
				id="pull-request-previews"
				checked={service.previewDeploymentsEnabled}
				onCheckedChange={updateEnabled}
				disabled={isPending || service.stateful}
				aria-label="Enable pull request preview deployments"
			/>
		</div>
	);
}
