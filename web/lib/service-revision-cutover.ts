import {
	buildServiceRevisionSpec,
	type ServiceRevisionDraft,
} from "./service-revision-spec";
import type { DeployedConfig } from "./service-config";

export type CutoverDeployedConfig = DeployedConfig;

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
	deployedConfig: CutoverDeployedConfig;
}) {
	assertSecretsMatchDeployedSnapshot(liveDraft.secrets, deployedConfig);

	const currentPortsByIdentity = new Map(
		liveDraft.ports.map((port) => [
			`${port.port}:${port.protocol ?? "http"}`,
			port,
		]),
	);
	const deployedPorts = deployedConfig.ports.map((port) => {
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
	});
	const deployedHealthCheck = deployedConfig.healthCheck ?? null;

	return buildServiceRevisionSpec({
		service: {
			...liveDraft.service,
			image: deployedConfig.source.image,
			hostname: deployedConfig.hostname ?? liveDraft.service.hostname,
			stateful: deployedConfig.stateful ?? liveDraft.service.stateful,
			serverlessEnabled:
				deployedConfig.serverless?.enabled ??
				liveDraft.service.serverlessEnabled,
			serverlessSleepAfterSeconds:
				deployedConfig.serverless?.sleepAfterSeconds ??
				liveDraft.service.serverlessSleepAfterSeconds,
			serverlessWakeTimeoutSeconds:
				deployedConfig.serverless?.wakeTimeoutSeconds ??
				liveDraft.service.serverlessWakeTimeoutSeconds,
			healthCheckCmd: deployedHealthCheck?.cmd ?? null,
			healthCheckInterval: deployedHealthCheck?.interval ?? null,
			healthCheckTimeout: deployedHealthCheck?.timeout ?? null,
			healthCheckRetries: deployedHealthCheck?.retries ?? null,
			healthCheckStartPeriod: deployedHealthCheck?.startPeriod ?? null,
			startCommand: deployedConfig.startCommand ?? null,
			resourceCpuLimit: deployedConfig.resourceLimits?.cpuCores ?? null,
			resourceMemoryLimitMb: deployedConfig.resourceLimits?.memoryMb ?? null,
		},
		placements: deployedConfig.replicas,
		ports: deployedPorts,
		secrets: liveDraft.secrets,
		volumes: Array.isArray(deployedConfig.volumes)
			? deployedConfig.volumes
			: liveDraft.volumes,
	});
}
