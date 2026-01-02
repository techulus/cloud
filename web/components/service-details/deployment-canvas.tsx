"use client";

import {
	Globe,
	Server,
	Box,
	HeartPulse,
	Lock,
	ArrowDown,
	HardDrive,
} from "lucide-react";
import {
	CanvasWrapper,
	getStatusColor,
	getHealthColor,
} from "@/components/ui/canvas-wrapper";
import { Spinner } from "@/components/ui/spinner";
import type {
	Deployment as BaseDeployment,
	DeploymentPort,
	Server as ServerType,
	ServiceVolume,
	ServiceWithDetails as Service,
} from "@/db/types";

type Deployment = BaseDeployment & {
	server: Pick<ServerType, "name" | "wireguardIp"> | null;
	ports: Array<
		Pick<DeploymentPort, "id" | "hostPort"> & { containerPort: number }
	>;
};

const statusLabels: Record<string, string> = {
	pending: "Queued",
	pulling: "Pulling image",
	starting: "Starting",
	healthy: "Health check passed",
	running: "Running",
	stopping: "Stopping",
	stopped: "Stopped",
	failed: "Failed",
	rolled_back: "Rolled back",
	unknown: "Unknown",
};

function getStatusLabel(status: string): string {
	return statusLabels[status] || status;
}

function DeploymentCard({ deployment }: { deployment: Deployment }) {
	const colors = getStatusColor(deployment.status);
	const healthColor =
		deployment.healthStatus && deployment.healthStatus !== "none"
			? getHealthColor(deployment.healthStatus)
			: null;
	const isTransitioning =
		deployment.status === "pending" ||
		deployment.status === "pulling" ||
		deployment.status === "starting" ||
		deployment.status === "stopping";

	return (
		<div
			className={`p-2 rounded-lg border ${colors.border} ${colors.bg} space-y-1 transition-all duration-300 ease-in-out`}
		>
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-1">
					<Box className="h-3 w-3 text-zinc-500" />
					{deployment.containerId && (
						<code className="text-[11px] font-mono text-muted-foreground">
							{deployment.containerId.slice(0, 8)}
						</code>
					)}
				</div>
				<div className="flex items-center gap-1.5">
					<span className="relative flex h-2 w-2">
						{deployment.status === "running" && (
							<span
								className={`animate-ping absolute inline-flex h-full w-full rounded-full ${colors.dot} opacity-75`}
							/>
						)}
						<span
							className={`relative inline-flex rounded-full h-2 w-2 ${colors.dot} transition-colors duration-300`}
						/>
					</span>
					<span
						className={`text-xs font-medium ${colors.text} transition-colors duration-300`}
					>
						{getStatusLabel(deployment.status)}
					</span>
					{isTransitioning && <Spinner className="h-3 w-3" />}
				</div>
			</div>

			{healthColor && deployment.status === "running" && (
				<div className="flex items-center gap-1 animate-in fade-in duration-300">
					<HeartPulse
						className={`h-3 w-3 ${healthColor.text} transition-colors duration-300`}
					/>
					<span
						className={`text-xs font-medium capitalize ${healthColor.text} transition-colors duration-300`}
					>
						{deployment.healthStatus}
					</span>
				</div>
			)}
		</div>
	);
}

