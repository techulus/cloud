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
import {
	deployService,
	deleteService,
	stopDeployment,
	deleteDeployment,
} from "@/actions/projects";
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
import { DeploymentCanvas } from "./deployment-canvas";
import { LogsViewer } from "./logs-viewer";
import { fetcher } from "@/lib/fetcher";

export type { Service } from "./types";

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
		const current = buildCurrentConfig(
			service,
			replicas,
			ports,
			service.secrets,
		);
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
				</div>
			</div>

			<div className="space-y-3">
				<div className="flex items-center justify-between">
					<h2 className="text-xl font-semibold">Deployments</h2>
					{service.deployments.length > 0 && (
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
					)}
				</div>
				<DeploymentCanvas service={service} />
			</div>

			<LogsViewer serviceId={service.id} />

			<div className="space-y-3">
				<h2 className="text-xl font-semibold">Configuration</h2>
				<ReplicasSection service={service} onUpdate={handleActionComplete} />

				<div className="grid gap-3 md:grid-cols-2">
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
								<AlertDialogTrigger render={<Button variant="destructive" />}>
									Delete Service
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>Delete {service.name}?</AlertDialogTitle>
										<AlertDialogDescription>
											This action cannot be undone. This will permanently delete
											the service and all its deployments.
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
