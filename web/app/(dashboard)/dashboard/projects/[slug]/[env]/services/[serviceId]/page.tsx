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
	AlertTriangleIcon,
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
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type ConfirmAction = "redeploy" | "stop" | "delete" | null;

export default function ArchitecturePage() {
	const { service, onUpdate } = useService();
	const [isLoading, setIsLoading] = useState<string | null>(null);
	const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

	const handleAction = async (
		actionName: string,
		action: () => Promise<unknown>,
		successMessage?: string,
	) => {
		setIsLoading(actionName);
		setConfirmAction(null);
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

	const confirmActionConfig = {
		redeploy: {
			title: "Redeploy Service",
			description:
				"This will create new deployments and replace all existing ones. The service may experience brief downtime during the transition.",
			actionLabel: "Redeploy",
			variant: "default" as const,
			onConfirm: () =>
				handleAction("redeploy", () => deployService(service.id)),
		},
		stop: {
			title: "Stop All Deployments",
			description:
				"This will stop all running containers for this service. The service will become unavailable until you start it again.",
			actionLabel: "Stop All",
			variant: "default" as const,
			onConfirm: () => handleAction("stop", () => stopService(service.id)),
		},
		delete: {
			title: "Delete All Deployments",
			description:
				"This will permanently delete all deployments for this service. Running containers will be stopped and removed. This action cannot be undone.",
			actionLabel: "Delete All",
			variant: "destructive" as const,
			onConfirm: () =>
				handleAction("delete", () => deleteDeployments(service.id)),
		},
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
										onClick={() => setConfirmAction("redeploy")}
									>
										<RotateCcwIcon />
										Redeploy
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										disabled={isLoading !== null}
										onClick={() => setConfirmAction("stop")}
										className="text-orange-600 dark:text-orange-500"
									>
										<StopCircleIcon />
										Stop All
									</DropdownMenuItem>
									<DropdownMenuItem
										variant="destructive"
										disabled={isLoading !== null}
										onClick={() => setConfirmAction("delete")}
									>
										<Trash2Icon />
										Delete All
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
										onClick={() => setConfirmAction("delete")}
									>
										<Trash2Icon />
										Delete All
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</ButtonGroup>
					)}
				</div>
			)}
			<DeploymentCanvas service={service} />

			<AlertDialog
				open={confirmAction !== null}
				onOpenChange={(open) => !open && setConfirmAction(null)}
			>
				{confirmAction && (
					<AlertDialogContent size="sm">
						<AlertDialogHeader>
							<AlertDialogMedia
								className={
									confirmAction === "delete"
										? "bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400"
										: "bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400"
								}
							>
								<AlertTriangleIcon />
							</AlertDialogMedia>
							<AlertDialogTitle>
								{confirmActionConfig[confirmAction].title}
							</AlertDialogTitle>
							<AlertDialogDescription>
								{confirmActionConfig[confirmAction].description}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={isLoading !== null}>
								Cancel
							</AlertDialogCancel>
							<AlertDialogAction
								variant={confirmActionConfig[confirmAction].variant}
								disabled={isLoading !== null}
								onClick={confirmActionConfig[confirmAction].onConfirm}
							>
								{isLoading
									? "Processing..."
									: confirmActionConfig[confirmAction].actionLabel}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				)}
			</AlertDialog>
		</div>
	);
}
