"use client";

import { useRouter } from "next/navigation";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { cancelMigration } from "@/actions/migrations";
import { abortRollout } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type {
	DeploymentStatus,
	ServiceWithDetails as Service,
} from "@/db/types";
import {
	type ConfigChange,
	getServiceTotalReplicas,
} from "@/lib/service-config";
import { cn } from "@/lib/utils";

type StageInfo = {
	id: string;
	label: string;
};

const STAGES: StageInfo[] = [
	{ id: "migrating", label: "Migrating" },
	{ id: "queued", label: "Queued" },
	{ id: "deploying", label: "Starting" },
	{ id: "health_check", label: "Checking Health" },
	{ id: "dns_sync", label: "Routing traffic" },
	{ id: "completed", label: "Complete" },
];

const MIGRATION_STAGES: Record<string, string> = {
	stopping: "Stopping service",
	backing_up: "Creating backup",
	restoring: "Restoring volumes",
	deploying_target: "Starting on new server",
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
		latestRollout?.status === "queued" ||
		latestRollout?.status === "in_progress"
			? latestRollout
			: undefined;

	if (activeRollout) {
		const currentStage =
			activeRollout.status === "queued"
				? "queued"
				: activeRollout.currentStage || "deploying";
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
			inProgressStatuses.includes(d.observedPhase),
		);

		if (hasInProgressDeployments) {
			const maxStageIndex = Math.max(
				...service.deployments
					.filter((d) => inProgressStatuses.includes(d.observedPhase))
					.map((d) =>
						getStageIndex(mapDeploymentStatusToStage(d.observedPhase)),
					),
			);
			return {
				mode: "deploying",
				stage: STAGES[maxStageIndex]?.id || "deploying",
				stageIndex: maxStageIndex,
				rolloutId: "",
			};
		}
	}

	const totalReplicas = getServiceTotalReplicas(service);
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

function StageProgress({ current, total }: { current: number; total: number }) {
	const progress = total > 0 ? Math.min((current + 1) / total, 1) : 0;

	return (
		<div className="h-0.5 w-full bg-border/60">
			<div
				className="h-full bg-blue-500 transition-[width] duration-500 ease-out"
				style={{ width: `${progress * 100}%` }}
			/>
		</div>
	);
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
		const buildStageIndex = ACTIVE_BUILD_STATUSES.indexOf(barState.buildStatus);

		content = (
			<div className="mx-auto mt-2 max-w-5xl overflow-hidden rounded-lg border border-blue-500/40 bg-blue-500/5 lg:mt-0 lg:rounded-t-none lg:border-t-0">
				<StageProgress
					current={buildStageIndex}
					total={ACTIVE_BUILD_STATUSES.length}
				/>
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
					<div className="flex min-w-0 items-center gap-2 text-sm">
						<span className="size-2 animate-pulse rounded-full bg-blue-500" />
						<span className="font-medium">Building</span>
						<span className="truncate text-muted-foreground">
							{BUILD_STATUS_LABELS[barState.buildStatus] || "Building"}
						</span>
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
		const isMigrating = !!service.migrationStatus;
		const isMigrationFailed = service.migrationStatus === "failed";

		const migrationStatus =
			isMigrating && service.migrationStatus
				? MIGRATION_STAGES[service.migrationStatus] || service.migrationStatus
				: null;

		content = (
			<div
				className={cn(
					"mx-auto mt-2 max-w-5xl overflow-hidden rounded-lg border lg:mt-0 lg:rounded-t-none lg:border-t-0",
					isMigrationFailed
						? "border-red-500/40 bg-red-500/5"
						: "border-blue-500/40 bg-blue-500/5",
				)}
			>
				{!isMigrating ? (
					<StageProgress current={barState.stageIndex} total={STAGES.length} />
				) : null}
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
					<div className="flex min-w-0 items-center gap-2 text-sm">
						<span
							className={cn(
								"size-2 rounded-full",
								isMigrationFailed ? "bg-red-500" : "animate-pulse bg-blue-500",
							)}
						/>
						<span className="font-medium">
							{isMigrating ? "Migrating" : "Deploying"}
						</span>
						{migrationStatus ? (
							<span className="truncate text-muted-foreground">
								{migrationStatus}
							</span>
						) : null}
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
							variant="destructive"
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
			<div className="overflow-hidden">{content}</div>
		</div>
	);
});
