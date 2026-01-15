"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
	ChevronDownIcon,
	RefreshCwIcon,
	RotateCcwIcon,
	PlayIcon,
	StopCircleIcon,
	Trash2Icon,
} from "lucide-react";
import {
	deleteDeployments,
	deployService,
	restartService,
	stopService,
} from "@/actions/projects";
import { useService } from "@/components/service/service-layout-client";
import { DeploymentCanvas } from "@/components/service/details/deployment-canvas";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function ArchitecturePage() {
	const { service, onUpdate } = useService();
	const [isLoading, setIsLoading] = useState<string | null>(null);

	const handleAction = async (
		actionName: string,
		action: () => Promise<unknown>,
		successMessage?: string,
	) => {
		setIsLoading(actionName);
		try {
			await action();
			if (successMessage) {
				toast.success(successMessage);
			}
			onUpdate();
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: typeof error === "string"
						? error
						: error &&
								typeof error === "object" &&
								"message" in error &&
								typeof error.message === "string"
							? error.message
							: "An error occurred";
			toast.error(errorMessage);
		} finally {
			setIsLoading(null);
		}
	};

	const hasRunningDeployments = service.deployments.some(
		(d) => d.status === "running",
	);
	const hasStoppedOrFailedDeployments =
		!hasRunningDeployments &&
		service.deployments.some(
			(d) =>
				d.status === "stopped" ||
				d.status === "failed" ||
				d.status === "rolled_back",
		);
	const canStartAll =
		hasStoppedOrFailedDeployments &&
		(service.configuredReplicas || []).length > 0;

	return (
		<div className="relative space-y-4">
			{service.deployments.length > 0 && (
				<div className="fixed bottom-4 right-4 z-10 md:absolute md:bottom-auto md:top-4 md:left-4 md:right-auto">
					{hasRunningDeployments && (
						<ButtonGroup>
							<Button
								variant="outline"
								size="sm"
								disabled={isLoading !== null}
								onClick={() =>
									handleAction(
										"restart",
										() => restartService(service.id),
										"Restart queued",
									)
								}
							>
								<RefreshCwIcon data-icon="inline-start" />
								{isLoading === "restart" ? "Restarting..." : "Restart"}
							</Button>
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											variant="outline"
											size="icon-sm"
											disabled={isLoading !== null}
										/>
									}
								>
									<ChevronDownIcon />
								</DropdownMenuTrigger>
								<DropdownMenuContent side="bottom" align="end">
									<DropdownMenuItem
										disabled={isLoading !== null}
										onClick={() =>
											handleAction("redeploy", () => deployService(service.id))
										}
									>
										<RotateCcwIcon />
										{isLoading === "redeploy" ? "Redeploying..." : "Redeploy"}
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										disabled={isLoading !== null}
										onClick={() =>
											handleAction("stop", () => stopService(service.id))
										}
										className="text-orange-600 dark:text-orange-500"
									>
										<StopCircleIcon />
										{isLoading === "stop" ? "Stopping..." : "Stop All"}
									</DropdownMenuItem>
									<DropdownMenuItem
										variant="destructive"
										disabled={isLoading !== null}
										onClick={() =>
											handleAction("delete", () =>
												deleteDeployments(service.id),
											)
										}
									>
										<Trash2Icon />
										{isLoading === "delete" ? "Deleting..." : "Delete All"}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</ButtonGroup>
					)}
					{canStartAll && (
						<ButtonGroup>
							<Button
								variant="default"
								size="sm"
								disabled={isLoading !== null}
								onClick={() =>
									handleAction("start", () => deployService(service.id))
								}
							>
								<PlayIcon data-icon="inline-start" />
								{isLoading === "start" ? "Starting..." : "Start All"}
							</Button>
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											variant="default"
											size="icon-sm"
											disabled={isLoading !== null}
										/>
									}
								>
									<ChevronDownIcon />
								</DropdownMenuTrigger>
								<DropdownMenuContent side="bottom" align="end">
									<DropdownMenuItem
										variant="destructive"
										disabled={isLoading !== null}
										onClick={() =>
											handleAction("delete", () =>
												deleteDeployments(service.id),
											)
										}
									>
										<Trash2Icon />
										{isLoading === "delete" ? "Deleting..." : "Delete All"}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</ButtonGroup>
					)}
				</div>
			)}
			<DeploymentCanvas service={service} />
		</div>
	);
}
