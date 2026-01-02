"use client";

import { useRouter } from "next/navigation";
import { useState, memo } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { FloatingBar } from "@/components/ui/floating-bar";
import { ArrowRight, Loader2 } from "lucide-react";
import { deployService, type ServerPlacement } from "@/actions/projects";
import { triggerBuild } from "@/actions/builds";
import type { ConfigChange } from "@/lib/service-config";
import type { ServiceWithDetails as Service } from "@/db/types";

function PendingChangesModal({
	changes,
	isOpen,
	onClose,
	onDeploy,
	isDeploying,
	canDeploy,
	isBuild,
}: {
	changes: ConfigChange[];
	isOpen: boolean;
	onClose: () => void;
	onDeploy: () => void;
	isDeploying: boolean;
	canDeploy: boolean;
	isBuild?: boolean;
}) {
	if (!isOpen) return null;

	const actionLabel = isBuild ? "Build" : "Deploy";
	const actioningLabel = isBuild ? "Building..." : "Deploying...";

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Pending Changes</DialogTitle>
				</DialogHeader>
				<div className="space-y-3 max-h-[60vh] overflow-y-auto">
					{changes.map((change, i) => (
						<div
							key={i}
							className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 p-3 bg-muted rounded-md text-sm"
						>
							<span className="font-medium flex-shrink-0">{change.field}:</span>
							<div className="flex items-center gap-2 min-w-0">
								<span className="text-muted-foreground truncate">
									{change.from}
								</span>
								<ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
								<span className="text-foreground truncate">{change.to}</span>
							</div>
						</div>
					))}
				</div>
				<div className="flex justify-end gap-2 pt-4">
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button
						onClick={onDeploy}
						disabled={isDeploying || !canDeploy}
						className="bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white"
					>
						{isDeploying ? actioningLabel : `${actionLabel} Now`}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function hasActiveRollout(service: Service): boolean {
	const hasInProgressRollout = service.rollouts?.some(
		(r) => r.status === "in_progress",
	);
	if (hasInProgressRollout) return true;

	const inProgressStatuses = [
		"pending",
		"pulling",
		"starting",
		"healthy",
		"dns_updating",
		"caddy_updating",
		"stopping_old",
		"stopping",
	];
	return service.deployments.some((d) => inProgressStatuses.includes(d.status));
}

export const PendingChangesBar = memo(function PendingChangesBar({
	changes,
	service,
	projectSlug,
	onUpdate,
}: {
	changes: ConfigChange[];
	service: Service;
	projectSlug: string;
	onUpdate: () => void;
}) {
	const router = useRouter();
	const [showModal, setShowModal] = useState(false);
	const [isDeploying, setIsDeploying] = useState(false);

	const totalReplicas = service.configuredReplicas.reduce(
		(sum, r) => sum + r.count,
		0,
	);
	const hasNoDeployments = service.deployments.length === 0;
	const hasChanges = changes.length > 0;
	const rolloutActive = hasActiveRollout(service);

	const showBar =
		!rolloutActive && (hasChanges || (hasNoDeployments && totalReplicas > 0));

	const isGithubWithNoDeployments =
		service.sourceType === "github" && hasNoDeployments;

	const handleDeploy = async () => {
		setIsDeploying(true);
		try {
			if (isGithubWithNoDeployments) {
				const result = await triggerBuild(service.id);
				if (result.buildId) {
					router.push(
						`/dashboard/projects/${projectSlug}/services/${service.id}/builds/${result.buildId}`,
					);
				}
			} else {
				const placements: ServerPlacement[] = service.configuredReplicas.map(
					(r) => ({
						serverId: r.serverId,
						replicas: r.count,
					}),
				);
				await deployService(service.id, placements);
			}
			onUpdate();
			setShowModal(false);
		} finally {
			setIsDeploying(false);
		}
	};

	return (
		<>
			<FloatingBar visible={showBar} variant="success">
				<span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
					{hasChanges
						? `${changes.length} change${changes.length !== 1 ? "s" : ""}`
						: "Ready to deploy"}
				</span>

				{hasChanges && (
					<button
						onClick={() => setShowModal(true)}
						className="text-sm text-emerald-600 dark:text-emerald-400 hover:underline"
					>
						View
					</button>
				)}

				<button
					onClick={handleDeploy}
					disabled={isDeploying || totalReplicas === 0}
					className="px-3 py-1 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white rounded-full disabled:opacity-50 transition-colors"
				>
					{isDeploying ? (
						<Loader2 className="h-4 w-4 animate-spin" />
					) : isGithubWithNoDeployments ? (
						"Build"
					) : (
						"Deploy"
					)}
				</button>
			</FloatingBar>
			<PendingChangesModal
				changes={changes}
				isOpen={showModal}
				onClose={() => setShowModal(false)}
				onDeploy={handleDeploy}
				isDeploying={isDeploying}
				canDeploy={totalReplicas > 0}
				isBuild={isGithubWithNoDeployments}
			/>
		</>
	);
});
