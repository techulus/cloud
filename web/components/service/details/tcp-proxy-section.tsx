"use client";

import { useState, memo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Network, X, Plus, Copy, Check, Lock } from "lucide-react";
import { updateServiceConfig } from "@/actions/projects";
import type { ServiceWithDetails as Service } from "@/db/types";
const PROXY_DOMAIN = process.env.NEXT_PUBLIC_PROXY_DOMAIN;

export const TCPProxySection = memo(function TCPProxySection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [newPort, setNewPort] = useState("");
	const [protocol, setProtocol] = useState<"tcp" | "udp">("tcp");
	const [tlsPassthrough, setTlsPassthrough] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [copiedPort, setCopiedPort] = useState<string | null>(null);

	const tcpUdpPorts = service.ports.filter(
		(p) => p.protocol === "tcp" || p.protocol === "udp",
	);

	const canAdd =
		newPort &&
		parseInt(newPort, 10) > 0 &&
		parseInt(newPort, 10) <= 65535 &&
		!tcpUdpPorts.some(
			(p) => p.port === parseInt(newPort, 10) && p.protocol === protocol,
		) &&
		!isSaving;

	const handleAdd = async () => {
		const port = parseInt(newPort, 10);
		if (Number.isNaN(port) || port <= 0 || port > 65535) {
			return;
		}

		setIsSaving(true);
		try {
			await updateServiceConfig(service.id, {
				ports: {
					add: [
						{
							port,
							isPublic: true,
							domain: null,
							protocol,
							tlsPassthrough: protocol === "tcp" ? tlsPassthrough : undefined,
						},
					],
				},
			});
			setNewPort("");
			setTlsPassthrough(false);
			onUpdate();
		} catch (error) {
			console.error("Failed to add port:", error);
		} finally {
			setIsSaving(false);
		}
	};

	const handleRemove = async (portId: string) => {
		setIsSaving(true);
		try {
			await updateServiceConfig(service.id, {
				ports: { remove: [portId] },
			});
			onUpdate();
		} catch (error) {
			console.error("Failed to remove port:", error);
		} finally {
			setIsSaving(false);
		}
	};

	const getConnectionString = (port: {
		protocol: string | null;
		externalPort: number | null;
	}) => {
		if (!port.externalPort || !PROXY_DOMAIN) return null;
		return `${port.protocol}://${PROXY_DOMAIN}:${port.externalPort}`;
	};

	const copyToClipboard = async (text: string, portId: string) => {
		await navigator.clipboard.writeText(text);
		setCopiedPort(portId);
		setTimeout(() => setCopiedPort(null), 2000);
	};

	return (
		<div className="rounded-lg border">
			<Item className="border-0 border-b rounded-none">
				<ItemMedia variant="icon">
					<Network className="size-5 text-muted-foreground" />
				</ItemMedia>
				<ItemContent>
					<ItemTitle>TCP/UDP Proxy</ItemTitle>
				</ItemContent>
			</Item>
			<div className="p-4 space-y-4">
				<p className="text-base text-muted-foreground">
					Expose TCP/UDP ports directly through the proxy for databases and
					other non-HTTP services.
				</p>

				{tcpUdpPorts.length > 0 && (
					<div className="space-y-2">
						{tcpUdpPorts.map((port) => {
							const connectionString = getConnectionString(port);
							return (
								<div
									key={port.id}
									className="flex flex-col gap-2 px-3 py-2 rounded-md text-base bg-muted"
								>
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-2">
											<span className="font-medium">{port.port}</span>
											<span className="text-sm px-1.5 py-0.5 rounded bg-background">
												{port.protocol?.toUpperCase()}
											</span>
											{port.tlsPassthrough && (
												<span className="text-sm px-1.5 py-0.5 rounded bg-background flex items-center gap-1">
													<Lock className="h-3 w-3" />
													TLS
												</span>
											)}
										</div>
										<button
											type="button"
											onClick={() => handleRemove(port.id)}
											disabled={isSaving}
											className="text-muted-foreground hover:text-foreground disabled:opacity-50"
										>
											<X className="h-4 w-4" />
										</button>
									</div>
									{connectionString && (
										<div className="flex items-center gap-2">
											<code className="text-sm text-muted-foreground font-mono flex-1 truncate">
												{connectionString}
											</code>
											<Button
												variant="ghost"
												size="sm"
												className="h-6 px-2"
												onClick={() =>
													copyToClipboard(connectionString, port.id)
												}
											>
												{copiedPort === port.id ? (
													<Check className="h-3 w-3" />
												) : (
													<Copy className="h-3 w-3" />
												)}
											</Button>
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}

				{!PROXY_DOMAIN && (
					<p className="text-sm text-amber-600">
						NEXT_PUBLIC_PROXY_DOMAIN environment variable is not configured.
						Connection strings will not be available.
					</p>
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
					<div className="flex">
						<Button
							type="button"
							size="sm"
							variant={protocol === "tcp" ? "default" : "outline"}
							className="rounded-r-none"
							onClick={() => setProtocol("tcp")}
						>
							TCP
						</Button>
						<Button
							type="button"
							size="sm"
							variant={protocol === "udp" ? "default" : "outline"}
							className="rounded-l-none border-l-0"
							onClick={() => setProtocol("udp")}
						>
							UDP
						</Button>
					</div>
					{protocol === "tcp" && (
						<label className="flex items-center gap-2 text-base">
							<Switch
								checked={tlsPassthrough}
								onCheckedChange={setTlsPassthrough}
								size="sm"
							/>
							<span className="text-muted-foreground">TLS Passthrough</span>
						</label>
					)}
					<Button
						size="sm"
						variant="outline"
						onClick={handleAdd}
						disabled={!canAdd}
					>
						<Plus className="h-4 w-4" />
					</Button>
				</div>
			</div>
		</div>
	);
});
