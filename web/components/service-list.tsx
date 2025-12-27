"use client";

import useSWR from "swr";
import { useState, useReducer } from "react";
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
import { Globe, HeartPulse, Lock, Settings, X } from "lucide-react";
import {
	deployService,
	deleteService,
	stopDeployment,
	deleteDeployment,
	updateServicePorts,
	updateServiceHealthCheck,
	getOnlineServers,
	type ServerPlacement,
	type HealthCheckConfig,
} from "@/actions/projects";
import { Spinner } from "./ui/spinner";
import { CreateServiceDialog } from "./create-service-dialog";

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
	healthStatus: "none" | "starting" | "healthy" | "unhealthy" | null;
	ports: DeploymentPort[];
	server: { name: string; wireguardIp: string | null } | null;
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
	replicas: number;
	healthCheckCmd: string | null;
	healthCheckInterval: number | null;
	healthCheckTimeout: number | null;
	healthCheckRetries: number | null;
	healthCheckStartPeriod: number | null;
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

type ServerInfo = {
	id: string;
	name: string;
	wireguardIp: string | null;
};

function DeployDialog({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const [servers, setServers] = useState<ServerInfo[]>([]);
	const [placements, setPlacements] = useState<Record<string, number>>({});
	const [isLoading, setIsLoading] = useState(false);
	const [isDeploying, setIsDeploying] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const totalReplicas = Object.values(placements).reduce(
		(sum, n) => sum + n,
		0,
	);
	const isValid = totalReplicas >= 1 && totalReplicas <= 10;

	const loadServers = async () => {
		setIsLoading(true);
		setError(null);
		try {
			const onlineServers = await getOnlineServers();
			setServers(onlineServers);

			const currentPlacements: Record<string, number> = {};
			for (const s of onlineServers) {
				const count = service.deployments.filter(
					(d) =>
						d.serverId === s.id &&
						(d.status === "running" ||
							d.status === "pending" ||
							d.status === "pulling"),
				).length;
				currentPlacements[s.id] = count;
			}
			setPlacements(currentPlacements);
		} catch (err) {
			setError("Failed to load servers");
		} finally {
			setIsLoading(false);
		}
	};

	const handleOpenChange = (open: boolean) => {
		setIsOpen(open);
		if (open) {
			loadServers();
		}
	};

	const handleDeploy = async () => {
		setIsDeploying(true);
		setError(null);
		try {
			const placementList: ServerPlacement[] = Object.entries(placements).map(
				([serverId, replicas]) => ({ serverId, replicas }),
			);
			await deployService(service.id, placementList);
			onUpdate();
			setIsOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Deployment failed");
		} finally {
			setIsDeploying(false);
		}
	};

	const updateReplicas = (serverId: string, value: number) => {
		setPlacements((prev) => ({
			...prev,
			[serverId]: Math.max(0, Math.min(10, value)),
		}));
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<DialogTrigger render={<Button size="sm" />}>Deploy</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Deploy {service.name}</DialogTitle>
				</DialogHeader>

				{isLoading ? (
					<div className="flex items-center justify-center py-8">
						<Spinner />
					</div>
				) : servers.length === 0 ? (
					<p className="text-sm text-muted-foreground py-4">
						No online servers available
					</p>
				) : (
					<div className="space-y-4">
						<p className="text-sm text-muted-foreground">
							Set replicas per server (0-10 each, at least 1 total)
						</p>
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
													(placements[server.id] || 0) - 1,
												)
											}
											disabled={(placements[server.id] || 0) <= 0}
										>
											-
										</Button>
										<Input
											type="number"
											value={placements[server.id] || 0}
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
													(placements[server.id] || 0) + 1,
												)
											}
											disabled={(placements[server.id] || 0) >= 10}
										>
											+
										</Button>
									</div>
								</div>
							))}
						</div>
						<div className="flex items-center justify-between pt-2 border-t">
							<span className="text-sm">
								Total replicas: <strong>{totalReplicas}</strong>
							</span>
							{!isValid && totalReplicas === 0 && (
								<span className="text-sm text-destructive">
									At least 1 replica required
								</span>
							)}
							{totalReplicas > 10 && (
								<span className="text-sm text-destructive">
									Maximum 10 replicas
								</span>
							)}
						</div>
						{error && <p className="text-sm text-destructive">{error}</p>}
						<Button
							onClick={handleDeploy}
							disabled={!isValid || isDeploying}
							className="w-full"
						>
							{isDeploying ? "Deploying..." : "Deploy"}
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

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

