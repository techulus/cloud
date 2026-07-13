export const SERVICE_REVISION_SCHEMA_VERSION = 1 as const;

export function getDefaultServiceHostname(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export type ServiceRevisionHealthCheck = {
	cmd: string;
	interval: number;
	timeout: number;
	retries: number;
	startPeriod: number;
};

export type ServiceRevisionPlacement = {
	serverId: string;
	count: number;
};

export type ServiceRevisionPort = {
	containerPort: number;
	isPublic: boolean;
	domain: string | null;
	protocol: "http" | "tcp" | "udp";
	externalPort: number | null;
	tlsPassthrough: boolean;
};

export type ServiceRevisionSecret = {
	key: string;
	encryptedValue: string;
	updatedAt: string;
};

export type ServiceRevisionVolume = {
	name: string;
	containerPath: string;
};

export type ServiceRevisionSpec = {
	schemaVersion: typeof SERVICE_REVISION_SCHEMA_VERSION;
	image: string;
	hostname: string;
	stateful: boolean;
	serverless: {
		enabled: boolean;
		sleepAfterSeconds: number;
		wakeTimeoutSeconds: number;
	};
	healthCheck: ServiceRevisionHealthCheck | null;
	startCommand: string | null;
	resourceLimits: {
		cpuCores: number | null;
		memoryMb: number | null;
	};
	placements: ServiceRevisionPlacement[];
	ports: ServiceRevisionPort[];
	secrets: ServiceRevisionSecret[];
	volumes: ServiceRevisionVolume[];
};

export type ServiceRevisionDraft = {
	service: {
		name: string;
		image: string;
		hostname: string | null;
		stateful: boolean | null;
		serverlessEnabled: boolean | null;
		serverlessSleepAfterSeconds: number | null;
		serverlessWakeTimeoutSeconds: number | null;
		healthCheckCmd: string | null;
		healthCheckInterval: number | null;
		healthCheckTimeout: number | null;
		healthCheckRetries: number | null;
		healthCheckStartPeriod: number | null;
		startCommand: string | null;
		resourceCpuLimit: number | null;
		resourceMemoryLimitMb: number | null;
	};
	placements: Array<{ serverId: string; count: number }>;
	ports: Array<{
		port: number;
		isPublic: boolean;
		domain: string | null;
		protocol: "http" | "tcp" | "udp" | null;
		externalPort: number | null;
		tlsPassthrough: boolean | null;
	}>;
	secrets: Array<{
		key: string;
		encryptedValue: string;
		updatedAt: Date | string;
	}>;
	volumes: Array<{ name: string; containerPath: string }>;
};

function validateServiceRevisionSpec(specification: ServiceRevisionSpec) {
	const totalReplicas = specification.placements.reduce(
		(sum, placement) => sum + placement.count,
		0,
	);

	if (totalReplicas < 1) {
		throw new Error("At least one replica is required");
	}
	if (totalReplicas > 10) {
		throw new Error("Maximum 10 replicas allowed");
	}
	if (specification.stateful && totalReplicas !== 1) {
		throw new Error("Stateful services can only have exactly 1 replica");
	}
	if (specification.stateful && specification.placements.length !== 1) {
		throw new Error("Stateful services must be deployed to exactly one server");
	}
}

function compareStrings(a: string, b: string) {
	return a.localeCompare(b, "en");
}

export function buildServiceRevisionSpec(
	draft: ServiceRevisionDraft,
): ServiceRevisionSpec {
	const { service } = draft;

	const specification: ServiceRevisionSpec = {
		schemaVersion: SERVICE_REVISION_SCHEMA_VERSION,
		image: service.image.trim(),
		hostname:
			service.hostname?.trim() || getDefaultServiceHostname(service.name),
		stateful: service.stateful ?? false,
		serverless: {
			enabled: service.serverlessEnabled ?? false,
			sleepAfterSeconds: Math.max(
				service.serverlessSleepAfterSeconds ?? 300,
				120,
			),
			wakeTimeoutSeconds: service.serverlessWakeTimeoutSeconds ?? 300,
		},
		healthCheck: service.healthCheckCmd
			? {
					cmd: service.healthCheckCmd,
					interval: service.healthCheckInterval ?? 10,
					timeout: service.healthCheckTimeout ?? 5,
					retries: service.healthCheckRetries ?? 3,
					startPeriod: service.healthCheckStartPeriod ?? 30,
				}
			: null,
		startCommand: service.startCommand?.trim() || null,
		resourceLimits: {
			cpuCores: service.resourceCpuLimit,
			memoryMb: service.resourceMemoryLimitMb,
		},
		placements: draft.placements
			.filter((placement) => placement.count > 0)
			.map((placement) => ({
				serverId: placement.serverId,
				count: placement.count,
			}))
			.sort((a, b) => compareStrings(a.serverId, b.serverId)),
		ports: draft.ports
			.map((port) => ({
				containerPort: port.port,
				isPublic: port.isPublic,
				domain: port.domain?.trim() || null,
				protocol: port.protocol ?? "http",
				externalPort: port.externalPort,
				tlsPassthrough: port.tlsPassthrough ?? false,
			}))
			.sort(
				(a, b) =>
					a.containerPort - b.containerPort ||
					compareStrings(a.protocol, b.protocol) ||
					compareStrings(a.domain ?? "", b.domain ?? "") ||
					(a.externalPort ?? 0) - (b.externalPort ?? 0),
			),
		secrets: draft.secrets
			.map((secret) => ({
				key: secret.key,
				encryptedValue: secret.encryptedValue,
				updatedAt:
					secret.updatedAt instanceof Date
						? secret.updatedAt.toISOString()
						: secret.updatedAt,
			}))
			.sort((a, b) => compareStrings(a.key, b.key)),
		volumes: draft.volumes
			.map((volume) => ({
				name: volume.name,
				containerPath: volume.containerPath,
			}))
			.sort(
				(a, b) =>
					compareStrings(a.name, b.name) ||
					compareStrings(a.containerPath, b.containerPath),
			),
	};
	validateServiceRevisionSpec(specification);
	return specification;
}
