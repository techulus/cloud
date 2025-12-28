"use client";

import useSWR, { useSWRConfig } from "swr";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Globe, HeartPulse, Lock } from "lucide-react";
import {
	deployService,
	deleteService,
	stopDeployment,
	deleteDeployment,
} from "@/actions/projects";
import { Spinner } from "@/components/ui/spinner";
import { ActionButton } from "@/components/action-button";
import {
	buildCurrentConfig,
	diffConfigs,
	parseDeployedConfig,
} from "@/lib/service-config";
import type { Service } from "./types";
import { PortsSection } from "./ports-section";
import { ReplicasSection } from "./replicas-section";
import { HealthCheckSection } from "./health-check-section";
import { SecretsSection } from "./secrets-section";
import { PendingChangesBar } from "./pending-changes";

export type { Service } from "./types";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function DeploymentStatusIndicator({ status }: { status: string }) {
	const colors: Record<string, { dot: string; text: string }> = {
		running: {
			dot: "bg-emerald-500",
			text: "text-emerald-600 dark:text-emerald-400",
		},
		pending: {
			dot: "bg-amber-500",
			text: "text-amber-600 dark:text-amber-400",
		},
		pulling: {
			dot: "bg-amber-500",
			text: "text-amber-600 dark:text-amber-400",
		},
		stopping: {
			dot: "bg-amber-500",
			text: "text-amber-600 dark:text-amber-400",
		},
		stopped: {
			dot: "bg-zinc-400",
			text: "text-zinc-500",
		},
		failed: {
			dot: "bg-rose-500",
			text: "text-rose-600 dark:text-rose-400",
		},
	};

	const color = colors[status] || { dot: "bg-zinc-400", text: "text-zinc-500" };
	const showPing = status === "running";

	return (
		<div className="flex items-center gap-1.5">
			<span className="relative flex h-2 w-2">
				{showPing && (
					<span
						className={`animate-ping absolute inline-flex h-full w-full rounded-full ${color.dot} opacity-75`}
					/>
				)}
				<span
					className={`relative inline-flex rounded-full h-2 w-2 ${color.dot}`}
				/>
			</span>
			<span className={`text-xs font-medium capitalize ${color.text}`}>
				{status}
			</span>
		</div>
	);
}

