export type DeploymentPort = {
	id: string;
	hostPort: number;
	containerPort: number;
};

export type Deployment = {
	id: string;
	serviceId: string;
	serverId: string;
	containerId: string | null;
	status: string;
	healthStatus: "none" | "starting" | "healthy" | "unhealthy" | null;
	ports: DeploymentPort[];
	server: { name: string; wireguardIp: string | null } | null;
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

export type Service = {
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
	secretKeys?: string[];
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
