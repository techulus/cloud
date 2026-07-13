import {
	buildServiceRevisionSpec,
	type ServiceRevisionDraft,
} from "./service-revision-spec";

export type CutoverDeployedConfig = {
	source?: { image?: string };
	hostname?: string | null;
	stateful?: boolean;
	replicas?: Array<{ serverId: string; count: number }>;
	healthCheck?: {
		cmd: string;
		interval: number;
		timeout: number;
		retries: number;
		startPeriod: number;
	} | null;
	startCommand?: string | null;
	resourceLimits?: {
		cpuCores?: number | null;
		memoryMb?: number | null;
	};
	ports?: Array<{
		port: number;
		isPublic: boolean;
		domain: string | null;
		protocol?: "http" | "tcp" | "udp";
		tlsPassthrough?: boolean;
	}>;
	serverless?: {
		enabled: boolean;
		sleepAfterSeconds: number;
		wakeTimeoutSeconds: number;
	};
	secrets?: Array<{
		key: string;
		updatedAt?: string;
	}>;
	secretKeys?: string[];
	volumes?: Array<{ name: string; containerPath: string }>;
};

function assertSecretsMatchDeployedSnapshot(
	liveSecrets: ServiceRevisionDraft["secrets"],
	deployedConfig: CutoverDeployedConfig,
) {
	const deployedSecrets = deployedConfig.secrets;
	if (!deployedSecrets) {
		if (
			liveSecrets.length > 0 ||
			(deployedConfig.secretKeys?.length ?? 0) > 0
		) {
			throw new Error(
				"Cannot verify deployed secrets because the deployed snapshot has no secret timestamps",
			);
		}
		return;
	}

	const liveSecretsByKey = new Map(
		liveSecrets.map((secret) => [secret.key, secret]),
	);
	if (liveSecretsByKey.size !== deployedSecrets.length) {
		throw new Error("Live secrets differ from the deployed snapshot");
	}

	for (const deployedSecret of deployedSecrets) {
		const liveSecret = liveSecretsByKey.get(deployedSecret.key);
		const liveUpdatedAt = liveSecret?.updatedAt
			? new Date(liveSecret.updatedAt).toISOString()
			: null;
		const deployedUpdatedAt = deployedSecret.updatedAt
			? new Date(deployedSecret.updatedAt).toISOString()
			: null;
		if (!liveSecret || !liveUpdatedAt || liveUpdatedAt !== deployedUpdatedAt) {
			throw new Error(
				`Secret ${deployedSecret.key} differs from the deployed snapshot`,
			);
		}
	}
}

export function buildCutoverServiceRevisionSpec({
	liveDraft,
	deployedConfig,
}: {
	liveDraft: ServiceRevisionDraft;
	deployedConfig: CutoverDeployedConfig | null;
}) {
	if (deployedConfig) {
		assertSecretsMatchDeployedSnapshot(liveDraft.secrets, deployedConfig);
	}

	const currentPortsByIdentity = new Map(
		liveDraft.ports.map((port) => [
			`${port.port}:${port.protocol ?? "http"}`,
			port,
		]),
	);
	const deployedPorts = Array.isArray(deployedConfig?.ports)
		? deployedConfig.ports.map((port) => {
				const currentPort = currentPortsByIdentity.get(
					`${port.port}:${port.protocol ?? "http"}`,
				);
				return {
					port: port.port,
					isPublic: port.isPublic,
					domain: port.domain,
					protocol: port.protocol ?? null,
					externalPort: currentPort?.externalPort ?? null,
					tlsPassthrough: port.tlsPassthrough ?? null,
				};
			})
		: null;
	const deployedHealthCheck = deployedConfig
		? (deployedConfig.healthCheck ?? null)
		: undefined;

	return buildServiceRevisionSpec({
		service: {
			...liveDraft.service,
			image: deployedConfig?.source?.image ?? liveDraft.service.image,
			hostname: deployedConfig?.hostname ?? liveDraft.service.hostname,
			stateful: deployedConfig?.stateful ?? liveDraft.service.stateful,
			serverlessEnabled:
				deployedConfig?.serverless?.enabled ??
				liveDraft.service.serverlessEnabled,
			serverlessSleepAfterSeconds:
				deployedConfig?.serverless?.sleepAfterSeconds ??
				liveDraft.service.serverlessSleepAfterSeconds,
			serverlessWakeTimeoutSeconds:
				deployedConfig?.serverless?.wakeTimeoutSeconds ??
				liveDraft.service.serverlessWakeTimeoutSeconds,
			healthCheckCmd: deployedConfig
				? (deployedHealthCheck?.cmd ?? null)
				: liveDraft.service.healthCheckCmd,
			healthCheckInterval: deployedConfig
				? (deployedHealthCheck?.interval ?? null)
				: liveDraft.service.healthCheckInterval,
			healthCheckTimeout: deployedConfig
				? (deployedHealthCheck?.timeout ?? null)
				: liveDraft.service.healthCheckTimeout,
			healthCheckRetries: deployedConfig
				? (deployedHealthCheck?.retries ?? null)
				: liveDraft.service.healthCheckRetries,
			healthCheckStartPeriod: deployedConfig
				? (deployedHealthCheck?.startPeriod ?? null)
				: liveDraft.service.healthCheckStartPeriod,
			startCommand: deployedConfig
				? (deployedConfig.startCommand ?? null)
				: liveDraft.service.startCommand,
			resourceCpuLimit: deployedConfig
				? (deployedConfig.resourceLimits?.cpuCores ?? null)
				: liveDraft.service.resourceCpuLimit,
			resourceMemoryLimitMb: deployedConfig
				? (deployedConfig.resourceLimits?.memoryMb ?? null)
				: liveDraft.service.resourceMemoryLimitMb,
		},
		placements: Array.isArray(deployedConfig?.replicas)
			? deployedConfig.replicas
			: liveDraft.placements,
		ports: deployedPorts ?? liveDraft.ports,
		secrets: liveDraft.secrets,
		volumes: Array.isArray(deployedConfig?.volumes)
			? deployedConfig.volumes
			: liveDraft.volumes,
	});
}
