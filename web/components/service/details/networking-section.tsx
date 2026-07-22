"use client";

import { Check, Copy, Globe, HelpCircle, Lock, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useState } from "react";
import { toast } from "sonner";
import isFQDN from "validator/es/lib/isFQDN";
import { updateServiceConfig, updateServiceHostname } from "@/actions/projects";
import { EditableText } from "@/components/core/editable-text";
import { ConfigSection } from "@/components/service/details/config-section";
import { TCPUDPPorts } from "@/components/service/details/tcp-proxy-section";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ServiceWithDetails as Service } from "@/db/types";
import { slugify } from "@/lib/utils";

function DnsInstructionsModal({ edgeDomain }: { edgeDomain: string | null }) {
	return (
		<Dialog>
			<DialogTrigger
				render={
					<Button variant="ghost" size="sm" aria-label="DNS configuration">
						<HelpCircle className="h-4 w-4" />
					</Button>
				}
			/>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>DNS Configuration</DialogTitle>
				</DialogHeader>
				<div className="space-y-4">
					{edgeDomain ? (
						<div className="space-y-2 text-sm text-muted-foreground">
							<p>
								For subdomains, create a CNAME record pointing to{" "}
								<code>{edgeDomain}</code>.
							</p>
							<p>
								For apex domains, use an ALIAS or ANAME record pointing to{" "}
								<code>{edgeDomain}</code>.
							</p>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							Configure the Edge Domain in Infrastructure settings to view DNS
							instructions.
						</p>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

export const NetworkingSection = memo(function NetworkingSection({
	service,
	edgeDomain,
	autoSubdomainDomain,
	onUpdate,
}: {
	service: Service;
	edgeDomain: string | null;
	autoSubdomainDomain: string | null;
	onUpdate: () => void;
}) {
	const router = useRouter();
	const initialHostname = service.hostname || slugify(service.name);
	const [newPort, setNewPort] = useState("");
	const [domain, setDomain] = useState("");
	const [autoSubdomain, setAutoSubdomain] = useState(initialHostname);
	const [domainMode, setDomainMode] = useState<"auto" | "custom">(
		autoSubdomainDomain ? "auto" : "custom",
	);
	const [hostnameOverride, setHostnameOverride] = useState<string | null>(null);
	const [privateEndpointCopied, setPrivateEndpointCopied] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	const hostname = hostnameOverride || initialHostname;
	const autoDomain = autoSubdomainDomain
		? `${autoSubdomain.trim()}.${autoSubdomainDomain}`
		: null;
	const httpPorts = service.ports.filter(
		(p) => !p.protocol || p.protocol === "http",
	);
	const tcpUdpPorts = service.ports.filter(
		(p) => p.protocol === "tcp" || p.protocol === "udp",
	);

	const handleHostnameChange = async (newHostname: string) => {
		const result = await updateServiceHostname(service.id, newHostname);
		if (autoSubdomain === hostname) {
			setAutoSubdomain(result.hostname);
		}
		setHostnameOverride(result.hostname);
		onUpdate();
		router.refresh();
	};

	const copyPrivateEndpoint = async () => {
		await navigator.clipboard.writeText(`${hostname}.internal`);
		setPrivateEndpointCopied(true);
		setTimeout(() => setPrivateEndpointCopied(false), 2000);
	};

	const selectedDomain = domainMode === "auto" ? autoDomain : domain;
	const normalizedDomain = selectedDomain?.trim().toLowerCase() || null;
	const port = Number(newPort);
	const isValidDomain = Boolean(
		normalizedDomain &&
			normalizedDomain.length <= 253 &&
			isFQDN(normalizedDomain),
	);
	const isValidPort =
		/^\d+$/.test(newPort) &&
		Number.isInteger(port) &&
		port >= 1 &&
		port <= 65535;
	const canAdd =
		isValidPort &&
		!httpPorts.some((p) => p.port === port) &&
		isValidDomain &&
		!httpPorts.some((p) => p.domain === normalizedDomain) &&
		!isSaving;

	const handleAdd = async () => {
		if (!isValidPort || !isValidDomain || !normalizedDomain) {
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
							domain: normalizedDomain,
						},
					],
				},
			});
			setNewPort("");
			setDomain("");
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

	return (
		<ConfigSection
			title="Networking"
			keepMounted
			summary={
				service.ports.length > 0
					? [
							...httpPorts.map((p) => `${p.port}/http`),
							...tcpUdpPorts.map((p) => `${p.port}/${p.protocol}`),
						].join(", ")
					: "None"
			}
			summaryMuted={service.ports.length === 0}
		>
			<div className="space-y-6">
				<div className="space-y-4">
					<div>
						<h3 className="text-sm font-medium">Private endpoint</h3>
						<p className="text-sm text-muted-foreground">
							Reach this service privately from other services in the cluster.
						</p>
					</div>
					<div className="flex items-center gap-1 text-sm">
						<Lock className="h-4 w-4 text-muted-foreground" />
						<EditableText
							value={hostname}
							onChange={handleHostnameChange}
							label="hostname"
							textClassName="text-sm font-mono"
						/>
						<span className="text-muted-foreground">.internal</span>
						<Button
							variant="ghost"
							size="sm"
							aria-label="Copy private endpoint"
							className="h-6 px-2"
							onClick={copyPrivateEndpoint}
						>
							{privateEndpointCopied ? (
								<Check className="h-3 w-3" />
							) : (
								<Copy className="h-3 w-3" />
							)}
						</Button>
					</div>
				</div>

				<div className="space-y-4">
					<div>
						<h3 className="text-sm font-medium">HTTP endpoints</h3>
						<p className="text-sm text-muted-foreground">
							Expose HTTP services with an automatic or custom domain.
						</p>
					</div>

					{httpPorts.length > 0 && (
						<div className="space-y-2">
							{httpPorts.map((port) => (
								<div
									key={port.id}
									className="flex items-center justify-between px-3 py-2 rounded-md text-sm bg-muted"
								>
									<div className="flex items-center gap-2">
										<Globe className="h-4 w-4 text-primary" />
										<span className="font-medium">{port.port}</span>
										{port.domain && (
											<span className="text-xs text-muted-foreground">
												{port.domain}
											</span>
										)}
									</div>
									<button
										type="button"
										aria-label={`Remove HTTP port ${port.port}`}
										onClick={() => handleRemove(port.id)}
										disabled={isSaving}
										className="text-muted-foreground hover:text-foreground disabled:opacity-50"
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
							aria-label="HTTP port"
							placeholder="Port"
							value={newPort}
							onChange={(e) => setNewPort(e.target.value)}
							className="w-20"
							min={1}
							max={65535}
						/>
						{autoSubdomainDomain && (
							<div className="flex">
								<Button
									type="button"
									size="sm"
									variant={domainMode === "auto" ? "default" : "outline"}
									aria-pressed={domainMode === "auto"}
									className="rounded-r-none"
									onClick={() => setDomainMode("auto")}
								>
									Automatic
								</Button>
								<Button
									type="button"
									size="sm"
									variant={domainMode === "custom" ? "default" : "outline"}
									aria-pressed={domainMode === "custom"}
									className="rounded-l-none border-l-0"
									onClick={() => setDomainMode("custom")}
								>
									Custom
								</Button>
							</div>
						)}
						{domainMode === "auto" && autoSubdomainDomain ? (
							<div className="flex flex-1 min-w-48">
								<Input
									type="text"
									aria-label="Automatic subdomain"
									value={autoSubdomain}
									onChange={(e) => setAutoSubdomain(e.target.value)}
									className="rounded-r-none"
								/>
								<span className="flex h-8 shrink-0 items-center rounded-r-lg border border-l-0 border-input bg-muted px-2.5 text-sm text-muted-foreground">
									.{autoSubdomainDomain}
								</span>
							</div>
						) : (
							<Input
								type="text"
								aria-label="Custom domain"
								placeholder="api.example.com"
								value={domain}
								onChange={(e) => setDomain(e.target.value)}
								className="flex-1 min-w-32"
							/>
						)}
						{domainMode === "custom" && (
							<DnsInstructionsModal edgeDomain={edgeDomain} />
						)}
						<Button
							size="sm"
							variant="outline"
							aria-label="Add HTTP port"
							onClick={handleAdd}
							disabled={!canAdd}
						>
							<Plus className="h-4 w-4" />
						</Button>
					</div>
				</div>

				<div className="space-y-4">
					<div>
						<h3 className="text-sm font-medium">TCP/UDP endpoints</h3>
					</div>
					<TCPUDPPorts
						service={service}
						edgeDomain={edgeDomain}
						onUpdate={onUpdate}
					/>
				</div>
			</div>
		</ConfigSection>
	);
});
