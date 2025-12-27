"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Globe, Lock, Settings, X } from "lucide-react";
import { updateServiceConfig } from "@/actions/projects";
import type { Service, StagedPort } from "./types";

export function PortsSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [stagedPorts, setStagedPorts] = useState<StagedPort[]>(() =>
		service.ports.map((p) => ({
			id: p.id,
			port: p.port,
			isPublic: p.isPublic,
			subdomain: p.subdomain,
		})),
	);
	const [newPort, setNewPort] = useState("");
	const [isPublic, setIsPublic] = useState(false);
	const [subdomain, setSubdomain] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	const originalPortIds = new Set(service.ports.map((p) => p.id));
	const stagedPortIds = new Set(
		stagedPorts.filter((p) => !p.isNew).map((p) => p.id),
	);
	const addedPorts = stagedPorts.filter((p) => p.isNew);
	const removedPortIds = [...originalPortIds].filter(
		(id) => !stagedPortIds.has(id),
	);

	const hasChanges = addedPorts.length > 0 || removedPortIds.length > 0;

	const handleAddPort = () => {
		const port = parseInt(newPort);
		if (isNaN(port) || port <= 0 || port > 65535) return;
		if (isPublic && !subdomain.trim()) return;
		if (stagedPorts.some((p) => p.port === port)) return;

		setStagedPorts([
			...stagedPorts,
			{
				id: `new-${Date.now()}`,
				port,
				isPublic,
				subdomain: isPublic ? subdomain.trim() : null,
				isNew: true,
			},
		]);
		setNewPort("");
		setSubdomain("");
		setIsPublic(false);
	};

	const handleRemovePort = (portId: string) => {
		setStagedPorts(stagedPorts.filter((p) => p.id !== portId));
	};

	const handleSave = async () => {
		if (!hasChanges) return;

		setIsSaving(true);
		try {
			await updateServiceConfig(service.id, {
				ports: {
					remove: removedPortIds,
					add: addedPorts.map((p) => ({
						port: p.port,
						isPublic: p.isPublic,
						subdomain: p.subdomain,
					})),
				},
			});
			onUpdate();
		} catch (error) {
			console.error("Failed to update ports:", error);
		} finally {
			setIsSaving(false);
		}
	};

	const getPrivateUrl = (port: StagedPort) => {
		if (port.isNew) return null;
		const runningDeployment = service.deployments.find(
			(d) => d.status === "running",
		);
		if (!runningDeployment?.server?.wireguardIp) return null;
		const deploymentPort = runningDeployment.ports.find(
			(p) => p.containerPort === port.port,
		);
		if (!deploymentPort) return null;
		return `${runningDeployment.server.wireguardIp}:${deploymentPort.hostPort}`;
	};

	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="text-base flex items-center gap-2">
					<Settings className="h-4 w-4" />
					Ports
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				{stagedPorts.length > 0 && (
					<div className="space-y-2">
						{stagedPorts.map((port) => {
							const privateUrl = getPrivateUrl(port);
							return (
								<div
									key={port.id}
									className={`flex items-center justify-between px-3 py-2 rounded-md text-sm ${
										port.isNew
											? "bg-primary/10 border border-primary/20"
											: "bg-muted"
									}`}
								>
									<div className="flex items-center gap-2">
										{port.isPublic ? (
											<Globe className="h-4 w-4 text-primary" />
										) : (
											<Lock className="h-4 w-4 text-muted-foreground" />
										)}
										<span className="font-medium">{port.port}</span>
										{port.isNew && (
											<Badge variant="outline" className="text-xs">
												new
											</Badge>
										)}
										{port.isPublic && port.subdomain && (
											<span className="text-xs text-muted-foreground">
												{port.subdomain}.techulus.app
											</span>
										)}
										{!port.isPublic && privateUrl && (
											<span className="text-xs text-muted-foreground">
												{privateUrl}
											</span>
										)}
									</div>
									<button
										type="button"
										onClick={() => handleRemovePort(port.id)}
										className="text-muted-foreground hover:text-foreground"
									>
										<X className="h-4 w-4" />
									</button>
								</div>
							);
						})}
					</div>
				)}

				<div className="space-y-3">
					<div className="flex gap-2">
						<Input
							type="number"
							placeholder="Port"
							value={newPort}
							onChange={(e) => setNewPort(e.target.value)}
							className="w-24"
							min={1}
							max={65535}
						/>
						<button
							type="button"
							onClick={() => setIsPublic(!isPublic)}
							className={`flex items-center gap-1 px-3 py-1 rounded-md text-sm border transition-colors ${
								isPublic
									? "bg-primary text-primary-foreground border-primary"
									: "bg-muted text-muted-foreground border-transparent hover:text-foreground"
							}`}
						>
							{isPublic ? (
								<Globe className="h-4 w-4" />
							) : (
								<Lock className="h-4 w-4" />
							)}
							{isPublic ? "Public" : "Private"}
						</button>
						<Button
							size="sm"
							variant="outline"
							onClick={handleAddPort}
							disabled={
								!newPort ||
								(isPublic && !subdomain.trim()) ||
								stagedPorts.some((p) => p.port === parseInt(newPort))
							}
						>
							Add
						</Button>
					</div>
					{isPublic && (
						<div className="flex items-center gap-1">
							<Input
								type="text"
								placeholder="subdomain"
								value={subdomain}
								onChange={(e) => setSubdomain(e.target.value)}
								className="w-40"
							/>
							<span className="text-sm text-muted-foreground">
								.techulus.app
							</span>
						</div>
					)}
				</div>

				{hasChanges && (
					<div className="pt-3 border-t">
						<Button onClick={handleSave} disabled={isSaving} size="sm">
							{isSaving ? "Saving..." : "Save"}
						</Button>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
