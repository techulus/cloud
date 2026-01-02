"use client";

import useSWR from "swr";
import Link from "next/link";
import { Globe, Lock, Box, HardDrive } from "lucide-react";
import { CreateServiceDialog } from "./create-service-dialog";
import { getStatusColorFromDeployments } from "./ui/canvas-wrapper";
import { fetcher } from "@/lib/fetcher";

type DeploymentPort = {
	id: string;
	hostPort: number;
	containerPort: number;
};

type Deployment = {
	id: string;
	serviceId: string;
	serverId: string;
	containerId: string | null;
	status: string;
	healthStatus: "none" | "starting" | "healthy" | "unhealthy" | null;
	ports: DeploymentPort[];
	server: { name: string; wireguardIp: string | null } | null;
};

type ServicePort = {
	id: string;
	serviceId: string;
	port: number;
	isPublic: boolean;
	domain: string | null;
};

type ServiceReplica = {
	id: string;
	serverId: string;
	serverName: string;
	count: number;
};

type ServiceVolume = {
	id: string;
	name: string;
	containerPath: string;
};

type Service = {
	id: string;
	projectId: string;
	name: string;
	hostname: string | null;
	image: string;
	replicas: number;
	deployedConfig: string | null;
	healthCheckCmd: string | null;
	healthCheckInterval: number | null;
	healthCheckTimeout: number | null;
	healthCheckRetries: number | null;
	healthCheckStartPeriod: number | null;
	ports: ServicePort[];
	configuredReplicas: ServiceReplica[];
	deployments: Deployment[];
	volumes?: ServiceVolume[];
};

function ServiceCard({
	service,
	projectSlug,
}: {
	service: Service;
	projectSlug: string;
}) {
	const colors = getStatusColorFromDeployments(service.deployments);
	const publicPorts = service.ports.filter((p) => p.isPublic && p.domain);
	const hasInternalDns = service.deployments.some(
		(d) => d.status === "running",
	);
	const runningCount = service.deployments.filter(
		(d) => d.status === "running",
	).length;
	const hasVolumes = service.volumes && service.volumes.length > 0;

	const hasEndpoints = publicPorts.length > 0 || hasInternalDns;

	return (
		<div className="flex flex-col items-center gap-2 w-70">
			<Link
				href={`/dashboard/projects/${projectSlug}/services/${service.id}`}
				className={`
          group relative w-full
          p-3 rounded-xl border-2 ${colors.border} ${colors.bg}
          hover:shadow-lg hover:scale-[1.02]
          transition-all duration-200 ease-out
          cursor-pointer
        `}
			>
				<div className="flex items-center gap-2">
					<div
						className={`
            flex items-center justify-center
            w-5 h-5 rounded
            bg-zinc-100 dark:bg-zinc-800
            border border-zinc-200 dark:border-zinc-700
            group-hover:border-zinc-300 dark:group-hover:border-zinc-600
            transition-colors
          `}
					>
						<Box className="h-3 w-3 text-zinc-500" />
					</div>

					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-1.5">
							<h3 className="font-semibold text-sm text-foreground truncate">
								{service.name}
							</h3>
							<span className={`relative flex h-2 w-2`}>
								<span
									className={`animate-ping absolute inline-flex h-full w-full rounded-full ${colors.dot} opacity-75`}
								/>
								<span
									className={`relative inline-flex rounded-full h-2 w-2 ${colors.dot}`}
								/>
							</span>
						</div>
					</div>
				</div>

				{hasEndpoints && (
					<div className="mt-2 space-y-1.5">
						{publicPorts.map((port) => (
							<div
								key={port.id}
								className="flex items-center gap-1.5 text-xs"
							>
								<Globe className="h-3 w-3 text-sky-500" />
								<span className="text-sky-600 dark:text-sky-400">
									{port.domain}
								</span>
							</div>
						))}
						{hasInternalDns && (
							<div className="flex items-center gap-1.5 text-xs">
								<Lock className="h-3 w-3 text-zinc-500" />
								<span className="text-zinc-600 dark:text-zinc-400">
									{service.hostname || service.name}.internal
								</span>
							</div>
						)}
					</div>
				)}

				{hasVolumes && (
					<div className="mt-2 space-y-1">
						{service.volumes!.map((volume) => (
							<div key={volume.id} className="flex items-center gap-2 text-xs text-muted-foreground">
								<HardDrive className="h-3.5 w-3.5" />
								<span>{volume.name}</span>
							</div>
						))}
					</div>
				)}

				{service.deployments.length > 0 && (
					<div className="mt-2">
						<div className="flex items-center justify-between">
							<span className="text-xs text-muted-foreground">Replicas</span>
							<span className={`text-sm font-medium ${colors.text}`}>
								{runningCount}/{service.deployments.length}
							</span>
						</div>
					</div>
				)}

				{service.deployments.length === 0 && (
					<div className="mt-2">
						<span className="text-xs text-muted-foreground">Not deployed</span>
					</div>
				)}
			</Link>
		</div>
	);
}

export function ServiceCanvas({
	projectId,
	projectSlug,
	initialServices,
}: {
	projectId: string;
	projectSlug: string;
	initialServices: Service[];
}) {
	const { data: services, mutate } = useSWR<Service[]>(
		`/api/projects/${projectId}/services`,
		fetcher,
		{
			fallbackData: initialServices,
			refreshInterval: 5000,
			revalidateOnFocus: true,
		},
	);

	if (!services || services.length === 0) {
		return (
			<div
				className="
          relative -mt-6 -mb-6
          left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen
          bg-zinc-50 dark:bg-zinc-900/50
          flex items-center justify-center
        "
				style={{
					height: "calc(100vh - 5rem)",
					backgroundImage: `radial-gradient(circle, rgb(161 161 170 / 0.3) 1px, transparent 1px)`,
					backgroundSize: "20px 20px",
				}}
			>
				<div className="text-center space-y-4">
					<div className="w-16 h-16 mx-auto rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
						<Box className="h-8 w-8 text-zinc-400" />
					</div>
					<div>
						<p className="text-muted-foreground mb-4">
							No services yet. Add your first service to deploy.
						</p>
						<CreateServiceDialog
							projectId={projectId}
							onSuccess={() => mutate()}
						/>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			className="
        relative -mt-6 -mb-6 p-10
        left-1/2 right-1/2 -ml-[50vw] -mr-[50vw] w-screen
        bg-zinc-50/50 dark:bg-zinc-900/30
        flex items-center justify-center overflow-auto
      "
			style={{
				height: "calc(100vh - 3.5rem)",
				backgroundImage: `radial-gradient(circle, rgb(161 161 170 / 0.2) 1px, transparent 1px)`,
				backgroundSize: "24px 24px",
			}}
		>
			<div className="absolute top-4 right-4">
				<CreateServiceDialog
					projectId={projectId}
					onSuccess={() => mutate()}
				/>
			</div>
			<div className="flex flex-wrap gap-10 justify-center items-center">
				{services.map((service) => (
					<ServiceCard
						key={service.id}
						service={service}
						projectSlug={projectSlug}
					/>
				))}
			</div>
		</div>
	);
}
