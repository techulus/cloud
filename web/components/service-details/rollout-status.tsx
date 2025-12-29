"use client";

import { memo, useMemo, useState } from "react";
import { CheckCircle2, Loader2, XCircle, X } from "lucide-react";
import { FloatingBar } from "@/components/ui/floating-bar";
import { abortRollout } from "@/actions/projects";
import type { Service, Rollout, DeploymentStatus } from "./types";

type StageInfo = {
	id: string;
	label: string;
};

const STAGES: StageInfo[] = [
	{ id: "deploying", label: "Pulling & Starting" },
	{ id: "health_check", label: "Health Check" },
	{ id: "dns_updating", label: "Updating DNS" },
	{ id: "caddy_updating", label: "Updating Routes" },
	{ id: "stopping_old", label: "Stopping Old" },
	{ id: "completed", label: "Complete" },
];

function mapDeploymentStatusToStage(status: DeploymentStatus): string {
	switch (status) {
		case "pending":
		case "pulling":
			return "deploying";
		case "starting":
		case "healthy":
			return "health_check";
		case "dns_updating":
			return "dns_updating";
		case "caddy_updating":
			return "caddy_updating";
		case "stopping_old":
			return "stopping_old";
		case "running":
			return "completed";
		default:
			return "deploying";
	}
}

function getStageIndex(stageId: string): number {
	return STAGES.findIndex((s) => s.id === stageId);
}

function getRolloutState(service: Service): {
	isActive: boolean;
	currentStage: string;
	rolloutStatus: "in_progress" | "completed" | "failed" | "rolled_back" | null;
	failedStage: string | null;
} {
	const activeRollout = service.rollouts?.find((r) => r.status === "in_progress");

	if (activeRollout) {
		let currentStage = activeRollout.currentStage || "deploying";

		const rolloutDeployments = service.deployments.filter(
			(d) => d.rolloutId === activeRollout.id
		);

		if (rolloutDeployments.length > 0) {
			const statuses = rolloutDeployments.map((d) => d.status);

			if (statuses.every((s) => s === "running")) {
				currentStage = "completed";
			} else if (statuses.some((s) => s === "stopping_old")) {
				currentStage = "stopping_old";
			} else if (statuses.some((s) => s === "caddy_updating")) {
				currentStage = "caddy_updating";
			} else if (statuses.some((s) => s === "dns_updating")) {
				currentStage = "dns_updating";
			} else if (statuses.some((s) => s === "healthy" || s === "starting")) {
				currentStage = "health_check";
			} else if (statuses.some((s) => s === "pending" || s === "pulling")) {
				currentStage = "deploying";
			}
		}

		return {
			isActive: true,
			currentStage,
			rolloutStatus: "in_progress",
			failedStage: null,
		};
	}

	const completedRollout = service.rollouts?.find((r) => r.status === "completed");

	if (completedRollout) {
		const timeSinceCompletion = completedRollout.completedAt
			? Date.now() - new Date(completedRollout.completedAt).getTime()
			: 0;

		if (timeSinceCompletion < 2000) {
			return {
				isActive: true,
				currentStage: "completed",
				rolloutStatus: "completed",
				failedStage: null,
			};
		}
	}

	const failedRollout = service.rollouts?.find(
		(r) => r.status === "failed" || r.status === "rolled_back"
	);

	if (failedRollout) {
		const timeSinceCompletion = failedRollout.completedAt
			? Date.now() - new Date(failedRollout.completedAt).getTime()
			: 0;

		if (timeSinceCompletion < 2000) {
			return {
				isActive: true,
				currentStage: failedRollout.currentStage || "deploying",
				rolloutStatus: failedRollout.status as "failed" | "rolled_back",
				failedStage: failedRollout.currentStage,
			};
		}
	}

	const inProgressDeployments = service.deployments.filter((d) =>
		["pending", "pulling", "starting", "healthy", "dns_updating", "caddy_updating", "stopping_old", "stopping"].includes(d.status)
	);

	if (inProgressDeployments.length > 0) {
		const maxStageIndex = Math.max(
			...inProgressDeployments.map((d) => getStageIndex(mapDeploymentStatusToStage(d.status)))
		);
		return {
			isActive: true,
			currentStage: STAGES[maxStageIndex]?.id || "deploying",
			rolloutStatus: "in_progress",
			failedStage: null,
		};
	}

	return {
		isActive: false,
		currentStage: "completed",
		rolloutStatus: null,
		failedStage: null,
	};
}

function ProgressDots({ current, total }: { current: number; total: number }) {
	return (
		<div className="flex items-center gap-1">
			{Array.from({ length: total }).map((_, i) => (
				<div
					key={i}
					className={`h-1.5 w-1.5 rounded-full transition-all duration-300 ${
						i < current
							? "bg-emerald-500"
							: i === current
								? "bg-blue-500 animate-pulse"
								: "bg-zinc-300 dark:bg-zinc-600"
					}`}
				/>
			))}
		</div>
	);
}

export const RolloutStatusBar = memo(function RolloutStatusBar({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [isAborting, setIsAborting] = useState(false);
	const rolloutState = useMemo(() => getRolloutState(service), [service]);

	if (!rolloutState.isActive) {
		return null;
	}

	const currentStageIndex = getStageIndex(rolloutState.currentStage);
	const currentStage = STAGES[currentStageIndex];
	const isFailed =
		rolloutState.rolloutStatus === "failed" ||
		rolloutState.rolloutStatus === "rolled_back";
	const isCompleted = rolloutState.rolloutStatus === "completed";
	const isInProgress = rolloutState.rolloutStatus === "in_progress";

	const handleAbort = async () => {
		setIsAborting(true);
		try {
			await abortRollout(service.id);
			onUpdate();
		} finally {
			setIsAborting(false);
		}
	};

	const textColor = isFailed
		? "text-red-600 dark:text-red-400"
		: isCompleted
			? "text-emerald-600 dark:text-emerald-400"
			: "text-zinc-700 dark:text-zinc-300";

	const label = isFailed
		? rolloutState.rolloutStatus === "rolled_back"
			? "Rolled Back"
			: "Failed"
		: isCompleted
			? "Deployed"
			: currentStage?.label || "Deploying";

	const variant = isFailed ? "error" : isCompleted ? "success" : "info";

	return (
		<FloatingBar visible variant={variant}>
			{isFailed ? (
				<XCircle className="h-4 w-4 text-red-500" />
			) : isCompleted ? (
				<CheckCircle2 className="h-4 w-4 text-emerald-500" />
			) : (
				<Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
			)}

			<span
				className={`text-sm font-medium transition-all duration-300 ${textColor}`}
			>
				{label}
			</span>

			{isInProgress && (
				<ProgressDots current={currentStageIndex} total={STAGES.length} />
			)}

			{isInProgress && (
				<button
					onClick={handleAbort}
					disabled={isAborting}
					className="ml-1 p-1 rounded-full text-zinc-400 hover:text-red-500 hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors"
				>
					{isAborting ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<X className="h-3.5 w-3.5" />
					)}
				</button>
			)}
		</FloatingBar>
	);
});
