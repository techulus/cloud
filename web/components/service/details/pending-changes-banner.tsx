"use client";

import { Rocket } from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useState } from "react";
import { useSWRConfig } from "swr";
import { triggerBuild } from "@/actions/builds";
import { deployService } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ServiceWithDetails as Service } from "@/db/types";
import type { ConfigChange } from "@/lib/service-config";

interface PendingChangesBannerProps {
	service: Service;
	changes: ConfigChange[];
	projectSlug: string;
	envName: string;
	onUpdate: () => void;
	barMode: string;
}

export const PendingChangesBanner = memo(function PendingChangesBanner({
	service,
	changes,
	projectSlug,
	envName,
	onUpdate,
	barMode,
}: PendingChangesBannerProps) {
	const router = useRouter();
	const { mutate } = useSWRConfig();
	const [isDeploying, setIsDeploying] = useState(false);

	const totalReplicas = service.configuredReplicas.reduce(
		(sum, r) => sum + r.count,
		0,
	);
	const hasNoDeployments = service.deployments.length === 0;
	const isGithubWithNoDeployments =
		service.sourceType === "github" && hasNoDeployments;

	const hasChanges = changes.length > 0;
	const showBanner =
		barMode === "ready" &&
		(hasChanges || (hasNoDeployments && totalReplicas > 0));

	const handleDeploy = async () => {
		setIsDeploying(true);
		try {
			if (isGithubWithNoDeployments) {
				await triggerBuild(service.id);
				router.push(
					`/dashboard/projects/${projectSlug}/${envName}/services/${service.id}/builds`,
				);
			} else {
				await deployService(service.id);
				await mutate(`/api/services/${service.id}/rollouts`);
			}
			onUpdate();
		} finally {
			setIsDeploying(false);
		}
	};

	return (
		<div
			className="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out"
			style={{
				gridTemplateRows: showBanner ? "1fr" : "0fr",
				opacity: showBanner ? 1 : 0,
			}}
		>
			<div className="overflow-hidden">
				<div className="mx-auto max-w-5xl rounded-b-lg border border-amber-500/40 border-t-0 bg-amber-500/5">
					<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
						<div className="flex items-center gap-2">
							<span className="size-2 rounded-full bg-amber-500" />
							<span className="text-sm font-medium">
								{hasChanges
									? `${changes.length} pending change${changes.length !== 1 ? "s" : ""}`
									: "Ready to deploy"}
							</span>
						</div>
						<Button
							size="sm"
							onClick={handleDeploy}
							disabled={isDeploying || totalReplicas === 0}
						>
							{isDeploying ? (
								<Spinner className="size-4" />
							) : (
								<Rocket className="size-4" data-icon="inline-start" />
							)}
							{isGithubWithNoDeployments ? "Build" : "Deploy"}
						</Button>
					</div>
					{hasChanges ? (
						<div className="space-y-1.5 border-amber-500/20 border-t px-3 py-2.5 font-mono text-sm">
							{changes.map((change, index) => (
								<div
									key={`${change.field}:${change.from}:${change.to}:${index}`}
									className="flex items-baseline justify-between gap-4"
								>
									<span className="shrink-0 text-muted-foreground">
										{change.field}
									</span>
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
					) : (
						<p className="border-amber-500/20 border-t px-3 py-2.5 text-sm text-muted-foreground">
							This service has no active deployments.
						</p>
					)}
				</div>
			</div>
		</div>
	);
});
