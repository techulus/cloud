"use client";

import { AlertTriangle, Lock, Server } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { updateServiceConfig } from "@/actions/projects";
import { ConfigSection } from "@/components/service/details/config-section";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
	Server as ServerType,
	ServiceWithDetails as Service,
} from "@/db/types";

type ServerInfo = Pick<
	ServerType,
	"id" | "name" | "isProxy" | "status" | "wireguardIp"
>;
type PlacementMode = "manual" | "automatic";

const fetcher = async (url: string): Promise<ServerInfo[]> => {
	const res = await fetch(url);
	const servers: ServerInfo[] = await res.json();
	return servers.map(({ id, name, isProxy, status, wireguardIp }) => ({
		id,
		name,
		isProxy,
		status,
		wireguardIp,
	}));
};

const SERVERS_URL = "/api/servers";

export const ReplicasSection = memo(function ReplicasSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const { data: servers, isLoading } = useSWR(SERVERS_URL, fetcher);
	const [localReplicas, setLocalReplicas] = useState<Record<string, number>>(
		{},
	);
	const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
	const [placementMode, setPlacementMode] = useState<PlacementMode>(
		service.serverlessEnabled ? "manual" : service.placementMode,
	);
	const [desiredReplicas, setDesiredReplicas] = useState(service.replicas);
	const [isEditing, setIsEditing] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	const configuredReplicas = useMemo(
		() => service.configuredReplicas || [],
		[service.configuredReplicas],
	);

	useEffect(() => {
		if (!servers) return;

		if (service.stateful) {
			if (configuredReplicas.length > 0) {
				setSelectedServerId(configuredReplicas[0].serverId);
			} else if (service.lockedServerId) {
				setSelectedServerId(service.lockedServerId);
			} else {
				setSelectedServerId(null);
			}
		} else if (!isEditing) {
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
			setPlacementMode(
				service.serverlessEnabled ? "manual" : service.placementMode,
			);
			setDesiredReplicas(service.replicas);
		}
	}, [
		servers,
		configuredReplicas,
		service.stateful,
		service.lockedServerId,
		service.placementMode,
		service.serverlessEnabled,
		service.replicas,
		isEditing,
	]);

	useEffect(() => {
		if (!servers || service.stateful) return;
		setLocalReplicas((current) => {
			const next = { ...current };
			for (const server of servers) next[server.id] ??= 0;
			return next;
		});
	}, [servers, service.stateful]);

	useEffect(() => {
		if (
			!isEditing ||
			service.stateful ||
			placementMode !== service.placementMode
		)
			return;
		if (placementMode === "automatic" && desiredReplicas === service.replicas) {
			setIsEditing(false);
			return;
		}
		if (placementMode === "manual") {
			const configuredMap = new Map(
				configuredReplicas.map((replica) => [replica.serverId, replica.count]),
			);
			const localEntries = Object.entries(localReplicas).filter(
				([, count]) => count > 0,
			);
			if (
				localEntries.length === configuredMap.size &&
				localEntries.every(
					([serverId, count]) => configuredMap.get(serverId) === count,
				)
			) {
				setIsEditing(false);
			}
		}
	}, [
		configuredReplicas,
		desiredReplicas,
		isEditing,
		localReplicas,
		placementMode,
		service.placementMode,
		service.replicas,
		service.stateful,
	]);

	const hasChanges = useMemo(() => {
		if (service.stateful) {
			const currentServerId =
				configuredReplicas.length > 0 ? configuredReplicas[0].serverId : null;
			return selectedServerId !== currentServerId;
		}
		if (placementMode !== service.placementMode) return true;
		if (placementMode === "automatic") {
			return desiredReplicas !== service.replicas;
		}

		const configuredMap = new Map(
			configuredReplicas.map((r) => [r.serverId, r.count]),
		);
		for (const [serverId, count] of Object.entries(localReplicas)) {
			const configured = configuredMap.get(serverId) ?? 0;
			if (configured !== count) return true;
		}
		return false;
	}, [
		configuredReplicas,
		desiredReplicas,
		localReplicas,
		placementMode,
		service.placementMode,
		service.replicas,
		service.stateful,
		selectedServerId,
	]);

	const isChangingServer = useMemo(() => {
		if (!service.stateful || !service.lockedServerId) return false;
		const currentServerId =
			configuredReplicas.length > 0 ? configuredReplicas[0].serverId : null;
		return (
			selectedServerId !== null &&
			selectedServerId !== service.lockedServerId &&
			selectedServerId !== currentServerId
		);
	}, [
		service.stateful,
		service.lockedServerId,
		configuredReplicas,
		selectedServerId,
	]);

	const updateReplicas = useCallback((serverId: string, value: number) => {
		setIsEditing(true);
		setLocalReplicas((prev) => ({
			...prev,
			[serverId]: Math.max(0, Math.min(10, Math.floor(value))),
		}));
	}, []);

	const handleModeChange = (mode: string) => {
		const nextMode = mode as PlacementMode;
		if (nextMode === "automatic" && service.serverlessEnabled) return;
		if (nextMode === placementMode) return;
		setIsEditing(true);
		if (nextMode === "automatic") {
			const manualTotal = Object.values(localReplicas).reduce(
				(sum, count) => sum + count,
				0,
			);
			setDesiredReplicas(Math.max(1, Math.min(10, manualTotal || 1)));
		}
		setPlacementMode(nextMode);
	};

	const handleSave = async () => {
		setIsSaving(true);
		try {
			let replicas: { serverId: string; count: number }[];
			if (service.stateful) {
				replicas = selectedServerId
					? [{ serverId: selectedServerId, count: 1 }]
					: [];
			} else if (placementMode === "manual") {
				replicas = Object.entries(localReplicas)
					.filter(([, count]) => count > 0)
					.map(([serverId, count]) => ({ serverId, count }));
				await updateServiceConfig(service.id, {
					placement: { mode: "manual", placements: replicas },
				});
				onUpdate();
				return;
			} else {
				await updateServiceConfig(service.id, {
					placement: { mode: "automatic", replicas: desiredReplicas },
				});
				onUpdate();
				return;
			}
			await updateServiceConfig(service.id, {
				placement: { mode: "manual", placements: replicas },
			});
			onUpdate();
		} finally {
			setIsSaving(false);
		}
	};

	const totalReplicas = service.stateful
		? selectedServerId
			? 1
			: 0
		: Object.values(localReplicas).reduce((sum, n) => sum + n, 0);
	const formatServerRole = (server: ServerInfo) =>
		server.isProxy ? "Proxy node" : "Worker node";
	const workerUnavailableReason = service.serverlessEnabled
		? "Disable serverless before deploying to worker nodes"
		: null;
	const manualServerUnavailableReason = (server: ServerInfo) => {
		if (server.status !== "online" || !server.wireguardIp) {
			return "Server must be online and configured before placement";
		}
		return service.serverlessEnabled && !server.isProxy
			? workerUnavailableReason
			: null;
	};

	const manualTotalIsValid = totalReplicas >= 1 && totalReplicas <= 10;

	if (service.stateful) {
		return (
			<ConfigSection
				title="Placement"
				summary={
					service.lockedServer?.name || service.lockedServerId || "Not placed"
				}
				summaryMuted={!service.lockedServerId}
			>
				<div className="space-y-4">
					{isLoading ? (
						<div className="flex justify-center py-4">
							<Spinner />
						</div>
					) : !servers || servers.length === 0 ? (
						<Empty className="py-6">
							<EmptyMedia variant="icon">
								<Server />
							</EmptyMedia>
							<EmptyTitle>No online servers available</EmptyTitle>
							<EmptyDescription>
								Add a server to deploy this service.
							</EmptyDescription>
						</Empty>
					) : (
						<>
							{service.lockedServerId && (
								<div className="p-3 bg-muted rounded-md">
									<div className="flex items-center gap-2 mb-1">
										<Lock className="h-4 w-4 text-muted-foreground" />
										<span className="font-medium">
											Currently locked to:{" "}
											{service.lockedServer?.name || service.lockedServerId}
										</span>
									</div>
									<p className="text-sm text-muted-foreground">
										Changing the server will trigger a migration. The service
										will be backed up, moved to the new server, and redeployed.
									</p>
								</div>
							)}
							{isChangingServer && (
								<div className="p-3 bg-yellow-500/10 border border-yellow-500/50 rounded-md">
									<p className="text-sm text-yellow-600 dark:text-yellow-400">
										<AlertTriangle className="h-4 w-4 inline mr-1" />
										Changing server will trigger a migration. The service will
										experience downtime during the migration process.
									</p>
								</div>
							)}
							<p className="text-sm text-muted-foreground">
								{service.lockedServerId
									? "Select a different server to migrate this service."
									: "Select a server for this stateful service. Once deployed, it will be locked to this server."}
							</p>
							<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
								{servers.map((server) => (
									<button
										type="button"
										key={server.id}
										onClick={() => setSelectedServerId(server.id)}
										disabled={!!manualServerUnavailableReason(server)}
										title={manualServerUnavailableReason(server) || undefined}
										className={`flex items-center gap-4 p-3 rounded-md text-left transition-colors ${
											selectedServerId === server.id
												? "bg-primary text-primary-foreground"
												: "bg-muted hover:bg-muted/80"
										} disabled:cursor-not-allowed disabled:opacity-50`}
									>
										<div className="flex-1 min-w-0">
											<p className="font-medium truncate">{server.name}</p>
											<p
												className={`text-xs ${
													selectedServerId === server.id
														? "text-primary-foreground/70"
														: "text-muted-foreground"
												}`}
											>
												{formatServerRole(server)}
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
			</ConfigSection>
		);
	}

	return (
		<ConfigSection
			title="Replicas"
			summary={`${service.placementMode === "automatic" ? "Automatic" : "Manual"} · ${service.replicas} desired`}
			summaryMuted={service.replicas === 0}
		>
			<div className="space-y-4">
				<Tabs value={placementMode} onValueChange={handleModeChange}>
					<TabsList className="w-full sm:w-auto" aria-label="Placement mode">
						{!service.serverlessEnabled && (
							<TabsTrigger value="automatic" className="px-4">
								Automatic
							</TabsTrigger>
						)}
						<TabsTrigger value="manual" className="px-4">
							Manual
						</TabsTrigger>
					</TabsList>
				</Tabs>

				{placementMode === "automatic" ? (
					<div className="space-y-4 rounded-md border bg-muted/30 p-4">
						<div className="space-y-1">
							<label htmlFor="desired-replicas" className="text-sm font-medium">
								Desired replicas
							</label>
							<p className="text-sm text-muted-foreground">
								The control plane distributes replicas evenly across healthy
								nodes and moves them after failures.
							</p>
						</div>
						<Input
							id="desired-replicas"
							type="number"
							min={1}
							max={10}
							step={1}
							value={desiredReplicas}
							onChange={(event) => {
								setIsEditing(true);
								setDesiredReplicas(
									Math.max(
										1,
										Math.min(10, Math.floor(event.target.valueAsNumber || 1)),
									),
								);
							}}
							className="w-24"
							aria-describedby="automatic-replica-range"
						/>
						<p
							id="automatic-replica-range"
							className="text-xs text-muted-foreground"
						>
							Choose between 1 and 10 replicas.
						</p>
						{hasChanges ? (
							<div className="pt-3 border-t">
								<Button onClick={handleSave} disabled={isSaving} size="sm">
									{isSaving ? "Saving..." : "Save"}
								</Button>
							</div>
						) : null}
					</div>
				) : isLoading ? (
					<div className="flex justify-center py-4">
						<Spinner />
					</div>
				) : !servers || servers.length === 0 ? (
					<Empty className="py-6">
						<EmptyMedia variant="icon">
							<Server />
						</EmptyMedia>
						<EmptyTitle>No online servers available</EmptyTitle>
						<EmptyDescription>
							Add a server to place replicas manually, or use automatic
							placement.
						</EmptyDescription>
					</Empty>
				) : (
					<>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
							{servers.map((server) => (
								<div
									key={server.id}
									title={manualServerUnavailableReason(server) || undefined}
									className="flex items-center justify-between gap-4 p-3 bg-muted rounded-md"
								>
									<div className="flex-1 min-w-0">
										<p className="font-medium truncate">{server.name}</p>
										<p className="text-xs text-muted-foreground">
											{formatServerRole(server)}
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
											aria-label={`Replicas on ${server.name}`}
											type="number"
											value={localReplicas[server.id] || 0}
											onChange={(e) =>
												updateReplicas(
													server.id,
													parseInt(e.target.value, 10) || 0,
												)
											}
											disabled={!!manualServerUnavailableReason(server)}
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
											disabled={
												(localReplicas[server.id] || 0) >= 10 ||
												!!manualServerUnavailableReason(server)
											}
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
						{!manualTotalIsValid && (
							<p className="text-sm text-amber-600 dark:text-amber-400">
								Manual placement requires 1 to 10 replicas in total.
							</p>
						)}
						{hasChanges && (
							<div className="pt-3 border-t">
								<Button
									onClick={handleSave}
									disabled={isSaving || !manualTotalIsValid}
									size="sm"
								>
									{isSaving ? "Saving..." : "Save"}
								</Button>
							</div>
						)}
					</>
				)}
			</div>
		</ConfigSection>
	);
});
