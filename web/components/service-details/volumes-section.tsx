"use client";

import { useState, memo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Item,
	ItemContent,
	ItemMedia,
	ItemTitle,
} from "@/components/ui/item";
import { HardDrive, Trash2, Plus, Lock } from "lucide-react";
import { addServiceVolume, removeServiceVolume } from "@/actions/projects";
import type { Service } from "./types";

export const VolumesSection = memo(function VolumesSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [name, setName] = useState("");
	const [containerPath, setContainerPath] = useState("");
	const [isAdding, setIsAdding] = useState(false);
	const [removingId, setRemovingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (!service.stateful) {
		return null;
	}

	const volumes = service.volumes || [];

	const hasRunningDeployments = service.deployments?.some((d) =>
		["pending", "pulling", "starting", "healthy", "dns_updating", "caddy_updating", "stopping_old", "running"].includes(d.status)
	);

	const handleAdd = async () => {
		if (!name || !containerPath) return;
		setIsAdding(true);
		setError(null);
		try {
			await addServiceVolume(service.id, name, containerPath);
			setName("");
			setContainerPath("");
			onUpdate();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to add volume");
		} finally {
			setIsAdding(false);
		}
	};

	const handleRemove = async (volumeId: string) => {
		setRemovingId(volumeId);
		setError(null);
		try {
			await removeServiceVolume(volumeId);
			onUpdate();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to remove volume");
		} finally {
			setRemovingId(null);
		}
	};

	return (
		<div className="rounded-lg border">
			<Item className="border-0 border-b rounded-none">
				<ItemMedia variant="icon">
					<HardDrive className="size-5 text-muted-foreground" />
				</ItemMedia>
				<ItemContent>
					<ItemTitle>Volumes</ItemTitle>
				</ItemContent>
			</Item>
			<div className="p-4 space-y-4">
				{service.lockedServerId && (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Lock className="h-3 w-3" />
						<span>
							Volume data stored on: {service.lockedServer?.name || service.lockedServerId}
						</span>
					</div>
				)}

				{volumes.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No volumes configured. Add volumes to persist data.
					</p>
				) : (
					<div className="space-y-2">
						{volumes.map((volume) => (
							<div
								key={volume.id}
								className="flex items-center justify-between p-3 bg-muted rounded-md"
							>
								<div>
									<p className="font-medium font-mono text-sm">{volume.name}</p>
									<p className="text-xs text-muted-foreground">
										Mount: {volume.containerPath}
									</p>
								</div>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => handleRemove(volume.id)}
									disabled={removingId === volume.id || hasRunningDeployments}
									title={hasRunningDeployments ? "Stop service before removing volumes" : "Remove volume"}
								>
									<Trash2 className="h-4 w-4" />
								</Button>
							</div>
						))}
					</div>
				)}

				{error && (
					<p className="text-sm text-red-600 dark:text-red-400">{error}</p>
				)}

				{hasRunningDeployments && (
					<p className="text-sm text-amber-600 dark:text-amber-400">
						Stop the service to add or remove volumes
					</p>
				)}

				{!hasRunningDeployments && (
					<div className="flex flex-col sm:flex-row gap-2">
						<Input
							placeholder="Volume name (e.g., data)"
							value={name}
							onChange={(e) => setName(e.target.value)}
							className="flex-1"
						/>
						<Input
							placeholder="Container path (e.g., /data)"
							value={containerPath}
							onChange={(e) => setContainerPath(e.target.value)}
							className="flex-1"
						/>
						<Button
							onClick={handleAdd}
							disabled={isAdding || !name || !containerPath}
							size="icon"
						>
							<Plus className="h-4 w-4" />
						</Button>
					</div>
				)}
			</div>
		</div>
	);
});
