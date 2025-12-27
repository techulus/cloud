"use client";

import useSWR from "swr";
import { useState, useReducer, useMemo, useEffect } from "react";
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
} from "@/components/ui/dialog";
import {
	Globe,
	HeartPulse,
	Lock,
	Settings,
	X,
	ChevronDown,
	Server,
	ArrowRight,
} from "lucide-react";
import {
	deployService,
	deleteService,
	stopDeployment,
	deleteDeployment,
	updateServiceHealthCheck,
	getOnlineServers,
	updateServiceConfig,
	type ServerPlacement,
} from "@/actions/projects";
import { Spinner } from "./ui/spinner";
import { useRouter } from "next/navigation";
import {
	buildCurrentConfig,
	diffConfigs,
	parseDeployedConfig,
	type ConfigChange,
} from "@/lib/service-config";

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

type ServiceReplica = {
	id: string;
	serverId: string;
	serverName: string;
	count: number;
};

type Service = {
	id: string;
	projectId: string;
	name: string;
	image: string;
	replicas: number;
	deployedConfig: string | null;
	healthCheckCmd: string | null;
	healthCheckInterval: number | null;
	healthCheckTimeout: number | null;
	healthCheckRetries: number | null;
	healthCheckStartPeriod: number | null;
	ports: ServicePort[];
	configuredReplicas: ServiceReplica[];
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

type ServerInfo = {
	id: string;
	name: string;
	wireguardIp: string | null;
};

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

function PortsSection({
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

function ReplicasSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [servers, setServers] = useState<ServerInfo[]>([]);
	const [localReplicas, setLocalReplicas] = useState<Record<string, number>>(
		{},
	);
	const [isLoading, setIsLoading] = useState(true);
	const [isSaving, setIsSaving] = useState(false);

	const configuredReplicas = service.configuredReplicas || [];

	useEffect(() => {
		const loadServers = async () => {
			setIsLoading(true);
			try {
				const onlineServers = await getOnlineServers();
				setServers(onlineServers);

				const replicaMap: Record<string, number> = {};
				for (const r of configuredReplicas) {
					replicaMap[r.serverId] = r.count;
				}
				for (const s of onlineServers) {
					if (!(s.id in replicaMap)) {
						replicaMap[s.id] = 0;
					}
				}
				setLocalReplicas(replicaMap);
			} finally {
				setIsLoading(false);
			}
		};
		loadServers();
	}, [configuredReplicas]);

	const hasChanges = useMemo(() => {
		const configuredMap = new Map(
			configuredReplicas.map((r) => [r.serverId, r.count]),
		);
		for (const [serverId, count] of Object.entries(localReplicas)) {
			const configured = configuredMap.get(serverId) ?? 0;
			if (configured !== count) return true;
		}
		return false;
	}, [configuredReplicas, localReplicas]);

	const updateReplicas = (serverId: string, value: number) => {
		setLocalReplicas((prev) => ({
			...prev,
			[serverId]: Math.max(0, Math.min(10, value)),
		}));
	};

	const handleSave = async () => {
		setIsSaving(true);
		try {
			const replicas = Object.entries(localReplicas)
				.filter(([, count]) => count > 0)
				.map(([serverId, count]) => ({ serverId, count }));
			await updateServiceConfig(service.id, { replicas });
			onUpdate();
		} finally {
			setIsSaving(false);
		}
	};

	const totalReplicas = Object.values(localReplicas).reduce(
		(sum, n) => sum + n,
		0,
	);

	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="text-base flex items-center gap-2">
					<Server className="h-4 w-4" />
					Replicas
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				{isLoading ? (
					<div className="flex justify-center py-4">
						<Spinner />
					</div>
				) : servers.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No online servers available
					</p>
				) : (
					<>
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
													(localReplicas[server.id] || 0) - 1,
												)
											}
											disabled={(localReplicas[server.id] || 0) <= 0}
										>
											-
										</Button>
										<Input
											type="number"
											value={localReplicas[server.id] || 0}
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
													(localReplicas[server.id] || 0) + 1,
												)
											}
											disabled={(localReplicas[server.id] || 0) >= 10}
										>
											+
										</Button>
									</div>
								</div>
							))}
						</div>
						<div className="flex items-center justify-between text-sm">
							<span>
								Total: <strong>{totalReplicas}</strong> replica
								{totalReplicas !== 1 ? "s" : ""}
							</span>
						</div>
						{hasChanges && (
							<div className="pt-3 border-t">
								<Button onClick={handleSave} disabled={isSaving} size="sm">
									{isSaving ? "Saving..." : "Save"}
								</Button>
							</div>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}

function HealthCheckSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [isSaving, setIsSaving] = useState(false);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [state, dispatch] = useReducer(
		healthCheckReducer,
		service,
		getInitialHealthCheckState,
	);

	const hasHealthCheck = !!service.healthCheckCmd;

	const hasChanges = useMemo(() => {
		const originalCmd = service.healthCheckCmd || "";
		const originalInterval = service.healthCheckInterval ?? 10;
		const originalTimeout = service.healthCheckTimeout ?? 5;
		const originalRetries = service.healthCheckRetries ?? 3;
		const originalStartPeriod = service.healthCheckStartPeriod ?? 30;

		return (
			state.cmd !== originalCmd ||
			state.interval !== originalInterval ||
			state.timeout !== originalTimeout ||
			state.retries !== originalRetries ||
			state.startPeriod !== originalStartPeriod
		);
	}, [service, state]);

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
		} catch (error) {
			console.error("Failed to remove health check:", error);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="text-base flex items-center gap-2">
					<HeartPulse
						className={`h-4 w-4 ${hasHealthCheck ? "text-green-500" : ""}`}
					/>
					Health Check
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
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
						Exit 0 = healthy, non-zero = unhealthy
					</p>
				</div>

				<button
					type="button"
					onClick={() => setShowAdvanced(!showAdvanced)}
					className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
				>
					<ChevronDown
						className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
					/>
					Advanced settings
				</button>

				{showAdvanced && (
					<div className="grid grid-cols-2 gap-3 pt-2">
						<div className="space-y-1">
							<label className="text-xs font-medium">Interval (s)</label>
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
						<div className="space-y-1">
							<label className="text-xs font-medium">Timeout (s)</label>
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
						<div className="space-y-1">
							<label className="text-xs font-medium">Retries</label>
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
						<div className="space-y-1">
							<label className="text-xs font-medium">Start Period (s)</label>
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
				)}

				<p className="text-xs text-muted-foreground">
					Changes apply on next deployment.
				</p>

				{(hasChanges || hasHealthCheck) && (
					<div className="flex gap-2">
						{hasChanges && (
							<Button onClick={handleSave} disabled={isSaving} size="sm">
								{isSaving ? "Saving..." : "Save"}
							</Button>
						)}
						{hasHealthCheck && (
							<Button
								variant="outline"
								onClick={handleRemove}
								disabled={isSaving}
								size="sm"
							>
								Remove
							</Button>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function PendingChangesModal({
	changes,
	isOpen,
	onClose,
	onDeploy,
	isDeploying,
}: {
	changes: ConfigChange[];
	isOpen: boolean;
	onClose: () => void;
	onDeploy: () => void;
	isDeploying: boolean;
}) {
	if (!isOpen) return null;

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Pending Changes</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					{changes.map((change, i) => (
						<div
							key={i}
							className="flex items-center gap-2 p-3 bg-muted rounded-md text-sm"
						>
							<span className="font-medium flex-shrink-0">{change.field}:</span>
							<span className="text-muted-foreground truncate">
								{change.from}
							</span>
							<ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
							<span className="text-foreground truncate">{change.to}</span>
						</div>
					))}
				</div>
				<div className="flex justify-end gap-2 pt-4">
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button
						onClick={onDeploy}
						disabled={isDeploying}
						className="bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white"
					>
						{isDeploying ? "Deploying..." : "Deploy Now"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function PendingChangesBar({
	changes,
	service,
	onUpdate,
}: {
	changes: ConfigChange[];
	service: Service;
	onUpdate: () => void;
}) {
	const [showModal, setShowModal] = useState(false);
	const [isDeploying, setIsDeploying] = useState(false);

	if (changes.length === 0) return null;

	const handleDeploy = async () => {
		setIsDeploying(true);
		try {
			const placements: ServerPlacement[] = service.configuredReplicas.map(
				(r) => ({
					serverId: r.serverId,
					replicas: r.count,
				}),
			);
			await deployService(service.id, placements);
			onUpdate();
			setShowModal(false);
		} finally {
			setIsDeploying(false);
		}
	};

	return (
		<>
			<div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
				<div className="flex items-center gap-2 px-2 py-1.5 bg-zinc-100 dark:bg-zinc-800 border border-emerald-500 dark:border-emerald-600 rounded-lg shadow-lg">
					<span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 px-2">
						{changes.length} pending change{changes.length !== 1 ? "s" : ""}
					</span>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setShowModal(true)}
					>
						View Details
					</Button>
					<Button
						onClick={handleDeploy}
						disabled={isDeploying}
						className="bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white px-6"
					>
						{isDeploying ? "Deploying..." : "Deploy"}
					</Button>
				</div>
			</div>
			<PendingChangesModal
				changes={changes}
				isOpen={showModal}
				onClose={() => setShowModal(false)}
				onDeploy={handleDeploy}
				isDeploying={isDeploying}
			/>
		</>
	);
}

export function ServiceDetails({
	projectSlug,
	service: initialService,
}: {
	projectSlug: string;
	service: Service;
}) {
	const router = useRouter();
	const { data: services, mutate } = useSWR<Service[]>(
		`/api/projects/${initialService.projectId}/services`,
		fetcher,
		{
			fallbackData: [initialService],
			refreshInterval: 5000,
			revalidateOnFocus: true,
		},
	);

	const service =
		services?.find((s) => s.id === initialService.id) || initialService;

	const pendingChanges = useMemo(() => {
		const deployed = parseDeployedConfig(service.deployedConfig);
		const replicas = (service.configuredReplicas || []).map((r) => ({
			serverId: r.serverId,
			serverName: r.serverName,
			count: r.count,
		}));
		const ports = (service.ports || []).map((p) => ({
			port: p.port,
			isPublic: p.isPublic,
			subdomain: p.subdomain,
		}));
		const current = buildCurrentConfig(service, replicas, ports);
		return diffConfigs(deployed, current);
	}, [service]);

	const handleActionComplete = () => {
		mutate();
	};

	const handleDelete = async () => {
		await deleteService(service.id);
		router.push(`/dashboard/projects/${projectSlug}`);
	};

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<div>
							<CardTitle className="text-2xl">{service.name}</CardTitle>
							<CardDescription className="font-mono">
								{service.image}
							</CardDescription>
							{(service.ports.filter((p) => p.isPublic && p.subdomain).length >
								0 ||
								service.deployments.some((d) => d.status === "running")) && (
								<div className="flex flex-wrap gap-3 mt-3">
									{service.deployments.some((d) => d.status === "running") && (
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
						<ActionButton
							action={handleDelete}
							label="Delete"
							loadingLabel="Deleting..."
							variant="destructive"
						/>
					</div>
				</CardHeader>
			</Card>

			{service.deployments.length > 0 && (
				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<h2 className="text-lg font-semibold">Deployments</h2>
						<div className="flex items-center gap-2">
							{service.deployments.some((d) => d.status === "running") && (
								<ActionButton
									action={async () => {
										const running = service.deployments.filter(
											(d) => d.status === "running",
										);
										for (const dep of running) {
											await stopDeployment(dep.id);
										}
									}}
									label="Stop All"
									loadingLabel="Stopping..."
									variant="destructive"
									size="sm"
									onComplete={handleActionComplete}
								/>
							)}
							{!service.deployments.some((d) => d.status === "running") &&
								service.deployments.some(
									(d) => d.status === "stopped" || d.status === "failed",
								) &&
								(service.configuredReplicas || []).length > 0 && (
									<ActionButton
										action={async () => {
											const placements = (service.configuredReplicas || []).map(
												(r) => ({
													serverId: r.serverId,
													replicas: r.count,
												}),
											);
											await deployService(service.id, placements);
										}}
										label="Start All"
										loadingLabel="Starting..."
										variant="default"
										size="sm"
										onComplete={handleActionComplete}
									/>
								)}
							{service.deployments.some(
								(d) => d.status === "stopped" || d.status === "failed",
							) && (
								<ActionButton
									action={async () => {
										const deletable = service.deployments.filter(
											(d) => d.status === "stopped" || d.status === "failed",
										);
										for (const dep of deletable) {
											await deleteDeployment(dep.id);
										}
									}}
									label="Delete All"
									loadingLabel="Deleting..."
									variant="destructive"
									size="sm"
									onComplete={handleActionComplete}
								/>
							)}
						</div>
					</div>
					<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
						{service.deployments.map((deployment) => {
							const isTransitioning =
								deployment.status === "pending" ||
								deployment.status === "pulling" ||
								deployment.status === "stopping";
							return (
								<div
									key={deployment.id}
									className="p-3 rounded-lg border bg-card text-sm space-y-2"
								>
									<div className="flex items-center justify-between">
										<span className="font-medium truncate">
											{deployment.server?.name || "—"}
										</span>
										<div className="flex items-center gap-1.5">
											<Badge
												variant={getStatusVariant(deployment.status)}
												className="text-xs"
											>
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
														className="text-xs gap-0.5"
													>
														<HeartPulse className="h-2.5 w-2.5" />
														{deployment.healthStatus}
													</Badge>
												)}
											{isTransitioning && <Spinner />}
										</div>
									</div>
									<div className="flex items-center gap-2 text-xs text-muted-foreground">
										{deployment.containerId && (
											<code className="font-mono bg-muted px-1 py-0.5 rounded">
												{deployment.containerId.slice(0, 8)}
											</code>
										)}
										{deployment.ports.length > 0 && (
											<div className="flex gap-1">
												{deployment.ports.slice(0, 2).map((p) => (
													<code
														key={p.id}
														className="font-mono bg-muted px-1 py-0.5 rounded"
													>
														:{p.hostPort}
													</code>
												))}
												{deployment.ports.length > 2 && (
													<span>+{deployment.ports.length - 2}</span>
												)}
											</div>
										)}
									</div>
							</div>
							);
						})}
					</div>
				</div>
			)}

			{service.deployments.length === 0 && (
				<Card>
					<CardContent className="py-10 text-center">
						<p className="text-muted-foreground">
							No deployments yet. Click Deploy to start.
						</p>
					</CardContent>
				</Card>
			)}

			<ReplicasSection service={service} onUpdate={handleActionComplete} />

			<div className="grid gap-6 md:grid-cols-2">
				<PortsSection service={service} onUpdate={handleActionComplete} />
				<HealthCheckSection service={service} onUpdate={handleActionComplete} />
			</div>

			<PendingChangesBar
				changes={pendingChanges}
				service={service}
				onUpdate={handleActionComplete}
			/>
		</div>
	);
}
