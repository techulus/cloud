"use client";

import useSWR from "swr";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Globe, Lock, Settings, X } from "lucide-react";
import {
	deployService,
	deleteService,
	stopDeployment,
	deleteDeployment,
	syncDeploymentRoute,
	updateServicePorts,
} from "@/actions/projects";
import { Spinner } from "./ui/spinner";

type DeploymentPort = {
	id: string;
	hostPort: number;
	containerPort: number;
};

type Deployment = {
	id: string;
	serviceId: string;
	serverId: string;
	containerId: string | null;
	status: string;
	ports: DeploymentPort[];
	server: { wireguardIp: string | null } | null;
};

type ServicePort = {
	id: string;
	serviceId: string;
	port: number;
	isPublic: boolean;
	subdomain: string | null;
};

type Service = {
	id: string;
	projectId: string;
	name: string;
	image: string;
	ports: ServicePort[];
	deployments: Deployment[];
};

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function getStatusVariant(status: string) {
	switch (status) {
		case "running":
			return "default";
		case "pending":
		case "pulling":
		case "stopping":
			return "secondary";
		case "stopped":
			return "outline";
		case "failed":
			return "destructive";
		default:
			return "secondary";
	}
}

function ActionButton({
	action,
	label,
	loadingLabel,
	variant = "default",
	size = "sm",
	onComplete,
}: {
	action: () => Promise<unknown>;
	label: string;
	loadingLabel: string;
	variant?:
		| "default"
		| "destructive"
		| "outline"
		| "secondary"
		| "ghost"
		| "link";
	size?: "default" | "sm" | "lg" | "icon";
	onComplete?: () => void;
}) {
	const [isLoading, setIsLoading] = useState(false);

	const handleClick = async () => {
		setIsLoading(true);
		try {
			await action();
			onComplete?.();
		} catch (error) {
			console.error("Action failed:", error);
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<Button
			onClick={handleClick}
			disabled={isLoading}
			variant={variant}
			size={size}
		>
			{isLoading ? loadingLabel : label}
		</Button>
	);
}

type StagedPort = {
	id: string;
	port: number;
	isPublic: boolean;
	subdomain: string | null;
	isNew?: boolean;
};

type PortChange = {
	action: "add" | "remove";
	portId?: string;
	port?: number;
	isPublic?: boolean;
	subdomain?: string;
};

function PortManagerDialog({
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
	const [isOpen, setIsOpen] = useState(false);

	const hasRunningDeployments = service.deployments.some(
		(d) =>
			d.status === "running" ||
			d.status === "pending" ||
			d.status === "pulling",
	);

	const hasAnyDeployment = service.deployments.length > 0;

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
		const changes: PortChange[] = [];

		for (const portId of removedPortIds) {
			changes.push({ action: "remove", portId });
		}

		for (const port of addedPorts) {
			changes.push({
				action: "add",
				port: port.port,
				isPublic: port.isPublic,
				subdomain: port.subdomain || undefined,
			});
		}

		if (changes.length === 0) return;

		setIsSaving(true);
		try {
			await updateServicePorts(service.id, changes);
			onUpdate();
			setIsOpen(false);
		} catch (error) {
			console.error("Failed to update ports:", error);
		} finally {
			setIsSaving(false);
		}
	};

	const handleOpenChange = (open: boolean) => {
		setIsOpen(open);
		if (open) {
			setStagedPorts(
				service.ports.map((p) => ({
					id: p.id,
					port: p.port,
					isPublic: p.isPublic,
					subdomain: p.subdomain,
				})),
			);
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
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<DialogTrigger render={<Button variant="outline" size="sm" />}>
				<Settings className="h-4 w-4 mr-1" />
				Ports {service.ports.length > 0 && `(${service.ports.length})`}
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Manage Ports</DialogTitle>
				</DialogHeader>

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

				{hasAnyDeployment ? (
					<div className="space-y-3 pt-2 border-t">
						<p className="text-sm font-medium">Add Port</p>
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
							Add Port
						</Button>
					</div>
				) : (
					<p className="text-sm text-muted-foreground pt-2 border-t">
						Deploy the service first to add ports
					</p>
				)}

				{hasChanges && (
					<div className="pt-2 border-t">
						{hasRunningDeployments && (
							<p className="text-xs text-muted-foreground mb-2">
								This will trigger a redeployment
							</p>
						)}
						<Button onClick={handleSave} disabled={isSaving} className="w-full">
							{isSaving
								? "Saving..."
								: hasRunningDeployments
									? "Save & Redeploy"
									: "Save Changes"}
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

export function ServiceList({
	projectId,
	initialServices,
}: {
	projectId: string;
	initialServices: Service[];
}) {
	const { data: services, mutate } = useSWR<Service[]>(
		`/api/projects/${projectId}/services`,
		fetcher,
		{
			fallbackData: initialServices,
			refreshInterval: 5000,
			revalidateOnFocus: true,
		},
	);

	const handleActionComplete = () => {
		mutate();
	};

	if (!services || services.length === 0) {
		return (
			<Card>
				<CardContent className="py-10 text-center">
					<p className="text-muted-foreground mb-4">
						No services yet. Add your first service to deploy.
					</p>
					<Link href={`/dashboard/projects/${projectId}/services/new`}>
						<Button>Add Service</Button>
					</Link>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="grid gap-4">
			{services.map((service) => (
				<Card key={service.id}>
					<CardHeader>
						<div className="flex items-center justify-between">
							<div>
								<CardTitle>{service.name}</CardTitle>
								<CardDescription>{service.image}</CardDescription>
								{service.ports.filter((p) => p.isPublic && p.subdomain).length >
									0 && (
									<div className="flex flex-wrap gap-2 mt-2">
										{service.ports
											.filter((p) => p.isPublic && p.subdomain)
											.map((port) => (
												<a
													key={port.id}
													href={`https://${port.subdomain}.techulus.app`}
													target="_blank"
													rel="noopener noreferrer"
													className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
												>
													<Globe className="h-3 w-3" />
													{port.subdomain}.techulus.app
												</a>
											))}
									</div>
								)}
							</div>
							<div className="flex items-center gap-2">
								<PortManagerDialog
									service={service}
									onUpdate={handleActionComplete}
								/>
								<ActionButton
									action={() => deployService(service.id)}
									label="Deploy"
									loadingLabel="Deploying..."
									onComplete={handleActionComplete}
								/>
								<ActionButton
									action={() => deleteService(service.id)}
									label="Delete"
									loadingLabel="Deleting..."
									variant="outline"
									onComplete={handleActionComplete}
								/>
							</div>
						</div>
					</CardHeader>
					{service.deployments.length > 0 && (
						<CardContent>
							<div className="space-y-2">
								<p className="text-sm font-medium">Deployments</p>
								{service.deployments.map((deployment) => {
									const isTransitioning =
										deployment.status === "pending" ||
										deployment.status === "pulling" ||
										deployment.status === "stopping";
									return (
										<div
											key={deployment.id}
											className="border rounded-md p-3 space-y-2"
										>
											<div className="flex items-center justify-between">
												<div className="flex items-center gap-2">
													<Badge variant={getStatusVariant(deployment.status)}>
														{deployment.status}
													</Badge>
													{isTransitioning && <Spinner />}
												</div>
												<div className="flex items-center gap-2">
													{deployment.status === "running" && (
														<>
															<ActionButton
																action={() =>
																	syncDeploymentRoute(deployment.id)
																}
																label="Sync"
																loadingLabel="Syncing..."
																variant="outline"
																onComplete={handleActionComplete}
															/>
															<ActionButton
																action={() => stopDeployment(deployment.id)}
																label="Stop"
																loadingLabel="Stopping..."
																variant="destructive"
																onComplete={handleActionComplete}
															/>
														</>
													)}
													{(deployment.status === "stopped" ||
														deployment.status === "failed") && (
														<ActionButton
															action={() => deleteDeployment(deployment.id)}
															label="Delete"
															loadingLabel="Deleting..."
															variant="outline"
															onComplete={handleActionComplete}
														/>
													)}
												</div>
											</div>
											<div className="grid grid-cols-4 gap-x-4 gap-y-1 text-sm">
												<div className="flex items-center gap-2">
													<span className="text-muted-foreground">Server</span>
													<span className="font-mono">
														{deployment.server?.wireguardIp || "—"}
													</span>
												</div>
												{deployment.containerId && (
													<div className="flex items-center gap-2">
														<span className="text-muted-foreground">
															Container
														</span>
														<code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
															{deployment.containerId.slice(0, 12)}
														</code>
													</div>
												)}
												{deployment.ports.length > 0 && (
													<div className="flex items-center gap-2 col-span-2">
														<span className="text-muted-foreground">Ports</span>
														<div className="flex flex-wrap gap-1">
															{deployment.ports.map((p) => (
																<code
																	key={p.id}
																	className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded"
																>
																	{p.containerPort}→{p.hostPort}
																</code>
															))}
														</div>
													</div>
												)}
											</div>
										</div>
									);
								})}
							</div>
						</CardContent>
					)}
				</Card>
			))}
		</div>
	);
}
