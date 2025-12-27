"use client";

import { useState } from "react";
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
}: {
	changes: ConfigChange[];
	isOpen: boolean;
	onClose: () => void;
	onDeploy: () => void;
	isDeploying: boolean;
}) {
	if (!isOpen) return null;

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Pending Changes</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					{changes.map((change, i) => (
						<div
							key={i}
							className="flex items-center gap-2 p-3 bg-muted rounded-md text-sm"
						>
							<span className="font-medium flex-shrink-0">{change.field}:</span>
							<span className="text-muted-foreground truncate">
								{change.from}
							</span>
							<ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
							<span className="text-foreground truncate">{change.to}</span>
						</div>
					))}
				</div>
				<div className="flex justify-end gap-2 pt-4">
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button
						onClick={onDeploy}
						disabled={isDeploying}
						className="bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white"
					>
						{isDeploying ? "Deploying..." : "Deploy Now"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export function PendingChangesBar({
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

	if (changes.length === 0) return null;

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
			<div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
				<div className="flex items-center gap-2 px-2 py-1.5 bg-zinc-100 dark:bg-zinc-800 border border-emerald-500 dark:border-emerald-600 rounded-lg shadow-lg">
					<span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 px-2">
						{changes.length} pending change{changes.length !== 1 ? "s" : ""}
					</span>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setShowModal(true)}
					>
						View Details
					</Button>
					<Button
						onClick={handleDeploy}
						disabled={isDeploying}
						className="bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white px-6"
					>
						{isDeploying ? "Deploying..." : "Deploy"}
					</Button>
				</div>
			</div>
			<PendingChangesModal
				changes={changes}
				isOpen={showModal}
				onClose={() => setShowModal(false)}
				onDeploy={handleDeploy}
				isDeploying={isDeploying}
			/>
		</>
	);
}
