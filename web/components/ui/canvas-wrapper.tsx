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
		border: "border-slate-400/30",
		dot: "bg-slate-400",
		text: "text-slate-500",
	},
	sleeping: {
		bg: "bg-cyan-500/5",
		border: "border-cyan-500/30",
		dot: "bg-cyan-500",
		text: "text-cyan-700 dark:text-cyan-400",
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
	border: "border-slate-300/50 dark:border-slate-700/50",
	dot: "bg-slate-300 dark:bg-slate-600",
	text: "text-slate-400",
};

export function getStatusColor(status: string): StatusColors {
	return statusColorMap[status] || defaultColors;
}

export function getStatusColorFromDeployments(
	deployments: { observedPhase: string; runtimeDesiredState?: string }[],
): StatusColors {
	const hasRunning = deployments.some(
		(d) => d.observedPhase === "running" || d.observedPhase === "healthy",
	);
	const hasPending = deployments.some(
		(d) =>
			d.observedPhase === "pending" ||
			d.observedPhase === "pulling" ||
			d.observedPhase === "starting" ||
			d.observedPhase === "waking",
	);
	const hasFailed = deployments.some((d) => d.observedPhase === "failed");
	const hasSleeping = deployments.some((d) => d.observedPhase === "sleeping");
	const hasStopped = deployments.some(
		(d) =>
			d.observedPhase === "stopped" ||
			d.runtimeDesiredState === "removed",
	);
	const hasUnknown = deployments.some((d) => d.observedPhase === "unknown");

	if (hasRunning) return statusColorMap.running;
	if (hasPending) return statusColorMap.pending;
	if (hasFailed) return statusColorMap.failed;
	if (hasUnknown) return statusColorMap.unknown;
	if (hasSleeping) return statusColorMap.sleeping;
	if (hasStopped) return statusColorMap.stopped;
	return defaultColors;
}
