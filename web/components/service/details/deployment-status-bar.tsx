"use client";

import { memo, useMemo, useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { FloatingBar } from "@/components/ui/floating-bar";
import { deployService, abortRollout } from "@/actions/projects";
import { triggerBuild } from "@/actions/builds";
import type { ConfigChange } from "@/lib/service-config";
import type {
	DeploymentStatus,
	ServiceWithDetails as Service,
} from "@/db/types";

type StageInfo = {
	id: string;
	label: string;
};

const STAGES: StageInfo[] = [
	{ id: "migrating", label: "Migrating" },
	{ id: "deploying", label: "Starting" },
	{ id: "health_check", label: "Checking Health" },
	{ id: "completed", label: "Complete" },
];

const MIGRATION_STAGES: Record<string, string> = {
	stopping: "Stopping service",
	backing_up: "Creating backup",
	restoring: "Restoring volumes",
	starting: "Starting on new server",
	failed: "Migration failed",
};

function mapDeploymentStatusToStage(status: DeploymentStatus): string {
	switch (status) {
		case "pending":
		case "pulling":
			return "deploying";
		case "starting":
		case "healthy":
			return "health_check";
		case "running":
			return "completed";
		default:
			return "deploying";
	}
}

function getStageIndex(stageId: string): number {
	return STAGES.findIndex((s) => s.id === stageId);
}

type BarState =
	| { mode: "building"; buildId: string; buildStatus: string }
	| { mode: "deploying"; stage: string; stageIndex: number; rolloutId: string }
	| { mode: "ready"; hasChanges: boolean; changesCount: number }
	| { mode: "hidden" };

const ACTIVE_BUILD_STATUSES = [
	"pending",
	"claimed",
	"cloning",
	"building",
	"pushing",
];

function getBarState(service: Service, changes: ConfigChange[]): BarState {
	// Migration takes precedence over builds and deployments
	if (service.migrationStatus) {
		return {
			mode: "deploying",
			stage: "migrating",
			stageIndex: 0,
			rolloutId: "",
		};
	}

	if (
		service.latestBuild &&
		ACTIVE_BUILD_STATUSES.includes(service.latestBuild.status)
	) {
		return {
			mode: "building",
			buildId: service.latestBuild.id,
			buildStatus: service.latestBuild.status,
		};
	}

	const activeRollout = service.rollouts?.find(
		(r) => r.status === "in_progress",
	);

	if (activeRollout) {
		let currentStage = activeRollout.currentStage || "deploying";

		const rolloutDeployments = service.deployments.filter(
			(d) => d.rolloutId === activeRollout.id,
		);

		if (rolloutDeployments.length > 0) {
			const statuses = rolloutDeployments.map((d) => d.status);

			if (statuses.every((s) => s === "running")) {
				currentStage = "completed";
			} else if (statuses.some((s) => s === "healthy" || s === "starting")) {
				currentStage = "health_check";
			} else if (statuses.some((s) => s === "pending" || s === "pulling")) {
				currentStage = "deploying";
			}
		}

		return {
			mode: "deploying",
			stage: currentStage,
			stageIndex: getStageIndex(currentStage),
			rolloutId: activeRollout.id,
		};
	}

	const inProgressStatuses = [
		"pending",
		"pulling",
		"starting",
		"healthy",
		"stopping",
	];
	const hasInProgressDeployments = service.deployments.some((d) =>
		inProgressStatuses.includes(d.status),
	);

	if (hasInProgressDeployments) {
		const maxStageIndex = Math.max(
			...service.deployments
				.filter((d) => inProgressStatuses.includes(d.status))
				.map((d) => getStageIndex(mapDeploymentStatusToStage(d.status))),
		);
		return {
			mode: "deploying",
			stage: STAGES[maxStageIndex]?.id || "deploying",
			stageIndex: maxStageIndex,
			rolloutId: "",
		};
	}

	const totalReplicas = service.autoPlace
		? service.replicas
		: service.configuredReplicas.reduce((sum, r) => sum + r.count, 0);
	const hasNoDeployments = service.deployments.length === 0;
	const hasChanges = changes.length > 0;

	if (hasChanges || (hasNoDeployments && totalReplicas > 0)) {
		return {
			mode: "ready",
			hasChanges,
			changesCount: changes.length,
		};
	}

	return { mode: "hidden" };
}

function PendingChangesModal({
	changes,
	isOpen,
	onClose,
	onDeploy,
	isDeploying,
	canDeploy,
}: {
	changes: ConfigChange[];
	isOpen: boolean;
	onClose: () => void;
	onDeploy: () => void;
	isDeploying: boolean;
	canDeploy: boolean;
}) {
	if (!isOpen) return null;

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Pending Changes</DialogTitle>
				</DialogHeader>
				<div className="space-y-3 max-h-[60vh] overflow-y-auto">
					{changes.map((change, i) => (
						<div
							key={`change-${change.field}-${i}`}
							className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 p-3 bg-muted rounded-md text-sm"
						>
							<span className="font-medium shrink-0">{change.field}:</span>
							<div className="flex items-center gap-2 min-w-0">
								<span className="text-muted-foreground truncate">
									{change.from}
								</span>
								<ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
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
						variant="positive"
						onClick={onDeploy}
						disabled={isDeploying || !canDeploy}
					>
						{isDeploying ? "Deploying..." : `Deploy Now`}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export const DeploymentStatusBar = memo(function DeploymentStatusBar({
	service,
	changes,
	projectSlug,
	envName,
	onUpdate,
}: {
	service: Service;
	changes: ConfigChange[];
	projectSlug: string;
	envName: string;
	onUpdate: () => void;
}) {
	const router = useRouter();
	const [showModal, setShowModal] = useState(false);
	const [isDeploying, setIsDeploying] = useState(false);
	const [isAborting, setIsAborting] = useState(false);
	const barState = useMemo(
		() => getBarState(service, changes),
		[service, changes],
	);

	const prevBarStateRef = useRef<BarState["mode"]>(barState.mode);
	const toastShownForRolloutRef = useRef<string | null>(null);

	useEffect(() => {
		const wasDeploying = prevBarStateRef.current === "deploying";
		prevBarStateRef.current = barState.mode;

		if (!wasDeploying) return;

		if (barState.mode === "ready" || barState.mode === "hidden") {
			const latestRollout = service.rollouts?.[0];
			if (!latestRollout || toastShownForRolloutRef.current === latestRollout.id) {
				return;
			}

			toastShownForRolloutRef.current = latestRollout.id;

			if (latestRollout.status === "completed") {
				toast.success("Deployment completed successfully");
			} else if (latestRollout.status === "failed") {
				toast.error("Deployment failed");
			} else if (latestRollout.status === "rolled_back") {
				toast.error("Deployment rolled back");
			}
		}
	}, [barState.mode, service.rollouts]);

	const totalReplicas = service.autoPlace
		? service.replicas
		: service.configuredReplicas.reduce((sum, r) => sum + r.count, 0);
	const hasNoDeployments = service.deployments.length === 0;
	const isGithubWithNoDeployments =
		service.sourceType === "github" && hasNoDeployments;

	const handleDeploy = async () => {
		setIsDeploying(true);
		try {
			if (isGithubWithNoDeployments) {
				const result = await triggerBuild(service.id);
				if (result.buildId) {
					router.push(
						`/dashboard/projects/${projectSlug}/${envName}/services/${service.id}/builds/${result.buildId}`,
					);
				}
			} else {
				await deployService(service.id);
				router.push(
					`/dashboard/projects/${projectSlug}/${envName}/services/${service.id}`,
				);
			}
			onUpdate();
			setShowModal(false);
		} finally {
			setIsDeploying(false);
		}
	};

	const handleAbort = async () => {
		setIsAborting(true);
		try {
			await abortRollout(service.id);
			onUpdate();
		} finally {
			setIsAborting(false);
		}
	};

	if (barState.mode === "hidden") {
		return null;
	}

	if (barState.mode === "building") {
		const statusLabels: Record<string, string> = {
			pending: "Queued",
			claimed: "Starting",
			cloning: "Cloning",
			building: "Building",
			pushing: "Pushing",
		};

		return (
			<FloatingBar
				visible
				loading
				status={statusLabels[barState.buildStatus] || "Building"}
				action={
					<button
						type="button"
						onClick={() =>
							router.push(
								`/dashboard/projects/${projectSlug}/${envName}/services/${service.id}/builds/${barState.buildId}`,
							)
						}
						className="text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors"
					>
						View Logs
					</button>
				}
			/>
		);
	}

	if (barState.mode === "deploying") {
		const currentStage = STAGES[barState.stageIndex];
		const isMigrating = !!service.migrationStatus;

		let status = currentStage?.label || "Deploying";
		if (isMigrating && service.migrationStatus) {
			status =
				MIGRATION_STAGES[service.migrationStatus] ||
				service.migrationStatus ||
				"Migrating";
		}

		return (
			<FloatingBar
				visible
				loading
				status={status}
				action={
					isMigrating ? null : (
						<button
							type="button"
							onClick={handleAbort}
							disabled={isAborting}
							className="text-sm font-medium text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
						>
							{isAborting ? "..." : "Abort"}
						</button>
					)
				}
			/>
		);
	}

	return (
		<>
			<FloatingBar
				visible
				status={
					barState.hasChanges
						? `${barState.changesCount} change${barState.changesCount !== 1 ? "s" : ""}`
						: "Ready to deploy"
				}
				action={
					<div className="flex items-center gap-3">
						{barState.hasChanges && (
							<button
								type="button"
								onClick={() => setShowModal(true)}
								className="text-sm font-medium text-white/70 hover:text-white transition-colors"
							>
								View
							</button>
						)}
						<button
							type="button"
							onClick={handleDeploy}
							disabled={isDeploying || totalReplicas === 0}
							className="text-sm font-medium text-emerald-400 hover:text-emerald-300 transition-colors disabled:opacity-50"
						>
							{isDeploying ? "..." : "Deploy"}
						</button>
					</div>
				}
			/>
			<PendingChangesModal
				changes={changes}
				isOpen={showModal}
				onClose={() => setShowModal(false)}
				onDeploy={handleDeploy}
				isDeploying={isDeploying}
				canDeploy={totalReplicas > 0}
			/>
		</>
	);
});
