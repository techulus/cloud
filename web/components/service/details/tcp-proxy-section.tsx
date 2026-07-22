"use client";

import { Check, Copy, Lock, Plus, X } from "lucide-react";
import { memo, useState } from "react";
import { toast } from "sonner";
import { updateServiceConfig } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ServiceWithDetails as Service } from "@/db/types";

export const TCPUDPPorts = memo(function TCPUDPPorts({
	service,
	edgeDomain,
	onUpdate,
}: {
	service: Service;
	edgeDomain: string | null;
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

	const port = Number(newPort);
	const isValidPort =
		/^\d+$/.test(newPort) &&
		Number.isInteger(port) &&
		port >= 1 &&
		port <= 65535;
	const canAdd =
		isValidPort &&
		!tcpUdpPorts.some((p) => p.port === port && p.protocol === protocol) &&
		!isSaving;

	const handleAdd = async () => {
		if (!isValidPort) {
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
			toast.error(
				error instanceof Error ? error.message : "Failed to add port",
			);
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
			toast.error(
				error instanceof Error ? error.message : "Failed to remove port",
			);
		} finally {
			setIsSaving(false);
		}
	};

	const getConnectionString = (port: {
		protocol: string | null;
		externalPort: number | null;
	}) => {
		if (!port.externalPort || !edgeDomain) return null;
		return `${port.protocol}://${edgeDomain}:${port.externalPort}`;
	};

	const copyToClipboard = async (text: string, portId: string) => {
		await navigator.clipboard.writeText(text);
		setCopiedPort(portId);
		setTimeout(() => setCopiedPort(null), 2000);
	};

	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				Expose TCP/UDP ports directly through the proxy for non-HTTP services.
			</p>

			{tcpUdpPorts.length > 0 && (
				<div className="space-y-2">
					{tcpUdpPorts.map((port) => {
						const connectionString = getConnectionString(port);
						return (
							<div
								key={port.id}
								className="flex flex-col gap-2 px-3 py-2 rounded-md text-sm bg-muted"
							>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<span className="font-medium">{port.port}</span>
										<span className="text-xs px-1.5 py-0.5 rounded bg-background">
											{port.protocol?.toUpperCase()}
										</span>
										{port.tlsPassthrough && (
											<span className="text-xs px-1.5 py-0.5 rounded bg-background flex items-center gap-1">
												<Lock className="h-3 w-3" />
												TLS
											</span>
										)}
									</div>
									<button
										type="button"
										aria-label={`Remove ${port.protocol?.toUpperCase()} port ${port.port}`}
										onClick={() => handleRemove(port.id)}
										disabled={isSaving}
										className="text-muted-foreground hover:text-foreground disabled:opacity-50"
									>
										<X className="h-4 w-4" />
									</button>
								</div>
								{connectionString && (
									<div className="flex items-center gap-2">
										<code className="text-xs text-muted-foreground font-mono flex-1 truncate">
											{connectionString}
										</code>
										<Button
											variant="ghost"
											size="sm"
											aria-label={`Copy ${port.protocol?.toUpperCase()} connection string`}
											className="h-6 px-2"
											onClick={() => copyToClipboard(connectionString, port.id)}
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

			{!edgeDomain && (
				<p className="text-xs text-amber-600">
					The Edge Domain is not configured. Set it in Infrastructure settings
					to show connection strings.
				</p>
			)}

			<div className="flex flex-wrap items-center gap-2">
				<Input
					type="number"
					aria-label="TCP or UDP port"
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
						aria-pressed={protocol === "tcp"}
						className="rounded-r-none"
						onClick={() => setProtocol("tcp")}
					>
						TCP
					</Button>
					<Button
						type="button"
						size="sm"
						variant={protocol === "udp" ? "default" : "outline"}
						aria-pressed={protocol === "udp"}
						className="rounded-l-none border-l-0"
						onClick={() => setProtocol("udp")}
					>
						UDP
					</Button>
				</div>
				{protocol === "tcp" && (
					<div className="flex items-center gap-2 text-sm">
						<Switch
							id={`${service.id}-tls-passthrough`}
							checked={tlsPassthrough}
							onCheckedChange={setTlsPassthrough}
							size="sm"
						/>
						<label
							htmlFor={`${service.id}-tls-passthrough`}
							className="text-muted-foreground"
						>
							TLS Passthrough
						</label>
					</div>
				)}
				<Button
					size="sm"
					variant="outline"
					aria-label={`Add ${protocol.toUpperCase()} port`}
					onClick={handleAdd}
					disabled={!canAdd}
				>
					<Plus className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
});
