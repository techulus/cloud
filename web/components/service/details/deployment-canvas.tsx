"use client";

import {
	ArrowDown,
	Box,
	Globe,
	HardDrive,
	HeartPulse,
	Lock,
} from "lucide-react";
import {
	CanvasWrapper,
	getHealthColor,
	getStatusColor,
} from "@/components/ui/canvas-wrapper";
import { Spinner } from "@/components/ui/spinner";
import type {
	Deployment as BaseDeployment,
	DeploymentPort,
	Server as ServerType,
	ServiceWithDetails as Service,
	ServiceVolume,
} from "@/db/types";

type Deployment = BaseDeployment & {
	server: Pick<ServerType, "name" | "wireguardIp"> | null;
	ports: Array<
		Pick<DeploymentPort, "id" | "hostPort"> & { containerPort: number }
	>;
};

const statusLabels: Record<string, string> = {
	pending: "Queued",
	pulling: "Creating",
	starting: "Creating",
	healthy: "Healthy",
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
			className={`p-2 rounded-lg border ${colors.border} ${colors.bg} space-y-1 transition-all duration-300 ease-in-out -mx-1`}
		>
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-1">
					<Box className="h-3 w-3 text-slate-500" />
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

function EndpointsCard({
	publicPorts,
	internalHostname,
	hasRunningDeployments,
}: {
	publicPorts: Array<{ id: string; domain: string | null }>;
	internalHostname: string;
	hasRunningDeployments: boolean;
}) {
	return (
		<div className="w-full md:w-[320px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
			<div className="px-2.5 py-2 border-b border-slate-200 dark:border-slate-700">
				<h3 className="font-semibold text-sm text-foreground">Endpoints</h3>
			</div>

			{publicPorts.length > 0 && (
				<div className="border-l-2 border-sky-500 mx-2.5 my-2 pl-2.5">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-1.5 text-muted-foreground">
							<Globe className="h-3 w-3" />
							<span className="text-xs">Public domain</span>
						</div>
						<div className="flex items-center gap-1.5">
							<span className="h-2 w-2 rounded-full bg-emerald-500" />
							<span className="text-xs text-emerald-600 dark:text-emerald-400">Active</span>
						</div>
					</div>
					<div className="mt-1 space-y-0.5">
						{publicPorts.map((port) => (
							<a
								key={port.id}
								href={`https://${port.domain}`}
								target="_blank"
								rel="noopener noreferrer"
								className="block text-xs text-foreground hover:text-sky-600 dark:hover:text-sky-400 transition-colors truncate"
							>
								{port.domain}
							</a>
						))}
					</div>
				</div>
			)}

			{hasRunningDeployments && (
				<div className="border-l-2 border-slate-300 dark:border-slate-600 mx-2.5 my-2 pl-2.5">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-1.5 text-muted-foreground">
							<Lock className="h-3 w-3" />
							<span className="text-xs">Internal</span>
						</div>
						<div className="flex items-center gap-1.5">
							<span className="h-2 w-2 rounded-full bg-emerald-500" />
							<span className="text-xs text-emerald-600 dark:text-emerald-400">Active</span>
						</div>
					</div>
					<p className="mt-1 text-xs text-foreground truncate">
						{internalHostname}
					</p>
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
		: "border-slate-200 dark:border-slate-700";
	const hasVolumes = volumes && volumes.length > 0;

	return (
		<div
			className={`
				w-full md:w-[320px] px-2.5 py-2 rounded-xl border-2 ${borderClass}
				bg-white/50 dark:bg-slate-900/50
				backdrop-blur-sm
				transition-all duration-300 ease-in-out
				space-y-2
			`}
		>
			<div className="flex items-center gap-2 mb-2">
				<h3 className="font-semibold text-sm text-foreground truncate">
					{serverName}
				</h3>

				{hasVolumes && (
					<div className="ml-auto">
						{volumes?.map((volume) => (
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

			<div className="space-y-1.5">
				{deployments.map((deployment) => (
					<DeploymentCard key={deployment.id} deployment={deployment} />
				))}
			</div>
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
			<>
				<div className="flex flex-col items-center justify-center py-12 md:hidden">
					<div className="w-16 h-16 mx-auto rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
						<Box className="h-8 w-8 text-slate-400" />
					</div>
					<p className="text-muted-foreground mt-4">No deployments yet.</p>
				</div>
				<CanvasWrapper
					height="70vh"
					isEmpty
					className="hidden md:flex"
					emptyContent={
						<div className="text-center space-y-4">
							<div className="w-16 h-16 mx-auto rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
								<Box className="h-8 w-8 text-slate-400" />
							</div>
							<p className="text-muted-foreground">No deployments yet.</p>
						</div>
					}
				/>
			</>
		);
	}

	const hasEndpoints = hasPublicIngress || hasRunningDeployments;

	return (
		<>
			<div className="flex flex-col items-center gap-4 py-4 pb-16 md:hidden">
				{hasEndpoints && (
					<>
						<EndpointsCard
							publicPorts={publicPorts}
							internalHostname={`${service.hostname || service.name}.internal`}
							hasRunningDeployments={hasRunningDeployments}
						/>
						<ArrowDown className="h-5 w-5 text-slate-400" />
					</>
				)}
				<div className="flex flex-col gap-4 w-full">
					{serverGroups.map((group) => (
						<ServerBox
							key={group.serverName}
							serverName={group.serverName}
							deployments={group.deployments}
							volumes={service.volumes}
						/>
					))}
				</div>
			</div>
			<CanvasWrapper
				height="auto"
				className="hidden md:flex items-center justify-center min-h-[84vh]"
			>
				<div className="flex flex-col items-center gap-4">
					{hasEndpoints && (
						<>
							<EndpointsCard
								publicPorts={publicPorts}
								internalHostname={`${service.hostname || service.name}.internal`}
								hasRunningDeployments={hasRunningDeployments}
							/>
							<ArrowDown className="h-5 w-5 text-slate-400" />
						</>
					)}

					<div className="flex flex-wrap gap-6 justify-center max-w-[900px]">
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
		</>
	);
}
