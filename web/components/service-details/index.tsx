"use client";

import useSWR from "swr";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

function getStatusVariant(status: string) {
	switch (status) {
		case "running":
			return "default";
		case "pending":
		case "pulling":
		case "stopping":
			return "secondary";
		case "stopped":
			return "outline";
		case "failed":
			return "destructive";
		default:
			return "secondary";
	}
}

export function ServiceDetails({
	projectSlug,
	service: initialService,
}: {
	projectSlug: string;
	service: Service;
}) {
	const router = useRouter();
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
		const current = buildCurrentConfig(service, replicas, ports);
		return diffConfigs(deployed, current);
	}, [service]);

	const handleActionComplete = () => {
		mutate();
	};

	const handleDelete = async () => {
		await deleteService(service.id);
		router.push(`/dashboard/projects/${projectSlug}`);
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
										<div className="flex items-center gap-1.5">
											<Badge
												variant={getStatusVariant(deployment.status)}
												className="text-xs"
											>
												{deployment.status}
											</Badge>
											{deployment.status === "running" &&
												deployment.healthStatus &&
												deployment.healthStatus !== "none" && (
													<Badge
														variant={
															deployment.healthStatus === "healthy"
																? "default"
																: deployment.healthStatus === "starting"
																	? "secondary"
																	: "destructive"
														}
														className="text-xs gap-0.5"
													>
														<HeartPulse className="h-2.5 w-2.5" />
														{deployment.healthStatus}
													</Badge>
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
							<ActionButton
								action={handleDelete}
								label="Delete Service"
								loadingLabel="Deleting..."
								variant="destructive"
							/>
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
