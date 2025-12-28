"use client";

import { useState, useEffect, memo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Globe, Lock, Settings, X, HelpCircle, Plus } from "lucide-react";
import { updateServiceConfig } from "@/actions/projects";
import type { Service, StagedPort } from "./types";

type Server = {
	id: string;
	name: string;
	publicIp: string | null;
};

function DnsInstructionsModal({ servers }: { servers: Server[] }) {
	const serversWithIp = servers.filter((s) => s.publicIp);

	return (
		<Dialog>
			<DialogTrigger
				render={
					<Button variant="ghost" size="sm">
						<HelpCircle className="h-4 w-4" />
					</Button>
				}
			/>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>DNS Configuration</DialogTitle>
				</DialogHeader>
				<div className="space-y-4">
					<p className="text-sm text-muted-foreground">
						Configure DNS A records pointing to your servers.
					</p>
					{serversWithIp.length > 0 ? (
						<>
							<div className="space-y-2">
								{serversWithIp.map((server) => (
									<div
										key={server.id}
										className="flex items-center justify-between bg-muted px-3 py-2 rounded-md text-sm"
									>
										<span>{server.name}</span>
										<code className="font-mono">{server.publicIp}</code>
									</div>
								))}
							</div>
							<div className="text-xs text-muted-foreground space-y-1">
								<p>Type: A | TTL: 300</p>
							</div>
						</>
					) : (
						<p className="text-sm text-muted-foreground">
							No servers with public IPs available.
						</p>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

export const PortsSection = memo(function PortsSection({
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
			domain: p.domain,
		})),
	);
	const [newPort, setNewPort] = useState("");
	const [visibility, setVisibility] = useState<"private" | "public">("private");
	const [domain, setDomain] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [servers, setServers] = useState<Server[]>([]);

	useEffect(() => {
		fetch("/api/servers")
			.then((res) => res.json())
			.then(setServers)
			.catch(() => {});
	}, []);

	const originalPortIds = new Set(service.ports.map((p) => p.id));
	const stagedPortIds = new Set(stagedPorts.filter((p) => !p.isNew).map((p) => p.id));
	const addedPorts = stagedPorts.filter((p) => p.isNew);
	const removedPortIds = [...originalPortIds].filter((id) => !stagedPortIds.has(id));
	const hasChanges = addedPorts.length > 0 || removedPortIds.length > 0;

	const isPublic = visibility === "public";
	const canAdd =
		newPort &&
		!stagedPorts.some((p) => p.port === parseInt(newPort)) &&
		(!isPublic || domain.trim());

	const handleAdd = () => {
		const port = parseInt(newPort);
		if (isNaN(port) || port <= 0 || port > 65535) return;

		setStagedPorts([
			...stagedPorts,
			{
				id: `new-${Date.now()}`,
				port,
				isPublic,
				domain: isPublic ? domain.trim().toLowerCase() : null,
				isNew: true,
			},
		]);
		setNewPort("");
		setDomain("");
		setVisibility("private");
	};

	const handleRemove = (portId: string) => {
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
						domain: p.domain,
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
		const deployment = service.deployments.find((d) => d.status === "running");
		if (!deployment?.server?.wireguardIp) return null;
		const depPort = deployment.ports.find((p) => p.containerPort === port.port);
		return depPort ? `${deployment.server.wireguardIp}:${depPort.hostPort}` : null;
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
										port.isNew ? "bg-primary/10 border border-primary/20" : "bg-muted"
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
										{port.isPublic && port.domain && (
											<span className="text-xs text-muted-foreground">{port.domain}</span>
										)}
										{!port.isPublic && privateUrl && (
											<span className="text-xs text-muted-foreground">{privateUrl}</span>
										)}
									</div>
									<button
										type="button"
										onClick={() => handleRemove(port.id)}
										className="text-muted-foreground hover:text-foreground"
									>
										<X className="h-4 w-4" />
									</button>
								</div>
							);
						})}
					</div>
				)}

				<div className="flex flex-wrap items-center gap-2">
					<Input
						type="number"
						placeholder="Port"
						value={newPort}
						onChange={(e) => setNewPort(e.target.value)}
						className="w-20"
						min={1}
						max={65535}
					/>
					<Select
						value={visibility}
						onValueChange={(v) => setVisibility(v as "private" | "public")}
					>
						<SelectTrigger className="w-24">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="private">
								<Lock className="h-3 w-3" />
								Private
							</SelectItem>
							<SelectItem value="public">
								<Globe className="h-3 w-3" />
								Public
							</SelectItem>
						</SelectContent>
					</Select>
					{isPublic && (
						<>
							<Input
								type="text"
								placeholder="api.example.com"
								value={domain}
								onChange={(e) => setDomain(e.target.value)}
								className="flex-1 min-w-32"
							/>
							<DnsInstructionsModal servers={servers} />
						</>
					)}
					<Button size="sm" variant="outline" onClick={handleAdd} disabled={!canAdd}>
						<Plus className="h-4 w-4" />
					</Button>
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
});
