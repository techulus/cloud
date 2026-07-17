"use client";

import { Globe, HelpCircle, Lock, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useState } from "react";
import isFQDN from "validator/es/lib/isFQDN";
import isPort from "validator/es/lib/isPort";
import { updateServiceConfig, updateServiceHostname } from "@/actions/projects";
import { EditableText } from "@/components/core/editable-text";
import { ConfigSection } from "@/components/service/details/config-section";
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

function DnsInstructionsModal() {
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
						Point your domain A record to your proxy servers.
					</p>
					<div className="text-xs text-muted-foreground">
						<p>Type: A | TTL: 300</p>
					</div>
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
	const [newPort, setNewPort] = useState("");
	const [domain, setDomain] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	const hostname = service.hostname || slugify(service.name);
	const httpPorts = service.ports.filter(
		(p) => !p.protocol || p.protocol === "http",
	);

	const handleHostnameChange = async (newHostname: string) => {
		await updateServiceHostname(service.id, newHostname);
		router.refresh();
	};

	const isValidDomain = domain.trim() && isFQDN(domain.trim());
	const isValidPort = newPort && isPort(newPort);
	const canAdd =
		isValidPort &&
		!httpPorts.some((p) => p.port === parseInt(newPort, 10)) &&
		isValidDomain &&
		!isSaving;

	const handleAdd = async () => {
		if (!isValidPort || !isValidDomain) {
			return;
		}
		const port = parseInt(newPort, 10);

		setIsSaving(true);
		try {
			await updateServiceConfig(service.id, {
				ports: {
					add: [
						{
							port,
							isPublic: true,
							domain: domain.trim().toLowerCase(),
						},
					],
				},
			});
			setNewPort("");
			setDomain("");
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

	return (
		<ConfigSection
			title="Ports"
			summary={
				httpPorts.length > 0 ? httpPorts.map((p) => p.port).join(", ") : "None"
			}
			summaryMuted={httpPorts.length === 0}
		>
			<div className="space-y-4">
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
					<DnsInstructionsModal />
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
		</ConfigSection>
	);
});
