export type DeploymentPort = {
	id: string;
	hostPort: number;
	containerPort: number;
};

export type DeploymentStatus =
	| "pending"
	| "pulling"
	| "starting"
	| "healthy"
	| "dns_updating"
	| "caddy_updating"
	| "stopping_old"
	| "running"
	| "stopping"
	| "stopped"
	| "failed"
	| "rolled_back";

export type Deployment = {
	id: string;
	serviceId: string;
	serverId: string;
	containerId: string | null;
	status: DeploymentStatus;
	healthStatus: "none" | "starting" | "healthy" | "unhealthy" | null;
	ports: DeploymentPort[];
	server: { name: string; wireguardIp: string | null } | null;
	rolloutId: string | null;
	failedAt: string | null;
};

export type RolloutStatus = "in_progress" | "completed" | "failed" | "rolled_back";

export type Rollout = {
	id: string;
	serviceId: string;
	status: RolloutStatus;
	currentStage: string | null;
	createdAt: string;
	completedAt: string | null;
};

export type ServicePort = {
	id: string;
	serviceId: string;
	port: number;
	isPublic: boolean;
	domain: string | null;
};

export type ServiceReplica = {
	id: string;
	serverId: string;
	serverName: string;
	count: number;
};

export type ServiceSecret = {
	key: string;
	updatedAt: Date | string;
};

export type Service = {
	id: string;
	projectId: string;
	name: string;
	hostname: string | null;
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
	secrets?: ServiceSecret[];
	rollouts?: Rollout[];
};

export type StagedPort = {
	id: string;
	port: number;
	isPublic: boolean;
	domain: string | null;
	isNew?: boolean;
};

export type ServerInfo = {
	id: string;
	name: string;
	wireguardIp: string | null;
};
