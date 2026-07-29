export const SERVICE_REVISION_SCHEMA_VERSION = 3 as const;

export function getDefaultServiceHostname(
	name: string,
	serviceId: string,
): string {
	const dnsLabel = (value: string) =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
	const fromId = dnsLabel(serviceId);
	const value = dnsLabel(name) || (fromId ? `service-${fromId}` : "service");
	if (value.length <= 63) return value;

	const suffix = (fromId || "service").slice(0, 8);
	const prefix = value.slice(0, 62 - suffix.length).replace(/-+$/g, "");
	return `${prefix}-${suffix}`;
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

export type ServiceRevisionPlacementIntent =
	| { mode: "manual" }
	| { mode: "automatic"; replicas: number };

export type ServiceRevisionPort = {
	containerPort: number;
	isPublic: boolean;
	domain: string | null;
	protocol: "http" | "tcp" | "udp";
	externalPort: number | null;
	tlsPassthrough: boolean;
};

export type ServicePortValidationIssue = {
	code: "DUPLICATE_DOMAIN" | "DUPLICATE_PORT" | "INVALID_DOMAIN";
	message: string;
};

export function findServicePortValidationIssue(
	ports: Pick<
		ServiceRevisionPort,
		"containerPort" | "isPublic" | "domain" | "protocol"
	>[],
): ServicePortValidationIssue | null {
	const domains = new Set<string>();
	const portsByNumberAndProtocol = Map.groupBy(
		ports,
		(port) => `${port.containerPort}/${port.protocol}`,
	);

	for (const port of ports) {
		if (port.protocol === "http" && port.isPublic && !port.domain) {
			return {
				code: "INVALID_DOMAIN",
				message: "Public HTTP ports require a domain",
			};
		}
		if ((!port.isPublic || port.protocol !== "http") && port.domain) {
			return {
				code: "INVALID_DOMAIN",
				message: "Only public HTTP ports can define a domain",
			};
		}
		if (port.domain) {
			const domain = port.domain.toLowerCase();
			if (domains.has(domain)) {
				return {
					code: "DUPLICATE_DOMAIN",
					message: "Port domains must be unique",
				};
			}
			domains.add(domain);
		}
	}

	for (const group of portsByNumberAndProtocol.values()) {
		if (
			group.length > 1 &&
			!group.every(
				(port) => port.protocol === "http" && port.isPublic && port.domain,
			)
		) {
			return {
				code: "DUPLICATE_PORT",
				message: `Port ${group[0].containerPort} (${group[0].protocol}) can only be repeated for public HTTP domains`,
			};
		}
	}

	return null;
}

export function validateServiceRevisionPorts(
	ports: Pick<
		ServiceRevisionPort,
		"containerPort" | "isPublic" | "domain" | "protocol"
	>[],
) {
	const issue = findServicePortValidationIssue(ports);
	if (issue) throw new Error(issue.message);
}

export function getPublishedContainerPorts(
	ports: Pick<ServiceRevisionPort, "containerPort">[],
): number[] {
	return [...new Set(ports.map((port) => port.containerPort))].sort(
		(a, b) => a - b,
	);
}

export type ServiceRevisionSecret = {
	key: string;
	encryptedValue: string;
	updatedAt: string;
};

export type ServiceRevisionVolume = {
	name: string;
	containerPath: string;
};

export type ServiceRevisionSource =
	| {
			type: "image";
			image: string;
	  }
	| {
			type: "github";
			repository: string;
			repositoryId: number | null;
			branch: string;
			commitSha: string;
			rootDir: string | null;
			authentication:
				| { type: "anonymous" }
				| { type: "github_app"; installationId: number };
	  };

export type ServiceRevisionSpec = {
	schemaVersion: typeof SERVICE_REVISION_SCHEMA_VERSION;
	image: string;
	source: ServiceRevisionSource;
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
	placement: ServiceRevisionPlacementIntent;
	placements: ServiceRevisionPlacement[];
	ports: ServiceRevisionPort[];
	secrets: ServiceRevisionSecret[];
	volumes: ServiceRevisionVolume[];
};

export type ServiceRevisionDraft = {
	service: {
		id: string;
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
		placementMode?: "manual" | "automatic" | null;
		replicas?: number;
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

export type ServiceRevisionSpecOverrides = {
	image?: string;
	source?: ServiceRevisionSource;
	allowNoPlacements?: boolean;
};

export function getServiceRevisionTotalReplicas(
	specification: Pick<ServiceRevisionSpec, "placement" | "placements">,
): number {
	return specification.placement.mode === "automatic"
		? specification.placement.replicas
		: specification.placements.reduce(
				(sum, placement) => sum + placement.count,
				0,
			);
}

function validateServiceRevisionSpec(
	specification: ServiceRevisionSpec,
	allowNoPlacements: boolean,
) {
	validateServiceRevisionPorts(specification.ports);
	const totalReplicas = getServiceRevisionTotalReplicas(specification);

	if (totalReplicas < 1 && !allowNoPlacements) {
		throw new Error("At least one replica is required");
	}
	if (totalReplicas > 32) {
		throw new Error("Maximum 32 replicas allowed");
	}
	if (
		specification.placement.mode === "automatic" &&
		specification.placements.length
	) {
		throw new Error("Automatic placement snapshots cannot contain placements");
	}
	if (
		specification.placement.mode === "automatic" &&
		specification.volumes.length > 0
	) {
		throw new Error("Services with volumes cannot use automatic placement");
	}
	if (specification.stateful && specification.placement.mode === "automatic") {
		throw new Error("Stateful services cannot use automatic placement");
	}
	if (specification.stateful && totalReplicas !== 1) {
		throw new Error("Stateful services can only have exactly 1 replica");
	}
	if (specification.stateful && specification.placements.length !== 1) {
		throw new Error("Stateful services must be deployed to exactly one server");
	}
	if (
		specification.serverless.enabled &&
		!specification.ports.some(
			(port) =>
				port.isPublic && port.protocol === "http" && port.domain !== null,
		)
	) {
		throw new Error(
			"Serverless services require a public HTTP port with a domain",
		);
	}
}

function compareStrings(a: string, b: string) {
	return a.localeCompare(b, "en");
}

export function buildServiceRevisionSpec(
	draft: ServiceRevisionDraft,
	overrides: ServiceRevisionSpecOverrides = {},
): ServiceRevisionSpec {
	const { service } = draft;
	const image = overrides.image?.trim() || service.image.trim();

	const specification: ServiceRevisionSpec = {
		schemaVersion: SERVICE_REVISION_SCHEMA_VERSION,
		image,
		source: overrides.source ?? { type: "image", image },
		hostname:
			service.hostname?.trim() ||
			getDefaultServiceHostname(service.name, service.id),
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
		placement:
			service.placementMode === "automatic"
				? { mode: "automatic", replicas: service.replicas ?? 1 }
				: { mode: "manual" },
		placements: (service.placementMode === "automatic" ? [] : draft.placements)
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
	validateServiceRevisionSpec(
		specification,
		overrides.allowNoPlacements ?? false,
	);
	return specification;
}
