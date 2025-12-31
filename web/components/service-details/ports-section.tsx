"use client";

import { useState, useEffect, memo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Globe, Lock, Settings, X, HelpCircle, Plus } from "lucide-react";
import { updateServiceConfig, updateServiceHostname } from "@/actions/projects";
import { EditableText } from "@/components/editable-text";
import { slugify } from "@/lib/utils";
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
	const router = useRouter();
	const [pendingAdds, setPendingAdds] = useState<StagedPort[]>([]);
	const [pendingRemoveIds, setPendingRemoveIds] = useState<Set<string>>(new Set());
	const [newPort, setNewPort] = useState("");
	const [domain, setDomain] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [servers, setServers] = useState<Server[]>([]);

	const hostname = service.hostname || slugify(service.name);

	const handleHostnameChange = async (newHostname: string) => {
		await updateServiceHostname(service.id, newHostname);
		router.refresh();
	};

	useEffect(() => {
		fetch("/api/servers")
			.then((res) => res.json())
			.then(setServers)
			.catch(() => {});
	}, []);

	const existingPorts: StagedPort[] = service.ports
		.filter((p) => !pendingRemoveIds.has(p.id))
		.map((p) => ({
			id: p.id,
			port: p.port,
			isPublic: p.isPublic,
			domain: p.domain,
		}));
	const stagedPorts = [...existingPorts, ...pendingAdds];
	const hasChanges = pendingAdds.length > 0 || pendingRemoveIds.size > 0;

	const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
	const isValidDomain = domain.trim() && domainRegex.test(domain.trim());
	const canAdd =
		newPort &&
		!stagedPorts.some((p) => p.port === parseInt(newPort)) &&
		isValidDomain;

	const handleAdd = () => {
		const port = parseInt(newPort);
		if (isNaN(port) || port <= 0 || port > 65535) return;

		setPendingAdds([
			...pendingAdds,
			{
				id: `new-${Date.now()}`,
				port,
				isPublic: true,
				domain: domain.trim().toLowerCase(),
				isNew: true,
			},
		]);
		setNewPort("");
		setDomain("");
	};

	const handleRemove = (portId: string) => {
		const isPending = pendingAdds.some((p) => p.id === portId);
		if (isPending) {
			setPendingAdds(pendingAdds.filter((p) => p.id !== portId));
		} else {
			setPendingRemoveIds(new Set([...pendingRemoveIds, portId]));
		}
	};

	const handleSave = async () => {
		if (!hasChanges) return;
		setIsSaving(true);
		try {
			await updateServiceConfig(service.id, {
				ports: {
					remove: [...pendingRemoveIds],
					add: pendingAdds.map((p) => ({
						port: p.port,
						isPublic: p.isPublic,
						domain: p.domain,
					})),
				},
			});
			setPendingAdds([]);
			setPendingRemoveIds(new Set());
			onUpdate();
		} catch (error) {
			console.error("Failed to update ports:", error);
		} finally {
			setIsSaving(false);
		}
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
				<div className="flex items-center gap-1 text-sm">
					<Lock className="h-4 w-4 text-muted-foreground" />
					<span className="text-muted-foreground">Private endpoint:</span>
					<EditableText
						value={hostname}
						onChange={handleHostnameChange}
						label="hostname"
						textClassName="text-sm font-mono"
					/>
					<span className="text-muted-foreground">.internal</span>
				</div>

				{stagedPorts.length > 0 && (
					<div className="space-y-2">
						{stagedPorts.map((port) => (
							<div
								key={port.id}
								className={`flex items-center justify-between px-3 py-2 rounded-md text-sm ${
									port.isNew ? "bg-primary/10 border border-primary/20" : "bg-muted"
								}`}
							>
								<div className="flex items-center gap-2">
									<Globe className="h-4 w-4 text-primary" />
									<span className="font-medium">{port.port}</span>
									{port.isNew && (
										<Badge variant="outline" className="text-xs">
											new
										</Badge>
									)}
									{port.domain && (
										<span className="text-xs text-muted-foreground">{port.domain}</span>
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
						))}
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
					<Input
						type="text"
						placeholder="api.example.com"
						value={domain}
						onChange={(e) => setDomain(e.target.value)}
						className="flex-1 min-w-32"
					/>
					<DnsInstructionsModal servers={servers} />
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