function ServerBox({
	serverName,
	deployments,
	volumes,
}: {
	serverName: string;
	deployments: Deployment[];
	volumes?: ServiceVolume[];
}) {
	const hasRunning = deployments.some((d) => d.status === "running");
	const borderClass = hasRunning
		? "border-emerald-500/30"
		: "border-zinc-200 dark:border-zinc-700";
	const hasVolumes = volumes && volumes.length > 0;

	return (
		<div
			className={`
				w-[280px] p-3 rounded-xl border-2 ${borderClass}
				bg-white/50 dark:bg-zinc-900/50
				backdrop-blur-sm
				transition-all duration-300 ease-in-out
			`}
		>
			<div className="flex items-center gap-2 mb-2">
				<div className="flex items-center justify-center w-5 h-5 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
					<Server className="h-3 w-3 text-zinc-500" />
				</div>
				<div className="flex-1 min-w-0">
					<h3 className="font-semibold text-sm text-foreground truncate">
						{serverName}
					</h3>
				</div>
			</div>

			<div className="space-y-1.5">
				{deployments.map((deployment) => (
					<DeploymentCard key={deployment.id} deployment={deployment} />
				))}
			</div>

			{hasVolumes && (
				<div className="mt-2 space-y-1">
					{volumes!.map((volume) => (
						<div
							key={volume.id}
							className="flex items-center gap-2 text-xs text-muted-foreground"
						>
							<HardDrive className="h-3.5 w-3.5" />
							<span>{volume.name}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

interface DeploymentCanvasProps {
	service: Service;
}

export function DeploymentCanvas({ service }: DeploymentCanvasProps) {
	const publicPorts = service.ports.filter((p) => p.isPublic && p.domain);
	const hasPublicIngress = publicPorts.length > 0;
	const hasRunningDeployments = service.deployments.some(
		(d) => d.status === "running",
	);

	const deploymentsByServer = service.deployments.reduce(
		(acc, deployment) => {
			const serverId = deployment.serverId;
			if (!acc[serverId]) {
				acc[serverId] = {
					serverName: deployment.server?.name || "Unknown",
					deployments: [],
				};
			}
			acc[serverId].deployments.push(deployment);
			return acc;
		},
		{} as Record<string, { serverName: string; deployments: Deployment[] }>,
	);

	const serverGroups = Object.values(deploymentsByServer);

	if (service.deployments.length === 0) {
		return (
			<CanvasWrapper
				height="70vh"
				isEmpty
				emptyContent={
					<div className="text-center space-y-4">
						<div className="w-16 h-16 mx-auto rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
							<Box className="h-8 w-8 text-zinc-400" />
						</div>
						<p className="text-muted-foreground">No deployments yet.</p>
					</div>
				}
			/>
		);
	}

	const hasEndpoints = hasPublicIngress || hasRunningDeployments;

	return (
		<CanvasWrapper
			height="auto"
			className="flex items-center justify-center min-h-[84vh]"
		>
			<div className="flex flex-col items-center gap-4">
				{hasEndpoints && (
					<>
						<div className="flex flex-wrap gap-2 justify-center px-4 py-2.5 bg-zinc-100 dark:bg-zinc-800/80 rounded-lg border border-zinc-200 dark:border-zinc-700 transition-all duration-300">
							{publicPorts.map((port) => (
								<a
									key={port.id}
									href={`https://${port.domain}`}
									target="_blank"
									rel="noopener noreferrer"
									className="flex items-center gap-1.5 text-xs hover:opacity-70 transition-opacity"
								>
									<Globe className="h-3 w-3 text-sky-500" />
									<span className="text-sky-600 dark:text-sky-400">
										{port.domain}
									</span>
								</a>
							))}
							{hasPublicIngress && hasRunningDeployments && (
								<span className="text-zinc-300 dark:text-zinc-600">|</span>
							)}
							{hasRunningDeployments && (
								<div className="flex items-center gap-1.5 text-xs">
									<Lock className="h-3 w-3 text-zinc-500" />
									<span className="text-zinc-600 dark:text-zinc-400">
										{service.hostname || service.name}.internal
									</span>
								</div>
							)}
						</div>
						<ArrowDown className="h-5 w-5 text-zinc-400" />
					</>
				)}

				<div className="flex flex-wrap gap-6 justify-center items-start">
					{serverGroups.map((group) => (
						<div
							key={group.serverName}
							className="animate-in fade-in slide-in-from-bottom-2 duration-300"
						>
							<ServerBox
								serverName={group.serverName}
								deployments={group.deployments}
								volumes={service.volumes}
							/>
						</div>
					))}
				</div>
			</div>
		</CanvasWrapper>
	);
}
