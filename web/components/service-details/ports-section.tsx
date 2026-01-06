"use client";

import { useState, memo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Globe, Lock, Settings, X, HelpCircle, Plus } from "lucide-react";
import { updateServiceConfig, updateServiceHostname } from "@/actions/projects";
import { EditableText } from "@/components/editable-text";
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

	const handleHostnameChange = async (newHostname: string) => {
		await updateServiceHostname(service.id, newHostname);
		router.refresh();
	};

	const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
	const isValidDomain = domain.trim() && domainRegex.test(domain.trim());
	const canAdd =
		newPort &&
		!service.ports.some((p) => p.port === parseInt(newPort, 10)) &&
		isValidDomain &&
		!isSaving;

	const handleAdd = async () => {
		const port = parseInt(newPort, 10);
		if (Number.isNaN(port) || port <= 0 || port > 65535 || !isValidDomain) {
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
		<div className="rounded-lg border">
			<Item className="border-0 border-b rounded-none">
				<ItemMedia variant="icon">
					<Settings className="size-5 text-muted-foreground" />
				</ItemMedia>
				<ItemContent>
					<ItemTitle>Ports</ItemTitle>
				</ItemContent>
			</Item>
			<div className="p-4 space-y-4">
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

				{service.ports.length > 0 && (
					<div className="space-y-2">
						{service.ports.map((port) => (
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
		</div>
	);
});
