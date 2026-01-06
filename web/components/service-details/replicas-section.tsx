"use client";

import { useState, useMemo, useEffect, memo } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Server, Lock, Zap } from "lucide-react";
import {
	updateServiceConfig,
	updateServiceAutoPlace,
	updateServiceReplicas,
} from "@/actions/projects";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type {
	Server as ServerType,
	ServiceWithDetails as Service,
} from "@/db/types";

type ServerInfo = Pick<ServerType, "id" | "name" | "wireguardIp">;
type ServerWithStatus = ServerInfo & { status: string };

const fetcher = async (url: string): Promise<ServerInfo[]> => {
	const res = await fetch(url);
	const servers: ServerWithStatus[] = await res.json();
	return servers.map(({ id, name, wireguardIp }) => ({
		id,
		name,
		wireguardIp,
	}));
};

export const ReplicasSection = memo(function ReplicasSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const { data: servers, isLoading } = useSWR("/api/servers", fetcher);
	const [localReplicas, setLocalReplicas] = useState<Record<string, number>>(
		{},
	);
	const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
	const [isSaving, setIsSaving] = useState(false);
	const [autoPlace, setAutoPlace] = useState(service.autoPlace ?? false);
	const [totalReplicaCount, setTotalReplicaCount] = useState(
		service.replicas ?? 1,
	);

	const configuredReplicas = service.configuredReplicas || [];

	useEffect(() => {
		if (!servers) return;

		if (service.stateful) {
			if (service.lockedServerId) {
				setSelectedServerId(service.lockedServerId);
			} else if (configuredReplicas.length > 0) {
				setSelectedServerId(configuredReplicas[0].serverId);
			} else {
				setSelectedServerId(null);
			}
		} else if (!autoPlace) {
			const replicaMap: Record<string, number> = {};
			for (const r of configuredReplicas) {
				replicaMap[r.serverId] = r.count;
			}
			for (const s of servers) {
				if (!(s.id in replicaMap)) {
					replicaMap[s.id] = 0;
				}
			}
			setLocalReplicas(replicaMap);
		}
	}, [
		servers,
		configuredReplicas,
		service.stateful,
		service.lockedServerId,
		autoPlace,
	]);

	const hasChanges = useMemo(() => {
		if (autoPlace !== (service.autoPlace ?? false)) return true;
		if (autoPlace && totalReplicaCount !== (service.replicas ?? 1)) return true;

		if (service.stateful) {
			const currentServerId =
				configuredReplicas.length > 0 ? configuredReplicas[0].serverId : null;
			return selectedServerId !== currentServerId;
		}

		if (!autoPlace) {
			const configuredMap = new Map(
				configuredReplicas.map((r) => [r.serverId, r.count]),
			);
			for (const [serverId, count] of Object.entries(localReplicas)) {
				const configured = configuredMap.get(serverId) ?? 0;
				if (configured !== count) return true;
			}
		}
		return false;
	}, [
		configuredReplicas,
		localReplicas,
		service.stateful,
		selectedServerId,
		autoPlace,
		service.autoPlace,
		totalReplicaCount,
		service.replicas,
	]);

	const updateReplicas = (serverId: string, value: number) => {
		setLocalReplicas((prev) => ({
			...prev,
			[serverId]: Math.max(0, Math.min(10, value)),
		}));
	};

	const handleAutoPlaceToggle = async (checked: boolean) => {
		setAutoPlace(checked);
	};

	const handleSave = async () => {
		setIsSaving(true);
		try {
			if (autoPlace !== (service.autoPlace ?? false)) {
				await updateServiceAutoPlace(service.id, autoPlace);
			}
			if (autoPlace) {
				if (totalReplicaCount !== (service.replicas ?? 1)) {
					await updateServiceReplicas(service.id, totalReplicaCount);
				}
			} else if (service.stateful) {
				const replicas = selectedServerId
					? [{ serverId: selectedServerId, count: 1 }]
					: [];
				await updateServiceConfig(service.id, { replicas });
			} else {
				const replicas = Object.entries(localReplicas)
					.filter(([, count]) => count > 0)
					.map(([serverId, count]) => ({ serverId, count }));
				await updateServiceConfig(service.id, { replicas });
			}
			onUpdate();
		} finally {
			setIsSaving(false);
		}
	};

	const totalReplicas = autoPlace
		? totalReplicaCount
		: service.stateful
			? selectedServerId
				? 1
				: 0
			: Object.values(localReplicas).reduce((sum, n) => sum + n, 0);

	if (service.stateful) {
		return (
			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<Server className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Placement</ItemTitle>
					</ItemContent>
				</Item>
				<div className="p-4 space-y-4">
					{service.lockedServerId ? (
						<div className="p-3 bg-muted rounded-md">
							<div className="flex items-center gap-2 mb-1">
								<Lock className="h-4 w-4 text-muted-foreground" />
								<span className="font-medium">
									Locked to:{" "}
									{service.lockedServer?.name || service.lockedServerId}
								</span>
							</div>
							<p className="text-sm text-muted-foreground">
								Stateful services cannot be moved between servers. Volume data
								is stored on this machine.
							</p>
						</div>
					) : isLoading ? (
						<div className="flex justify-center py-4">
							<Spinner />
						</div>
					) : !servers || servers.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No online servers available
						</p>
					) : (
						<>
							<p className="text-sm text-muted-foreground">
								Select a server for this stateful service. Once deployed, it
								cannot be moved.
							</p>
							<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
								{servers.map((server) => (
									<button
										type="button"
										key={server.id}
										onClick={() => setSelectedServerId(server.id)}
										className={`flex items-center gap-4 p-3 rounded-md text-left transition-colors ${
											selectedServerId === server.id
												? "bg-primary text-primary-foreground"
												: "bg-muted hover:bg-muted/80"
										}`}
									>
										<div className="flex-1 min-w-0">
											<p className="font-medium truncate">{server.name}</p>
											<p
												className={`text-xs font-mono ${
													selectedServerId === server.id
														? "text-primary-foreground/70"
														: "text-muted-foreground"
												}`}
											>
												{server.wireguardIp}
											</p>
										</div>
									</button>
								))}
							</div>
							{!selectedServerId && (
								<p className="text-sm text-amber-600 dark:text-amber-400">
									Select a server to deploy
								</p>
							)}
							{hasChanges && (
								<div className="pt-3 border-t">
									<Button onClick={handleSave} disabled={isSaving} size="sm">
										{isSaving ? "Saving..." : "Save"}
									</Button>
								</div>
							)}
						</>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="rounded-lg border">
			<Item className="border-0 border-b rounded-none">
				<ItemMedia variant="icon">
					<Server className="size-5 text-muted-foreground" />
				</ItemMedia>
				<ItemContent>
					<ItemTitle>Replicas</ItemTitle>
				</ItemContent>
			</Item>
			<div className="p-4 space-y-4">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Zap className="h-4 w-4 text-muted-foreground" />
						<Label htmlFor="auto-place">Auto-placement</Label>
					</div>
					<Switch
						id="auto-place"
						checked={autoPlace}
						onCheckedChange={handleAutoPlaceToggle}
					/>
				</div>

				{autoPlace ? (
					<>
						<p className="text-sm text-muted-foreground">
							Replicas will be automatically distributed across healthy servers.
							If a server goes offline, replicas are automatically recovered.
						</p>
						<div className="flex items-center gap-4">
							<Label>Total Replicas:</Label>
							<div className="flex items-center gap-2">
								<Button
									variant="outline"
									size="icon"
									className="h-8 w-8"
									onClick={() =>
										setTotalReplicaCount(Math.max(1, totalReplicaCount - 1))
									}
									disabled={totalReplicaCount <= 1}
								>
									-
								</Button>
								<Input
									type="number"
									value={totalReplicaCount}
									onChange={(e) =>
										setTotalReplicaCount(
											Math.max(1, Math.min(10, parseInt(e.target.value) || 1)),
										)
									}
									min={1}
									max={10}
									className="w-16 h-8 text-center"
								/>
								<Button
									variant="outline"
									size="icon"
									className="h-8 w-8"
									onClick={() =>
										setTotalReplicaCount(Math.min(10, totalReplicaCount + 1))
									}
									disabled={totalReplicaCount >= 10}
								>
									+
								</Button>
							</div>
						</div>
						{hasChanges && (
							<div className="pt-3 border-t">
								<Button onClick={handleSave} disabled={isSaving} size="sm">
									{isSaving ? "Saving..." : "Save"}
								</Button>
							</div>
						)}
					</>
				) : isLoading ? (
					<div className="flex justify-center py-4">
						<Spinner />
					</div>
				) : !servers || servers.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No online servers available
					</p>
				) : (
					<>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
							{servers.map((server) => (
								<div
									key={server.id}
									className="flex items-center justify-between gap-4 p-3 bg-muted rounded-md"
								>
									<div className="flex-1 min-w-0">
										<p className="font-medium truncate">{server.name}</p>
										<p className="text-xs text-muted-foreground font-mono">
											{server.wireguardIp}
										</p>
									</div>
									<div className="flex items-center gap-2">
										<Button
											variant="outline"
											size="icon"
											className="h-8 w-8"
											onClick={() =>
												updateReplicas(
													server.id,
													(localReplicas[server.id] || 0) - 1,
												)
											}
											disabled={(localReplicas[server.id] || 0) <= 0}
										>
											-
										</Button>
										<Input
											type="number"
											value={localReplicas[server.id] || 0}
											onChange={(e) =>
												updateReplicas(server.id, parseInt(e.target.value) || 0)
											}
											min={0}
											max={10}
											className="w-16 h-8 text-center"
										/>
										<Button
											variant="outline"
											size="icon"
											className="h-8 w-8"
											onClick={() =>
												updateReplicas(
													server.id,
													(localReplicas[server.id] || 0) + 1,
												)
											}
											disabled={(localReplicas[server.id] || 0) >= 10}
										>
											+
										</Button>
									</div>
								</div>
							))}
						</div>
						<div className="flex items-center justify-between text-sm">
							<span>
								Total: <strong>{totalReplicas}</strong> replica
								{totalReplicas !== 1 ? "s" : ""}
							</span>
						</div>
						{totalReplicas === 0 && (
							<p className="text-sm text-amber-600 dark:text-amber-400">
								Add at least 1 replica to deploy
							</p>
						)}
						{hasChanges && (
							<div className="pt-3 border-t">
								<Button onClick={handleSave} disabled={isSaving} size="sm">
									{isSaving ? "Saving..." : "Save"}
								</Button>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
});
