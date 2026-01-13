"use client";

import { cn } from "@/lib/utils";

export type StatusColors = {
	bg: string;
	border: string;
	dot: string;
	text: string;
};

const statusColorMap: Record<string, StatusColors> = {
	running: {
		bg: "bg-emerald-500/5",
		border: "border-emerald-500/30",
		dot: "bg-emerald-500",
		text: "text-emerald-600 dark:text-emerald-400",
	},
	pending: {
		bg: "bg-amber-500/5",
		border: "border-amber-500/30",
		dot: "bg-amber-500",
		text: "text-amber-600 dark:text-amber-400",
	},
	pulling: {
		bg: "bg-amber-500/5",
		border: "border-amber-500/30",
		dot: "bg-amber-500",
		text: "text-amber-600 dark:text-amber-400",
	},
	stopping: {
		bg: "bg-amber-500/5",
		border: "border-amber-500/30",
		dot: "bg-amber-500",
		text: "text-amber-600 dark:text-amber-400",
	},
	stopped: {
		bg: "bg-slate-500/5",
		border: "border-zinc-400/30",
		dot: "bg-slate-400",
		text: "text-zinc-500",
	},
	failed: {
		bg: "bg-rose-500/5",
		border: "border-rose-500/30",
		dot: "bg-rose-500",
		text: "text-rose-600 dark:text-rose-400",
	},
	unknown: {
		bg: "bg-slate-500/5",
		border: "border-slate-400/30",
		dot: "bg-slate-400",
		text: "text-slate-500 dark:text-slate-400",
	},
};

const defaultColors: StatusColors = {
	bg: "bg-slate-500/5",
	border: "border-zinc-300/50 dark:border-zinc-700/50",
	dot: "bg-slate-300 dark:bg-slate-600",
	text: "text-zinc-400",
};

export function getStatusColor(status: string): StatusColors {
	return statusColorMap[status] || defaultColors;
}

export function getStatusColorFromDeployments(
	deployments: { status: string }[],
): StatusColors {
	const hasRunning = deployments.some((d) => d.status === "running");
	const hasPending = deployments.some(
		(d) => d.status === "pending" || d.status === "pulling",
	);
	const hasFailed = deployments.some((d) => d.status === "failed");
	const hasStopped = deployments.some((d) => d.status === "stopped");
	const hasUnknown = deployments.some((d) => d.status === "unknown");

	if (hasRunning) return statusColorMap.running;
	if (hasPending) return statusColorMap.pending;
	if (hasFailed) return statusColorMap.failed;
	if (hasUnknown) return statusColorMap.unknown;
	if (hasStopped) return statusColorMap.stopped;
	return defaultColors;
}

export type HealthColors = {
	dot: string;
	text: string;
};

const healthColorMap: Record<string, HealthColors> = {
	healthy: {
		dot: "bg-emerald-500",
		text: "text-emerald-600 dark:text-emerald-400",
	},
	starting: {
		dot: "bg-amber-500",
		text: "text-amber-600 dark:text-amber-400",
	},
	unhealthy: {
		dot: "bg-rose-500",
		text: "text-rose-600 dark:text-rose-400",
	},
};

const defaultHealthColors: HealthColors = {
	dot: "bg-slate-400",
	text: "text-zinc-500",
};

export function getHealthColor(healthStatus: string): HealthColors {
	return healthColorMap[healthStatus] || defaultHealthColors;
}

interface CanvasWrapperProps {
	children?: React.ReactNode;
	height?: string;
	className?: string;
	isEmpty?: boolean;
	emptyContent?: React.ReactNode;
}

export function CanvasWrapper({
	children,
	height = "75vh",
	className,
	isEmpty,
	emptyContent,
}: CanvasWrapperProps) {
	if (isEmpty && emptyContent) {
		return (
			<div
				className={cn(
					"rounded-xl border border-zinc-200 dark:border-zinc-800",
					"bg-slate-50 dark:bg-slate-900/50",
					"flex items-center justify-center",
					className,
				)}
				style={{
					height,
					backgroundImage: `radial-gradient(circle, rgb(161 161 170 / 0.3) 1px, transparent 1px)`,
					backgroundSize: "20px 20px",
				}}
			>
				{emptyContent}
			</div>
		);
	}

	return (
		<div
			className={cn(
				"p-6 rounded-xl border border-zinc-200 dark:border-zinc-800",
				"bg-slate-50/50 dark:bg-slate-900/30",
				"overflow-auto",
				className,
			)}
			style={{
				height,
				backgroundImage: `radial-gradient(circle, rgb(161 161 170 / 0.2) 1px, transparent 1px)`,
				backgroundSize: "24px 24px",
			}}
		>
			{children}
		</div>
	);
}