function HealthStatusIndicator({ healthStatus }: { healthStatus: string }) {
	const colors: Record<string, { dot: string; text: string }> = {
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

	const color = colors[healthStatus] || { dot: "bg-zinc-400", text: "text-zinc-500" };

	return (
		<div className="flex items-center gap-1">
			<HeartPulse className={`h-3 w-3 ${color.text}`} />
			<span className={`text-xs font-medium capitalize ${color.text}`}>
				{healthStatus}
			</span>
		</div>
	);
}

export function ServiceDetails({
	projectSlug,
	service: initialService,
}: {
	projectSlug: string;
	service: Service;
}) {
	const router = useRouter();
	const { mutate: globalMutate } = useSWRConfig();
	const { data: services, mutate } = useSWR<Service[]>(
		`/api/projects/${initialService.projectId}/services`,
		fetcher,
		{
			fallbackData: [initialService],
			refreshInterval: 5000,
			revalidateOnFocus: true,
		},
	);

	const service =
		services?.find((s) => s.id === initialService.id) || initialService;

	const pendingChanges = useMemo(() => {
		const deployed = parseDeployedConfig(service.deployedConfig);
		const replicas = (service.configuredReplicas || []).map((r) => ({
			serverId: r.serverId,
			serverName: r.serverName,
			count: r.count,
		}));
		const ports = (service.ports || []).map((p) => ({
			port: p.port,
			isPublic: p.isPublic,
			domain: p.domain,
		}));
		const current = buildCurrentConfig(service, replicas, ports, service.secretKeys);
		return diffConfigs(deployed, current);
	}, [service]);

	const [isDeleting, setIsDeleting] = useState(false);

	const handleActionComplete = () => {
		mutate();
	};

	const handleDelete = async () => {
		setIsDeleting(true);
		try {
			await deleteService(service.id);
			await globalMutate(`/api/projects/${initialService.projectId}/services`);
			router.push(`/dashboard/projects/${projectSlug}`);
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-bold">{service.name}</h1>
					<p className="text-sm text-muted-foreground font-mono">
						{service.image}
					</p>
					{(service.ports.filter((p) => p.isPublic && p.domain).length > 0 ||
						service.deployments.some((d) => d.status === "running")) && (
						<div className="flex flex-wrap gap-3 mt-2">
							{service.deployments.some((d) => d.status === "running") && (
								<span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
									<Lock className="h-4 w-4" />
									{service.name}.internal
								</span>
							)}
							{service.ports
								.filter((p) => p.isPublic && p.domain)
								.map((port) => (
									<a
										key={port.id}
										href={`https://${port.domain}`}
										target="_blank"
										rel="noopener noreferrer"
										className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
									>
										<Globe className="h-4 w-4" />
										{port.domain}
									</a>
								))}
						</div>
					)}
				</div>
			</div>

			{service.deployments.length > 0 && (
				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<h2 className="text-xl font-semibold">Deployments</h2>
						<div className="flex items-center gap-2">
							{service.deployments.some((d) => d.status === "running") && (
								<ActionButton
									action={async () => {
										const running = service.deployments.filter(
											(d) => d.status === "running",
										);
										for (const dep of running) {
											await stopDeployment(dep.id);
										}
									}}
									label="Stop All"
									loadingLabel="Stopping..."
									variant="destructive"
									size="sm"
									onComplete={handleActionComplete}
								/>
							)}
							{!service.deployments.some((d) => d.status === "running") &&
								service.deployments.some(
									(d) => d.status === "stopped" || d.status === "failed",
								) &&
								(service.configuredReplicas || []).length > 0 && (
									<ActionButton
										action={async () => {
											const placements = (service.configuredReplicas || []).map(
												(r) => ({
													serverId: r.serverId,
													replicas: r.count,
												}),
											);
											await deployService(service.id, placements);
										}}
										label="Start All"
										loadingLabel="Starting..."
										variant="default"
										size="sm"
										onComplete={handleActionComplete}
									/>
								)}
							{service.deployments.some(
								(d) => d.status === "stopped" || d.status === "failed",
							) && (
								<ActionButton
									action={async () => {
										const deletable = service.deployments.filter(
											(d) => d.status === "stopped" || d.status === "failed",
										);
										for (const dep of deletable) {
											await deleteDeployment(dep.id);
										}
									}}
									label="Delete All"
									loadingLabel="Deleting..."
									variant="destructive"
									size="sm"
									onComplete={handleActionComplete}
								/>
							)}
						</div>
					</div>
					<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
						{service.deployments.map((deployment) => {
							const isTransitioning =
								deployment.status === "pending" ||
								deployment.status === "pulling" ||
								deployment.status === "stopping";
							return (
								<div
									key={deployment.id}
									className="p-3 rounded-lg border bg-card text-sm space-y-2"
								>
									<div className="flex items-center justify-between">
										<span className="font-medium truncate">
											{deployment.server?.name || "—"}
										</span>
										<div className="flex items-center gap-2">
											<DeploymentStatusIndicator status={deployment.status} />
											{deployment.status === "running" &&
												deployment.healthStatus &&
												deployment.healthStatus !== "none" && (
													<HealthStatusIndicator healthStatus={deployment.healthStatus} />
												)}
											{isTransitioning && <Spinner />}
										</div>
									</div>
									<div className="flex items-center gap-2 text-xs text-muted-foreground">
										{deployment.containerId && (
											<code className="font-mono bg-muted px-1 py-0.5 rounded">
												{deployment.containerId.slice(0, 8)}
											</code>
										)}
										{deployment.ports.length > 0 && (
											<div className="flex gap-1">
												{deployment.ports.slice(0, 2).map((p) => (
													<code
														key={p.id}
														className="font-mono bg-muted px-1 py-0.5 rounded"
													>
														:{p.hostPort}
													</code>
												))}
												{deployment.ports.length > 2 && (
													<span>+{deployment.ports.length - 2}</span>
												)}
											</div>
										)}
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{service.deployments.length === 0 && (
				<Card>
					<CardContent className="py-10 text-center">
						<p className="text-muted-foreground">
							No deployments yet. Click Deploy to start.
						</p>
					</CardContent>
				</Card>
			)}

			<div className="space-y-3">
				<h2 className="text-xl font-semibold">Configuration</h2>
				<ReplicasSection service={service} onUpdate={handleActionComplete} />

				<div className="grid gap-6 md:grid-cols-2">
					<PortsSection service={service} onUpdate={handleActionComplete} />
					<HealthCheckSection
						service={service}
						onUpdate={handleActionComplete}
					/>
				</div>

				<SecretsSection service={service} onUpdate={handleActionComplete} />
			</div>

			<PendingChangesBar
				changes={pendingChanges}
				service={service}
				onUpdate={handleActionComplete}
			/>

			<div className="space-y-3">
				<h2 className="text-xl font-semibold text-destructive">Danger Zone</h2>
				<Card className="border-destructive/50">
					<CardContent className="py-4">
						<div className="flex items-center justify-between">
							<div>
								<p className="font-medium">Delete this service</p>
								<p className="text-sm text-muted-foreground">
									Once deleted, this service and all its deployments will be
									permanently removed.
								</p>
							</div>
							<AlertDialog>
								<AlertDialogTrigger
									render={<Button variant="destructive" />}
								>
									Delete Service
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>Delete {service.name}?</AlertDialogTitle>
										<AlertDialogDescription>
											This action cannot be undone. This will permanently delete the service and all its deployments.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>Cancel</AlertDialogCancel>
										<AlertDialogAction
											variant="destructive"
											onClick={handleDelete}
											disabled={isDeleting}
										>
											{isDeleting ? "Deleting..." : "Delete"}
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