type HealthCheckState = {
	cmd: string;
	interval: number;
	timeout: number;
	retries: number;
	startPeriod: number;
};

type HealthCheckAction =
	| { type: "SET_CMD"; payload: string }
	| { type: "SET_INTERVAL"; payload: number }
	| { type: "SET_TIMEOUT"; payload: number }
	| { type: "SET_RETRIES"; payload: number }
	| { type: "SET_START_PERIOD"; payload: number }
	| { type: "RESET"; payload: HealthCheckState };

function healthCheckReducer(
	state: HealthCheckState,
	action: HealthCheckAction,
): HealthCheckState {
	switch (action.type) {
		case "SET_CMD":
			return { ...state, cmd: action.payload };
		case "SET_INTERVAL":
			return { ...state, interval: action.payload };
		case "SET_TIMEOUT":
			return { ...state, timeout: action.payload };
		case "SET_RETRIES":
			return { ...state, retries: action.payload };
		case "SET_START_PERIOD":
			return { ...state, startPeriod: action.payload };
		case "RESET":
			return action.payload;
		default:
			return state;
	}
}

function getInitialHealthCheckState(service: Service): HealthCheckState {
	return {
		cmd: service.healthCheckCmd || "",
		interval: service.healthCheckInterval ?? 10,
		timeout: service.healthCheckTimeout ?? 5,
		retries: service.healthCheckRetries ?? 3,
		startPeriod: service.healthCheckStartPeriod ?? 30,
	};
}

