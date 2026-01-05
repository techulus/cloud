"use client";

import { toast } from "sonner";
import {
	deleteDeployments,
	deployService,
	restartService,
	stopService,
} from "@/actions/projects";
import { ActionButton } from "@/components/core/action-button";
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
									toast.success("Restart queued");
								}}
								label="Restart"
								loadingLabel="Restarting..."
								variant="outline"
								size="sm"
								onComplete={onUpdate}
							/>
							<ActionButton
								action={async () => {
									await deployService(service.id);
								}}
								label="Redeploy"
								loadingLabel="Redeploying..."
								variant="outline"
								size="sm"
								onComplete={onUpdate}
							/>
							<ActionButton
								action={async () => {
									await stopService(service.id);
								}}
								label="Stop All"
								loadingLabel="Stopping..."
								variant="warning"
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
									await deployService(service.id);
								}}
								label="Start All"
								loadingLabel="Starting..."
								variant="default"
								size="sm"
								onComplete={onUpdate}
							/>
						)}
					<ActionButton
						action={async () => {
							await deleteDeployments(service.id);
						}}
						label="Delete All"
						loadingLabel="Deleting..."
						variant="destructive"
						size="sm"
						onComplete={onUpdate}
					/>
				</div>
			)}
			<DeploymentCanvas service={service} />
		</div>
	);
}
