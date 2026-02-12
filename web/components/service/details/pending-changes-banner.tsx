"use client";

import { memo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Rocket } from "lucide-react";
import { deployService } from "@/actions/projects";
import { triggerBuild } from "@/actions/builds";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ConfigChange } from "@/lib/service-config";
import type { ServiceWithDetails as Service } from "@/db/types";

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
	const [isDeploying, setIsDeploying] = useState(false);

	const totalReplicas = service.autoPlace
		? service.replicas
		: service.configuredReplicas.reduce((sum, r) => sum + r.count, 0);
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
			<div className="overflow-hidden pb-4">
				<div className="rounded-lg border bg-card p-4">
					<div className="flex items-start justify-between gap-4">
						<div className="flex items-start gap-3 min-w-0">
							<div className="p-2 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
								<AlertTriangle className="size-4" />
							</div>
							<div className="min-w-0">
								<p className="font-medium text-foreground">
									{hasChanges
										? `${changes.length} pending change${changes.length !== 1 ? "s" : ""}`
										: "Ready to deploy"}
								</p>
								{hasChanges ? (
									<div className="mt-2 space-y-1.5">
										{changes.map((change, i) => (
											<div
												key={`change-${change.field}-${i}`}
												className="flex items-center gap-2 text-sm"
											>
												<span className="font-medium shrink-0 text-muted-foreground">
													{change.field}:
												</span>
												<span className="text-muted-foreground truncate">
													{change.from}
												</span>
												<ArrowRight className="size-3 shrink-0 text-muted-foreground" />
												<span className="text-foreground truncate">
													{change.to}
												</span>
											</div>
										))}
									</div>
								) : (
									<p className="text-sm text-muted-foreground mt-1">
										This service has no active deployments.
									</p>
								)}
							</div>
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
				</div>
			</div>
		</div>
	);
});