function HealthCheckDialog({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [state, dispatch] = useReducer(
		healthCheckReducer,
		service,
		getInitialHealthCheckState,
	);

	const hasHealthCheck = !!service.healthCheckCmd;

	const handleOpenChange = (open: boolean) => {
		setIsOpen(open);
		if (open) {
			dispatch({ type: "RESET", payload: getInitialHealthCheckState(service) });
		}
	};

	const handleSave = async () => {
		setIsSaving(true);
		try {
			await updateServiceHealthCheck(service.id, {
				cmd: state.cmd.trim() || null,
				interval: state.interval,
				timeout: state.timeout,
				retries: state.retries,
				startPeriod: state.startPeriod,
			});
			onUpdate();
			setIsOpen(false);
		} catch (error) {
			console.error("Failed to update health check:", error);
		} finally {
			setIsSaving(false);
		}
	};

	const handleRemove = async () => {
		setIsSaving(true);
		try {
			await updateServiceHealthCheck(service.id, {
				cmd: null,
				interval: 10,
				timeout: 5,
				retries: 3,
				startPeriod: 30,
			});
			onUpdate();
			setIsOpen(false);
		} catch (error) {
			console.error("Failed to remove health check:", error);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<DialogTrigger render={<Button variant="outline" size="sm" />}>
				<HeartPulse
					className={`h-4 w-4 mr-1 ${hasHealthCheck ? "text-green-500" : ""}`}
				/>
				Health
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Health Check</DialogTitle>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-2">
						<label className="text-sm font-medium">Command</label>
						<Input
							placeholder="curl -f http://localhost:8080/health || exit 1"
							value={state.cmd}
							onChange={(e) =>
								dispatch({ type: "SET_CMD", payload: e.target.value })
							}
						/>
						<p className="text-xs text-muted-foreground">
							Command to run inside the container. Exit 0 = healthy, non-zero =
							unhealthy.
						</p>
					</div>

					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<label className="text-sm font-medium">Interval (s)</label>
							<Input
								type="number"
								value={state.interval}
								onChange={(e) =>
									dispatch({
										type: "SET_INTERVAL",
										payload: parseInt(e.target.value) || 10,
									})
								}
								min={1}
							/>
						</div>
						<div className="space-y-2">
							<label className="text-sm font-medium">Timeout (s)</label>
							<Input
								type="number"
								value={state.timeout}
								onChange={(e) =>
									dispatch({
										type: "SET_TIMEOUT",
										payload: parseInt(e.target.value) || 5,
									})
								}
								min={1}
							/>
						</div>
						<div className="space-y-2">
							<label className="text-sm font-medium">Retries</label>
							<Input
								type="number"
								value={state.retries}
								onChange={(e) =>
									dispatch({
										type: "SET_RETRIES",
										payload: parseInt(e.target.value) || 3,
									})
								}
								min={1}
							/>
						</div>
						<div className="space-y-2">
							<label className="text-sm font-medium">Start Period (s)</label>
							<Input
								type="number"
								value={state.startPeriod}
								onChange={(e) =>
									dispatch({
										type: "SET_START_PERIOD",
										payload: parseInt(e.target.value) || 30,
									})
								}
								min={0}
							/>
						</div>
					</div>

					<p className="text-xs text-muted-foreground">
						Changes apply on next deployment.
					</p>

					<div className="flex gap-2">
						<Button
							onClick={handleSave}
							disabled={isSaving}
							className="flex-1"
						>
							{isSaving ? "Saving..." : "Save"}
						</Button>
						{hasHealthCheck && (
							<Button
								variant="outline"
								onClick={handleRemove}
								disabled={isSaving}
							>
								Remove
							</Button>
						)}
					</div>
				</div>
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
					<CreateServiceDialog
						projectId={projectId}
						onSuccess={handleActionComplete}
					/>
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
								{(service.ports.filter((p) => p.isPublic && p.subdomain)
									.length > 0 ||
									service.deployments.some((d) => d.status === "running")) && (
									<div className="flex flex-wrap gap-3 mt-2">
										{service.deployments.some(
											(d) => d.status === "running",
										) && (
											<span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
												<Lock className="h-4 w-4" />
												{service.name}.internal
											</span>
										)}
										{service.ports
											.filter((p) => p.isPublic && p.subdomain)
											.map((port) => (
												<a
													key={port.id}
													href={`https://${port.subdomain}.techulus.app`}
													target="_blank"
													rel="noopener noreferrer"
													className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
												>
													<Globe className="h-4 w-4" />
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
								<HealthCheckDialog
									service={service}
									onUpdate={handleActionComplete}
								/>
								<DeployDialog
									service={service}
									onUpdate={handleActionComplete}
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
													{deployment.status === "running" &&
														deployment.healthStatus &&
														deployment.healthStatus !== "none" && (
															<Badge
																variant={
																	deployment.healthStatus === "healthy"
																		? "default"
																		: deployment.healthStatus === "starting"
																			? "secondary"
																			: "destructive"
																}
																className="gap-1"
															>
																<HeartPulse className="h-3 w-3" />
																{deployment.healthStatus}
															</Badge>
														)}
													{isTransitioning && <Spinner />}
												</div>
												<div className="flex items-center gap-2">
													{deployment.status === "running" && (
														<ActionButton
															action={() => stopDeployment(deployment.id)}
															label="Stop"
															loadingLabel="Stopping..."
															variant="destructive"
															onComplete={handleActionComplete}
														/>
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
													<span>
														{deployment.server?.name || "—"}
														{deployment.server?.wireguardIp && (
															<span className="text-muted-foreground font-mono ml-1">
																({deployment.server.wireguardIp})
															</span>
														)}
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
