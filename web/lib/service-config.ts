export type ReplicaConfig = {
	serverId: string;
	serverName: string;
	count: number;
};

export type PortConfig = {
	port: number;
	isPublic: boolean;
	domain: string | null;
	protocol?: "http" | "tcp" | "udp";
	tlsPassthrough?: boolean;
};

export type HealthCheckConfig = {
	cmd: string;
	interval: number;
	timeout: number;
	retries: number;
	startPeriod: number;
};

export type SourceConfig = {
	type: "image";
	image: string;
};

export type SecretConfig = {
	key: string;
	updatedAt: string;
};

export type VolumeConfig = {
	name: string;
	containerPath: string;
};

export type DeployedConfig = {
	source: SourceConfig;
	hostname?: string;
	replicas: ReplicaConfig[];
	healthCheck: HealthCheckConfig | null;
	startCommand?: string | null;
	ports: PortConfig[];
	secretKeys?: string[];
	secrets?: SecretConfig[];
	volumes?: VolumeConfig[];
};

export type ConfigChange = {
	field: string;
	from: string;
	to: string;
};

export function buildCurrentConfig(
	service: {
		image: string;
		hostname: string | null;
		healthCheckCmd: string | null;
		healthCheckInterval: number | null;
		healthCheckTimeout: number | null;
		healthCheckRetries: number | null;
		healthCheckStartPeriod: number | null;
		startCommand: string | null;
	},
	replicas: { serverId: string; serverName: string; count: number }[],
	ports: { port: number; isPublic: boolean; domain: string | null }[],
	secrets?: { key: string; updatedAt: Date | string }[],
	volumes?: { name: string; containerPath: string }[],
): DeployedConfig {
	return {
		source: {
			type: "image",
			image: service.image,
		},
		hostname: service.hostname ?? undefined,
		replicas: replicas.map((r) => ({
			serverId: r.serverId,
			serverName: r.serverName,
			count: r.count,
		})),
		healthCheck: service.healthCheckCmd
			? {
					cmd: service.healthCheckCmd,
					interval: service.healthCheckInterval ?? 10,
					timeout: service.healthCheckTimeout ?? 5,
					retries: service.healthCheckRetries ?? 3,
					startPeriod: service.healthCheckStartPeriod ?? 30,
				}
			: null,
		startCommand: service.startCommand,
		ports: ports.map((p) => ({
			port: p.port,
			isPublic: p.isPublic,
			domain: p.domain,
		})),
		secrets: (secrets ?? []).map((s) => ({
			key: s.key,
			updatedAt:
				s.updatedAt instanceof Date ? s.updatedAt.toISOString() : s.updatedAt,
		})),
		volumes: (volumes ?? []).map((v) => ({
			name: v.name,
			containerPath: v.containerPath,
		})),
	};
}

