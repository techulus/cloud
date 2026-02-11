"use client";

import { memo, useMemo, useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { abortRollout } from "@/actions/projects";
import { cancelMigration } from "@/actions/migrations";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
	{ id: "dns_sync", label: "Routing traffic" },
	{ id: "completed", label: "Complete" },
];

const MIGRATION_STAGES: Record<string, string> = {
	stopping: "Stopping service",
	backing_up: "Creating backup",
	restoring: "Restoring volumes",
	starting: "Starting on new server",
	failed: "Migration failed",
};

const ACTIVE_BUILD_STATUSES = [
	"pending",
	"claimed",
	"cloning",
	"building",
	"pushing",
];

const BUILD_STATUS_LABELS: Record<string, string> = {
	pending: "Queued",
	claimed: "Starting",
	cloning: "Cloning",
	building: "Building",
	pushing: "Pushing",
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

export function getBarState(
	service: Service,
	changes: ConfigChange[],
): BarState {
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

	const latestRollout = service.rollouts?.[0];
	const activeRollout =
		latestRollout?.status === "in_progress" ? latestRollout : undefined;

	if (activeRollout) {
		const currentStage = activeRollout.currentStage || "deploying";
		return {
			mode: "deploying",
			stage: currentStage,
			stageIndex: getStageIndex(currentStage),
			rolloutId: activeRollout.id,
		};
	}

	const latestRolloutJustCompleted =
		latestRollout?.status === "completed" ||
		latestRollout?.status === "rolled_back" ||
		latestRollout?.status === "failed";

	if (!latestRolloutJustCompleted) {
		const inProgressStatuses = ["pending", "pulling", "starting", "healthy"];
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

interface DeploymentProgressProps {
	service: Service;
	changes: ConfigChange[];
	projectSlug: string;
	envName: string;
	onUpdate: () => void;
}

export const DeploymentProgress = memo(function DeploymentProgress({
	service,
	changes,
	projectSlug,
	envName,
	onUpdate,
}: DeploymentProgressProps) {
	const router = useRouter();
	const [isAborting, setIsAborting] = useState(false);
	const [isCancellingMigration, setIsCancellingMigration] = useState(false);

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
			if (
				!latestRollout ||
				toastShownForRolloutRef.current === latestRollout.id
			) {
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

	const handleAbort = async () => {
		setIsAborting(true);
		try {
			await abortRollout(service.id);
			onUpdate();
		} finally {
			setIsAborting(false);
		}
	};

	const handleCancelMigration = async () => {
		setIsCancellingMigration(true);
		try {
			await cancelMigration(service.id);
			toast.success("Migration cancelled");
			onUpdate();
		} catch (e) {
			toast.error(
				e instanceof Error ? e.message : "Failed to cancel migration",
			);
		} finally {
			setIsCancellingMigration(false);
		}
	};

	const isVisible =
		barState.mode === "building" || barState.mode === "deploying";

	let content: React.ReactNode = null;

	if (barState.mode === "building") {
		content = (
			<div className="rounded-lg border bg-card p-4">
				<div className="flex items-center justify-between gap-4">
					<div className="flex items-center gap-3">
						<div className="p-2 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400">
							<Loader2 className="size-4 animate-spin" />
						</div>
						<div>
							<p className="font-medium text-foreground">Building</p>
							<p className="text-sm text-muted-foreground">
								{BUILD_STATUS_LABELS[barState.buildStatus] || "Building"}
							</p>
						</div>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							router.push(
								`/dashboard/projects/${projectSlug}/${envName}/services/${service.id}/builds/${barState.buildId}`,
							)
						}
					>
						View Logs
					</Button>
				</div>
			</div>
		);
	}

	if (barState.mode === "deploying") {
		const currentStage = STAGES[barState.stageIndex];
		const isMigrating = !!service.migrationStatus;
		const isMigrationFailed = service.migrationStatus === "failed";

		let status = currentStage?.label || "Deploying";
		if (isMigrating && service.migrationStatus) {
			status =
				MIGRATION_STAGES[service.migrationStatus] ||
				service.migrationStatus ||
				"Migrating";
		}

		content = (
			<div className="rounded-lg border bg-card p-4">
				<div className="flex items-center justify-between gap-4">
					<div className="flex items-center gap-3">
						{isMigrationFailed ? (
							<div className="p-2 rounded-md bg-rose-500/10 text-rose-600 dark:text-rose-400">
								<XCircle className="size-4" />
							</div>
						) : (
							<div className="p-2 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400">
								<Loader2 className="size-4 animate-spin" />
							</div>
						)}
						<div>
							<p className="font-medium text-foreground">
								{isMigrating ? "Migrating" : "Deploying"}
							</p>
							<p className="text-sm text-muted-foreground">{status}</p>
						</div>
					</div>
					{isMigrating ? (
						<Button
							variant="outline"
							size="sm"
							onClick={handleCancelMigration}
							disabled={isCancellingMigration}
						>
							{isCancellingMigration ? <Spinner /> : "Cancel"}
						</Button>
					) : (
						<Button
							variant="outline"
							size="sm"
							onClick={handleAbort}
							disabled={isAborting}
						>
							{isAborting ? <Spinner /> : "Abort"}
						</Button>
					)}
				</div>
			</div>
		);
	}

	return (
		<div
			className="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out"
			style={{
				gridTemplateRows: isVisible ? "1fr" : "0fr",
				opacity: isVisible ? 1 : 0,
			}}
		>
			<div className="overflow-hidden pb-4">{content}</div>
		</div>
	);
});
