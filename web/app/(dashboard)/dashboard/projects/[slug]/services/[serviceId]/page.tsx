"use client";

import {
	deleteDeployment,
	deployService,
	restartService,
	stopDeployment,
} from "@/actions/projects";
import { ActionButton } from "@/components/action-button";
import { useService } from "@/components/service-layout-client";
import { DeploymentCanvas } from "@/components/service-details/deployment-canvas";

export default function ArchitecturePage() {
	const { service, onUpdate } = useService();

	return (
		<div className="relative space-y-4">
			{service.deployments.length > 0 && (
				<div className="absolute top-4 left-4 flex items-center gap-2 z-10">
					{service.deployments.some((d) => d.status === "running") && (
						<>
							<ActionButton
								action={async () => {
									await restartService(service.id);
								}}
								label="Restart"
								loadingLabel="Restarting..."
								variant="outline"
								size="sm"
								onComplete={onUpdate}
							/>
							<ActionButton
								action={async () => {
									const placements = (
										service.configuredReplicas || []
									).map((r) => ({
										serverId: r.serverId,
										replicas: r.count,
									}));
									await deployService(service.id, placements);
								}}
								label="Redeploy"
								loadingLabel="Redeploying..."
								variant="outline"
								size="sm"
								onComplete={onUpdate}
							/>
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
								onComplete={onUpdate}
							/>
						</>
					)}
					{!service.deployments.some((d) => d.status === "running") &&
						service.deployments.some(
							(d) =>
								d.status === "stopped" ||
								d.status === "failed" ||
								d.status === "rolled_back",
						) &&
						(service.configuredReplicas || []).length > 0 && (
							<ActionButton
								action={async () => {
									const placements = (
										service.configuredReplicas || []
									).map((r) => ({
										serverId: r.serverId,
										replicas: r.count,
									}));
									await deployService(service.id, placements);
								}}
								label="Start All"
								loadingLabel="Starting..."
								variant="default"
								size="sm"
								onComplete={onUpdate}
							/>
						)}
					{service.deployments.some(
						(d) =>
							d.status === "stopped" ||
							d.status === "failed" ||
							d.status === "rolled_back",
					) && (
						<ActionButton
							action={async () => {
								const deletable = service.deployments.filter(
									(d) =>
										d.status === "stopped" ||
										d.status === "failed" ||
										d.status === "rolled_back",
								);
								for (const dep of deletable) {
									await deleteDeployment(dep.id);
								}
							}}
							label="Delete All"
							loadingLabel="Deleting..."
							variant="destructive"
							size="sm"
							onComplete={onUpdate}
						/>
					)}
				</div>
			)}
			<DeploymentCanvas service={service} />
		</div>
	);
}
