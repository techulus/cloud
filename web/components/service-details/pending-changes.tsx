"use client";

import { useState, memo } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ArrowRight } from "lucide-react";
import { deployService, type ServerPlacement } from "@/actions/projects";
import type { ConfigChange } from "@/lib/service-config";
import type { Service } from "./types";

function PendingChangesModal({
	changes,
	isOpen,
	onClose,
	onDeploy,
	isDeploying,
	canDeploy,
}: {
	changes: ConfigChange[];
	isOpen: boolean;
	onClose: () => void;
	onDeploy: () => void;
	isDeploying: boolean;
	canDeploy: boolean;
}) {
	if (!isOpen) return null;

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Pending Changes</DialogTitle>
				</DialogHeader>
				<div className="space-y-3 max-h-[60vh] overflow-y-auto">
					{changes.map((change, i) => (
						<div
							key={i}
							className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 p-3 bg-muted rounded-md text-sm"
						>
							<span className="font-medium flex-shrink-0">{change.field}:</span>
							<div className="flex items-center gap-2 min-w-0">
								<span className="text-muted-foreground truncate">
									{change.from}
								</span>
								<ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
								<span className="text-foreground truncate">{change.to}</span>
							</div>
						</div>
					))}
				</div>
				<div className="flex justify-end gap-2 pt-4">
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button
						onClick={onDeploy}
						disabled={isDeploying || !canDeploy}
						className="bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white"
					>
						{isDeploying ? "Deploying..." : "Deploy Now"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export const PendingChangesBar = memo(function PendingChangesBar({
	changes,
	service,
	onUpdate,
}: {
	changes: ConfigChange[];
	service: Service;
	onUpdate: () => void;
}) {
	const [showModal, setShowModal] = useState(false);
	const [isDeploying, setIsDeploying] = useState(false);

	const totalReplicas = service.configuredReplicas.reduce((sum, r) => sum + r.count, 0);
	const hasNoDeployments = service.deployments.length === 0;
	const hasChanges = changes.length > 0;
	const showBar = hasChanges || (hasNoDeployments && totalReplicas > 0);

	const handleDeploy = async () => {
		setIsDeploying(true);
		try {
			const placements: ServerPlacement[] = service.configuredReplicas.map(
				(r) => ({
					serverId: r.serverId,
					replicas: r.count,
				}),
			);
			await deployService(service.id, placements);
			onUpdate();
			setShowModal(false);
		} finally {
			setIsDeploying(false);
		}
	};

	return (
		<>
			<div
				className={`fixed left-4 right-4 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-50 transition-all duration-300 ease-out ${
					showBar
						? "bottom-4 sm:bottom-6 opacity-100"
						: "-bottom-20 opacity-0 pointer-events-none"
				}`}
			>
				<div className="flex items-center justify-between sm:justify-start gap-2 px-3 py-2 sm:px-2 sm:py-1.5 bg-zinc-100 dark:bg-zinc-800 border border-emerald-500 dark:border-emerald-600 rounded-lg shadow-lg">
					<span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 sm:px-2">
						{hasChanges
							? `${changes.length} change${changes.length !== 1 ? "s" : ""}`
							: "Ready to deploy"}
					</span>
					<div className="flex items-center gap-2">
						{hasChanges && (
							<>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setShowModal(true)}
									className="hidden sm:inline-flex"
								>
									View Details
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setShowModal(true)}
									className="sm:hidden"
								>
									View
								</Button>
							</>
						)}
						<Button
							onClick={handleDeploy}
							disabled={isDeploying || totalReplicas === 0}
							size="sm"
							className="bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white px-4 sm:px-6"
						>
							{isDeploying ? "..." : "Deploy"}
						</Button>
					</div>
				</div>
			</div>
			<PendingChangesModal
				changes={changes}
				isOpen={showModal}
				onClose={() => setShowModal(false)}
				onDeploy={handleDeploy}
				isDeploying={isDeploying}
				canDeploy={totalReplicas > 0}
			/>
		</>
	);
});
