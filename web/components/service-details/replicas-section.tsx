"use client";

import { useState, useEffect, useMemo, useRef, memo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Server } from "lucide-react";
import { getOnlineServers, updateServiceConfig } from "@/actions/projects";
import { Spinner } from "@/components/ui/spinner";
import type { Service, ServerInfo } from "./types";

export const ReplicasSection = memo(function ReplicasSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [servers, setServers] = useState<ServerInfo[]>([]);
	const [localReplicas, setLocalReplicas] = useState<Record<string, number>>(
		{},
	);
	const [isLoading, setIsLoading] = useState(true);
	const [isSaving, setIsSaving] = useState(false);
	const hasLoadedRef = useRef(false);

	const configuredReplicas = service.configuredReplicas || [];

	useEffect(() => {
		const loadServers = async () => {
			if (!hasLoadedRef.current) {
				setIsLoading(true);
			}
			try {
				const onlineServers = await getOnlineServers();
				setServers(onlineServers);

				const replicaMap: Record<string, number> = {};
				for (const r of configuredReplicas) {
					replicaMap[r.serverId] = r.count;
				}
				for (const s of onlineServers) {
					if (!(s.id in replicaMap)) {
						replicaMap[s.id] = 0;
					}
				}
				setLocalReplicas(replicaMap);
			} finally {
				setIsLoading(false);
				hasLoadedRef.current = true;
			}
		};
		loadServers();
	}, [configuredReplicas]);

	const hasChanges = useMemo(() => {
		const configuredMap = new Map(
			configuredReplicas.map((r) => [r.serverId, r.count]),
		);
		for (const [serverId, count] of Object.entries(localReplicas)) {
			const configured = configuredMap.get(serverId) ?? 0;
			if (configured !== count) return true;
		}
		return false;
	}, [configuredReplicas, localReplicas]);

	const updateReplicas = (serverId: string, value: number) => {
		setLocalReplicas((prev) => ({
			...prev,
			[serverId]: Math.max(0, Math.min(10, value)),
		}));
	};

	const handleSave = async () => {
		setIsSaving(true);
		try {
			const replicas = Object.entries(localReplicas)
				.filter(([, count]) => count > 0)
				.map(([serverId, count]) => ({ serverId, count }));
			await updateServiceConfig(service.id, { replicas });
			onUpdate();
		} finally {
			setIsSaving(false);
		}
	};

	const totalReplicas = Object.values(localReplicas).reduce(
		(sum, n) => sum + n,
		0,
	);

	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="text-base flex items-center gap-2">
					<Server className="h-4 w-4" />
					Replicas
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				{isLoading ? (
					<div className="flex justify-center py-4">
						<Spinner />
					</div>
				) : servers.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No online servers available
					</p>
				) : (
					<>
						<div className="space-y-3">
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
			</CardContent>
		</Card>
	);
});