export function diffConfigs(
	deployed: DeployedConfig | null,
	current: DeployedConfig,
): ConfigChange[] {
	const changes: ConfigChange[] = [];

	if (!deployed) {
		if (current.source.image) {
			changes.push({
				field: "Image",
				from: "(not deployed)",
				to: current.source.image,
			});
		}
		for (const replica of current.replicas) {
			changes.push({
				field: `${replica.serverName} replicas`,
				from: "0",
				to: String(replica.count),
			});
		}
		if (current.healthCheck) {
			changes.push({
				field: "Health check",
				from: "(none)",
				to: current.healthCheck.cmd,
			});
		}
		if (current.startCommand) {
			changes.push({
				field: "Start command",
				from: "(default)",
				to: current.startCommand,
			});
		}
		for (const port of current.ports) {
			const portType = port.isPublic ? "public" : "internal";
			changes.push({
				field: `Port ${port.port}`,
				from: "(none)",
				to: port.domain ? `${portType}, ${port.domain}` : portType,
			});
		}
		for (const secret of current.secrets || []) {
			changes.push({
				field: "Secret",
				from: "(none)",
				to: secret.key,
			});
		}
		for (const volume of current.volumes || []) {
			changes.push({
				field: "Volume",
				from: "(none)",
				to: `${volume.name} → ${volume.containerPath}`,
			});
		}
		return changes;
	}

	if (deployed.source.image !== current.source.image) {
		changes.push({
			field: "Image",
			from: deployed.source.image,
			to: current.source.image,
		});
	}

	if (deployed.hostname !== current.hostname) {
		changes.push({
			field: "Private endpoint",
			from: deployed.hostname ?? "(default)",
			to: current.hostname ?? "(default)",
		});
	}

	const deployedReplicasMap = new Map(
		(deployed.replicas || []).map((r) => [r.serverId, r]),
	);
	const currentReplicasMap = new Map(
		(current.replicas || []).map((r) => [r.serverId, r]),
	);

	for (const [serverId, currentReplica] of currentReplicasMap) {
		const deployedReplica = deployedReplicasMap.get(serverId);
		if (!deployedReplica) {
			changes.push({
				field: `${currentReplica.serverName} replicas`,
				from: "0",
				to: String(currentReplica.count),
			});
		} else if (deployedReplica.count !== currentReplica.count) {
			changes.push({
				field: `${currentReplica.serverName} replicas`,
				from: String(deployedReplica.count),
				to: String(currentReplica.count),
			});
		}
	}

	for (const [serverId, deployedReplica] of deployedReplicasMap) {
		if (!currentReplicasMap.has(serverId)) {
			changes.push({
				field: `${deployedReplica.serverName} replicas`,
				from: String(deployedReplica.count),
				to: "0 (removed)",
			});
		}
	}

	const deployedHc = deployed.healthCheck;
	const currentHc = current.healthCheck;

	if (!deployedHc && currentHc) {
		changes.push({
			field: "Health check",
			from: "(none)",
			to: currentHc.cmd,
		});
	} else if (deployedHc && !currentHc) {
		changes.push({
			field: "Health check",
			from: deployedHc.cmd,
			to: "(removed)",
		});
	} else if (deployedHc && currentHc) {
		if (deployedHc.cmd !== currentHc.cmd) {
			changes.push({
				field: "Health check command",
				from: deployedHc.cmd,
				to: currentHc.cmd,
			});
		}
		if (deployedHc.interval !== currentHc.interval) {
			changes.push({
				field: "Health check interval",
				from: `${deployedHc.interval}s`,
				to: `${currentHc.interval}s`,
			});
		}
		if (deployedHc.timeout !== currentHc.timeout) {
			changes.push({
				field: "Health check timeout",
				from: `${deployedHc.timeout}s`,
				to: `${currentHc.timeout}s`,
			});
		}
		if (deployedHc.retries !== currentHc.retries) {
			changes.push({
				field: "Health check retries",
				from: String(deployedHc.retries),
				to: String(currentHc.retries),
			});
		}
		if (deployedHc.startPeriod !== currentHc.startPeriod) {
			changes.push({
				field: "Health check start period",
				from: `${deployedHc.startPeriod}s`,
				to: `${currentHc.startPeriod}s`,
			});
		}
	}

	if (deployed.startCommand !== current.startCommand) {
		changes.push({
			field: "Start command",
			from: deployed.startCommand || "(default)",
			to: current.startCommand || "(default)",
		});
	}

	const deployedPortsMap = new Map(
		(deployed.ports || []).map((p) => [p.port, p]),
	);
	const currentPortsMap = new Map(
		(current.ports || []).map((p) => [p.port, p]),
	);

	for (const [port, currentPort] of currentPortsMap) {
		const deployedPort = deployedPortsMap.get(port);
		const portType = currentPort.isPublic ? "public" : "internal";
		const portDesc = currentPort.domain
			? `${portType}, ${currentPort.domain}`
			: portType;

		if (!deployedPort) {
			changes.push({
				field: `Port ${port}`,
				from: "(none)",
				to: portDesc,
			});
		} else {
			const deployedType = deployedPort.isPublic ? "public" : "internal";
			const deployedDesc = deployedPort.domain
				? `${deployedType}, ${deployedPort.domain}`
				: deployedType;

			if (deployedDesc !== portDesc) {
				changes.push({
					field: `Port ${port}`,
					from: deployedDesc,
					to: portDesc,
				});
			}
		}
	}

	for (const [port, deployedPort] of deployedPortsMap) {
		if (!currentPortsMap.has(port)) {
			const deployedType = deployedPort.isPublic ? "public" : "internal";
			changes.push({
				field: `Port ${port}`,
				from: deployedType,
				to: "(removed)",
			});
		}
	}

	const deployedSecretsMap = new Map(
		(deployed.secrets || []).map((s) => [s.key, s]),
	);
	const currentSecretsMap = new Map(
		(current.secrets || []).map((s) => [s.key, s]),
	);

	for (const [key, currentSecret] of currentSecretsMap) {
		const deployedSecret = deployedSecretsMap.get(key);
		if (!deployedSecret) {
			changes.push({
				field: "Secret",
				from: "(none)",
				to: key,
			});
		} else if (deployedSecret.updatedAt !== currentSecret.updatedAt) {
			changes.push({
				field: "Secret",
				from: key,
				to: `${key} (updated)`,
			});
		}
	}

	for (const key of deployedSecretsMap.keys()) {
		if (!currentSecretsMap.has(key)) {
			changes.push({
				field: "Secret",
				from: key,
				to: "(removed)",
			});
		}
	}

	const deployedVolumesMap = new Map(
		(deployed.volumes || []).map((v) => [v.name, v]),
	);
	const currentVolumesMap = new Map(
		(current.volumes || []).map((v) => [v.name, v]),
	);

	for (const [name, currentVolume] of currentVolumesMap) {
		const deployedVolume = deployedVolumesMap.get(name);
		if (!deployedVolume) {
			changes.push({
				field: "Volume",
				from: "(none)",
				to: `${name} → ${currentVolume.containerPath}`,
			});
		} else if (deployedVolume.containerPath !== currentVolume.containerPath) {
			changes.push({
				field: `Volume ${name}`,
				from: deployedVolume.containerPath,
				to: currentVolume.containerPath,
			});
		}
	}

	for (const [name, deployedVolume] of deployedVolumesMap) {
		if (!currentVolumesMap.has(name)) {
			changes.push({
				field: "Volume",
				from: `${name} → ${deployedVolume.containerPath}`,
				to: "(removed)",
			});
		}
	}

	return changes;
}

export function parseDeployedConfig(
	json: string | null,
): DeployedConfig | null {
	if (!json) return null;
	try {
		return JSON.parse(json) as DeployedConfig;
	} catch {
		return null;
	}
}
