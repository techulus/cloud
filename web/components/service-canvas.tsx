"use client";

import useSWR from "swr";
import Link from "next/link";
import { Globe, Lock, Box, ArrowDown } from "lucide-react";
import { CreateServiceDialog } from "./create-service-dialog";

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

type Service = {
	id: string;
	projectId: string;
	name: string;
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
};

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function getStatusColor(service: Service): {
	bg: string;
	border: string;
	dot: string;
	text: string;
} {
	const hasRunning = service.deployments.some((d) => d.status === "running");
	const hasPending = service.deployments.some(
		(d) => d.status === "pending" || d.status === "pulling",
	);
	const hasFailed = service.deployments.some((d) => d.status === "failed");
	const hasStopped = service.deployments.some((d) => d.status === "stopped");

	if (hasRunning) {
		return {
			bg: "bg-emerald-500/5",
			border: "border-emerald-500/30",
			dot: "bg-emerald-500",
			text: "text-emerald-600 dark:text-emerald-400",
		};
	}
	if (hasPending) {
		return {
			bg: "bg-amber-500/5",
			border: "border-amber-500/30",
			dot: "bg-amber-500",
			text: "text-amber-600 dark:text-amber-400",
		};
	}
	if (hasFailed) {
		return {
			bg: "bg-rose-500/5",
			border: "border-rose-500/30",
			dot: "bg-rose-500",
			text: "text-rose-600 dark:text-rose-400",
		};
	}
	if (hasStopped) {
		return {
			bg: "bg-zinc-500/5",
			border: "border-zinc-400/30",
			dot: "bg-zinc-400",
			text: "text-zinc-500",
		};
	}
	return {
		bg: "bg-zinc-500/5",
		border: "border-zinc-300/50 dark:border-zinc-700/50",
		dot: "bg-zinc-300 dark:bg-zinc-600",
		text: "text-zinc-400",
	};
}

function ServiceCard({
	service,
	projectSlug,
}: {
	service: Service;
	projectSlug: string;
}) {
	const colors = getStatusColor(service);
	const publicPorts = service.ports.filter((p) => p.isPublic && p.domain);
	const hasInternalDns = service.deployments.some(
		(d) => d.status === "running",
	);
	const runningCount = service.deployments.filter(
		(d) => d.status === "running",
	).length;

	const hasPublicIngress = publicPorts.length > 0;

	return (
		<div className="flex flex-col items-center gap-2 w-[280px]">
			{hasPublicIngress && (
				<div className="flex flex-col items-center gap-1.5">
					<div className="flex flex-col gap-1.5 px-3 py-2 bg-zinc-100 dark:bg-zinc-800/80 rounded-lg border border-zinc-200 dark:border-zinc-700">
						{publicPorts.map((port) => (
							<a
								key={port.id}
								href={`https://${port.domain}`}
								target="_blank"
								rel="noopener noreferrer"
								onClick={(e) => e.stopPropagation()}
								className="flex items-center gap-1.5 text-xs hover:opacity-70 transition-opacity"
							>
								<Globe className="h-3 w-3 text-sky-500" />
								<span className="text-sky-600 dark:text-sky-400">
									{port.domain}
								</span>
							</a>
						))}
					</div>
					<ArrowDown className="h-4 w-4 text-zinc-400" />
				</div>
			)}

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
				<div className="flex items-start gap-2.5">
					<div
						className={`
            flex items-center justify-center
            w-9 h-9 rounded-lg
            bg-zinc-100 dark:bg-zinc-800
            border border-zinc-200 dark:border-zinc-700
            group-hover:border-zinc-300 dark:group-hover:border-zinc-600
            transition-colors
          `}
					>
						<Box className="h-4 w-4 text-zinc-500" />
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
						<p className="text-xs text-muted-foreground font-mono truncate">
							{service.image}
						</p>
					</div>
				</div>

				{hasInternalDns && (
					<div className="mt-2 pt-2 border-t border-zinc-200/50 dark:border-zinc-700/50">
						<div className="flex items-center gap-1.5 text-xs">
							<Lock className="h-3 w-3 text-zinc-500" />
							<span className="text-zinc-600 dark:text-zinc-400">
								{service.name}.internal
							</span>
						</div>
					</div>
				)}

				{service.deployments.length > 0 && (
					<div className={`border-t border-zinc-200/50 dark:border-zinc-700/50 ${hasInternalDns ? "mt-2 pt-2" : "mt-2 pt-2"}`}>
						<div className="flex items-center justify-between">
							<span className="text-xs text-muted-foreground">Replicas</span>
							<div className="flex items-center gap-1">
								{Array.from({
									length: Math.max(service.deployments.length, 1),
								}).map((_, i) => {
									const deployment = service.deployments[i];
									const isRunning = deployment?.status === "running";
									const isPending =
										deployment?.status === "pending" ||
										deployment?.status === "pulling";
									const isFailed = deployment?.status === "failed";
									return (
										<div
											key={i}
											className={`
                        w-3 h-3 rounded-sm
                        ${isRunning ? "bg-emerald-500" : ""}
                        ${isPending ? "bg-amber-500 animate-pulse" : ""}
                        ${isFailed ? "bg-rose-500" : ""}
                        ${!isRunning && !isPending && !isFailed ? "bg-zinc-300 dark:bg-zinc-600" : ""}
                      `}
										/>
									);
								})}
								<span className={`ml-2 text-sm font-medium ${colors.text}`}>
									{runningCount}/{service.deployments.length}
								</span>
							</div>
						</div>
					</div>
				)}

				{service.deployments.length === 0 && (
					<div className="mt-2 pt-2 border-t border-zinc-200/50 dark:border-zinc-700/50">
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
          h-[80vh] mt-4 rounded-xl border border-zinc-200 dark:border-zinc-800
          bg-zinc-50 dark:bg-zinc-900/50
          flex items-center justify-center
        "
				style={{
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
        h-[80vh] mt-4 p-10 rounded-xl border border-zinc-200 dark:border-zinc-800
        bg-zinc-50/50 dark:bg-zinc-900/30
        flex items-center justify-center overflow-auto
      "
			style={{
				backgroundImage: `radial-gradient(circle, rgb(161 161 170 / 0.2) 1px, transparent 1px)`,
				backgroundSize: "24px 24px",
			}}
		>
			<div className="flex flex-wrap gap-10 justify-center items-start">
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
