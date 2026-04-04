import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import {
	deployments,
	environments,
	projects,
	rollouts,
	servicePorts,
	serviceVolumes,
	services,
} from "@/db/schema";
import type { TechulusManifest } from "@/lib/cli-manifest";
import {
	getManifestEnvironmentName,
	getManifestProjectSlug,
	getManifestServiceName,
} from "@/lib/cli-manifest";
import { slugify } from "@/lib/utils";
import {
	createEnvironment,
	createProject,
	createService,
	deployService,
	updateServiceAutoPlace,
	updateServiceConfig,
	updateServiceReplicas,
	updateServiceResourceLimits,
	updateServiceStartCommand,
	validateDockerImage,
} from "@/actions/projects";

export type ManifestChange = {
	field: string;
	from: string;
	to: string;
};

export type ManifestApplyResult = {
	project: { id: string; name: string; slug: string };
	environment: { id: string; name: string };
	serviceId: string;
	action: "created" | "updated" | "noop";
	changes: ManifestChange[];
};

type ManifestIdentity = {
	project: string;
	environment: string;
	service: string;
};

function formatPort(port: { port: number; isPublic: boolean; domain: string | null }) {
	return port.isPublic ? `${port.port} -> ${port.domain}` : `${port.port} (internal)`;
}

function formatNullable(value: string | number | null | undefined, fallback = "(none)") {
	if (value === null || value === undefined || value === "") {
		return fallback;
	}

	return String(value);
}

function recordChange(
	changes: ManifestChange[],
	field: string,
	from: string | number | null | undefined,
	to: string | number | null | undefined,
) {
	if ((from ?? null) === (to ?? null)) {
		return;
	}

	changes.push({
		field,
		from: formatNullable(from),
		to: formatNullable(to),
	});
}

async function findProjectByManifest(manifest: TechulusManifest) {
	const slug = getManifestProjectSlug(manifest);
	return findProjectBySlug(slug);
}

async function findProjectBySlug(slug: string) {
	const [project] = await db
		.select()
		.from(projects)
		.where(eq(projects.slug, slug))
		.limit(1);

	return project ?? null;
}

async function findEnvironmentByManifest(
	projectId: string,
	manifest: TechulusManifest,
) {
	const environmentName = getManifestEnvironmentName(manifest);
	return findEnvironmentByName(projectId, environmentName);
}

async function findEnvironmentByName(projectId: string, environmentName: string) {
	const [environment] = await db
		.select()
		.from(environments)
		.where(
			and(
				eq(environments.projectId, projectId),
				eq(environments.name, environmentName),
			),
		)
		.limit(1);

	return environment ?? null;
}

async function findServiceByManifest(
	projectId: string,
	environmentId: string,
	manifest: TechulusManifest,
) {
	const serviceName = getManifestServiceName(manifest);
	return findServiceByName(projectId, environmentId, serviceName);
}

async function findServiceByName(
	projectId: string,
	environmentId: string,
	serviceName: string,
) {
	const [service] = await db
		.select()
		.from(services)
		.where(
			and(
				eq(services.projectId, projectId),
				eq(services.environmentId, environmentId),
				eq(services.name, serviceName),
			),
		)
		.limit(1);

	return service ?? null;
}

async function syncHostname(
	serviceId: string,
	currentHostname: string | null,
	desiredHostname: string | null,
	changes: ManifestChange[],
) {
	if (currentHostname === desiredHostname) {
		return;
	}

	if (desiredHostname) {
		const [existing] = await db
			.select({ id: services.id })
			.from(services)
			.where(
				and(eq(services.hostname, desiredHostname), ne(services.id, serviceId)),
			)
			.limit(1);

		if (existing) {
			throw new Error("Hostname is already in use");
		}
	}

	await db
		.update(services)
		.set({ hostname: desiredHostname })
		.where(eq(services.id, serviceId));

	recordChange(changes, "Hostname", currentHostname, desiredHostname);
}

async function syncImage(
	serviceId: string,
	currentImage: string,
	desiredImage: string,
	changes: ManifestChange[],
) {
	if (currentImage === desiredImage) {
		return;
	}

	const validation = await validateDockerImage(desiredImage);
	if (!validation.valid) {
		throw new Error(validation.error || "Invalid image");
	}

	await updateServiceConfig(serviceId, {
		source: { type: "image", image: desiredImage },
	});

	recordChange(changes, "Image", currentImage, desiredImage);
}

async function syncPorts(
	serviceId: string,
	desiredPorts: TechulusManifest["service"]["ports"],
	changes: ManifestChange[],
) {
	const currentPorts = await db
		.select()
		.from(servicePorts)
		.where(eq(servicePorts.serviceId, serviceId));

	const currentKeys = new Map(
		currentPorts.map((port) => [
			`${port.port}:${port.isPublic ? "public" : "internal"}:${port.domain ?? ""}`,
			port,
		]),
	);

	const desiredKeys = new Map(
		desiredPorts.map((port) => [
			`${port.port}:${port.public ? "public" : "internal"}:${port.domain ?? ""}`,
			port,
		]),
	);

	const portsToRemove = currentPorts
		.filter(
			(port) =>
				!desiredKeys.has(
					`${port.port}:${port.isPublic ? "public" : "internal"}:${port.domain ?? ""}`,
				),
		)
		.map((port) => port.id);

	const portsToAdd = desiredPorts
		.filter(
			(port) =>
				!currentKeys.has(
					`${port.port}:${port.public ? "public" : "internal"}:${port.domain ?? ""}`,
				),
		)
		.map((port) => ({
			port: port.port,
			isPublic: port.public,
			domain: port.public ? port.domain ?? null : null,
			protocol: "http" as const,
		}));

	if (portsToRemove.length === 0 && portsToAdd.length === 0) {
		return;
	}

	await updateServiceConfig(serviceId, {
		ports: {
			remove: portsToRemove,
			add: portsToAdd,
		},
	});

	for (const port of currentPorts.filter((item) => portsToRemove.includes(item.id))) {
		changes.push({
			field: `Port ${port.port}`,
			from: formatPort(port),
			to: "(removed)",
		});
	}

	for (const port of portsToAdd) {
		changes.push({
			field: `Port ${port.port}`,
			from: "(none)",
			to: port.isPublic ? `${port.port} -> ${port.domain}` : `${port.port} (internal)`,
		});
	}
}

async function syncHealthCheck(
	serviceId: string,
	currentService: typeof services.$inferSelect,
	manifest: TechulusManifest,
	changes: ManifestChange[],
) {
	const current =
		currentService.healthCheckCmd === null
			? null
			: {
					cmd: currentService.healthCheckCmd,
					interval: currentService.healthCheckInterval ?? 10,
					timeout: currentService.healthCheckTimeout ?? 5,
					retries: currentService.healthCheckRetries ?? 3,
					startPeriod: currentService.healthCheckStartPeriod ?? 30,
				};

	const desired = manifest.service.healthCheck ?? null;

	if (JSON.stringify(current) === JSON.stringify(desired)) {
		return;
	}

	await updateServiceConfig(serviceId, {
		healthCheck: desired,
	});

	recordChange(
		changes,
		"Health check",
		current?.cmd ?? null,
		desired?.cmd ?? null,
	);
}

async function syncStartCommand(
	serviceId: string,
	currentStartCommand: string | null,
	desiredStartCommand: string | null,
	changes: ManifestChange[],
) {
	if (currentStartCommand === desiredStartCommand) {
		return;
	}

	await updateServiceStartCommand(serviceId, desiredStartCommand);
	recordChange(
		changes,
		"Start command",
		currentStartCommand,
		desiredStartCommand,
	);
}

async function syncResources(
	serviceId: string,
	currentService: typeof services.$inferSelect,
	manifest: TechulusManifest,
	changes: ManifestChange[],
) {
	const desiredCpu = manifest.service.resources?.cpuCores ?? null;
	const desiredMemory = manifest.service.resources?.memoryMb ?? null;

	if (
		currentService.resourceCpuLimit === desiredCpu &&
		currentService.resourceMemoryLimitMb === desiredMemory
	) {
		return;
	}

	await updateServiceResourceLimits(serviceId, {
		cpuCores: desiredCpu,
		memoryMb: desiredMemory,
	});

	recordChange(
		changes,
		"CPU limit",
		currentService.resourceCpuLimit,
		desiredCpu,
	);
	recordChange(
		changes,
		"Memory limit",
		currentService.resourceMemoryLimitMb,
		desiredMemory,
	);
}

async function syncReplicas(
	serviceId: string,
	currentService: typeof services.$inferSelect,
	desiredReplicas: number,
	changes: ManifestChange[],
) {
	if (!currentService.autoPlace) {
		throw new Error(
			"CLI v1 only supports auto-placement. This service uses manual placement.",
		);
	}

	if (currentService.replicas === desiredReplicas) {
		return;
	}

	await updateServiceAutoPlace(serviceId, true);
	await updateServiceReplicas(serviceId, desiredReplicas);
	recordChange(changes, "Replicas", currentService.replicas, desiredReplicas);
}

async function assertSupportedExistingService(serviceId: string) {
	const [service] = await db
		.select()
		.from(services)
		.where(eq(services.id, serviceId))
		.limit(1);

	if (!service) {
		throw new Error("Service not found");
	}

	if (service.sourceType !== "image") {
		throw new Error(
			"CLI v1 only supports image-backed services. This service uses an unsupported source.",
		);
	}

	if (service.stateful) {
		throw new Error(
			"CLI v1 does not support stateful services or volumes. Manage this service from the web UI.",
		);
	}

	if (!service.autoPlace) {
		throw new Error(
			"CLI v1 only supports auto-placement. Manage this service from the web UI.",
		);
	}

	const ports = await db
		.select()
		.from(servicePorts)
		.where(eq(servicePorts.serviceId, serviceId));

	if (ports.some((port) => port.protocol !== "http")) {
		throw new Error(
			"CLI v1 only supports HTTP ports. This service has TCP or UDP ports configured.",
		);
	}

	const volumes = await db
		.select({ id: serviceVolumes.id })
		.from(serviceVolumes)
		.where(eq(serviceVolumes.serviceId, serviceId));

	if (volumes.length > 0) {
		throw new Error(
			"CLI v1 does not support services with volumes. Manage this service from the web UI.",
		);
	}

	return service;
}

export async function applyManifest(
	manifest: TechulusManifest,
): Promise<ManifestApplyResult> {
	let serviceCreated = false;
	let project = await findProjectByManifest(manifest);
	if (!project) {
		await createProject(manifest.project.trim());
		project = await findProjectByManifest(manifest);
	}
	if (!project) {
		throw new Error("Failed to create project");
	}

	let environment = await findEnvironmentByManifest(project.id, manifest);
	if (!environment) {
		await createEnvironment(project.id, manifest.environment.trim());
		environment = await findEnvironmentByManifest(project.id, manifest);
	}
	if (!environment) {
		throw new Error("Failed to create environment");
	}

	let service = await findServiceByManifest(project.id, environment.id, manifest);
	const changes: ManifestChange[] = [];

	if (!service) {
		serviceCreated = true;
		const validation = await validateDockerImage(manifest.service.source.image);
		if (!validation.valid) {
			throw new Error(validation.error || "Invalid image");
		}

		await createService({
			projectId: project.id,
			environmentId: environment.id,
			name: getManifestServiceName(manifest),
			image: manifest.service.source.image,
		});
		service = await findServiceByManifest(project.id, environment.id, manifest);
		if (!service) {
			throw new Error("Failed to create service");
		}

		recordChange(changes, "Image", null, manifest.service.source.image);
		recordChange(
			changes,
			"Replicas",
			null,
			manifest.service.replicas.count,
		);
	}

	const currentService = await assertSupportedExistingService(service.id);

	await syncHostname(
		service.id,
		currentService.hostname,
		manifest.service.hostname ?? null,
		changes,
	);
	await syncImage(
		service.id,
		currentService.image,
		manifest.service.source.image,
		changes,
	);
	await syncPorts(service.id, manifest.service.ports, changes);
	await syncHealthCheck(service.id, currentService, manifest, changes);
	await syncStartCommand(
		service.id,
		currentService.startCommand,
		manifest.service.startCommand ?? null,
		changes,
	);
	await syncResources(service.id, currentService, manifest, changes);
	await syncReplicas(
		service.id,
		currentService,
		manifest.service.replicas.count,
		changes,
	);

	const refreshedProject = await findProjectByManifest(manifest);
	const refreshedEnvironment = await findEnvironmentByManifest(project.id, manifest);

	if (!refreshedProject || !refreshedEnvironment) {
		throw new Error("Failed to reload manifest resources after apply");
	}

	return {
		project: refreshedProject,
		environment: refreshedEnvironment,
		serviceId: service.id,
		action: serviceCreated ? "created" : changes.length === 0 ? "noop" : "updated",
		changes,
	};
}

export async function deployManifest(manifest: TechulusManifest) {
	const project = await findProjectByManifest(manifest);
	if (!project) {
		throw new Error("Project not found");
	}

	const environment = await findEnvironmentByManifest(project.id, manifest);
	if (!environment) {
		throw new Error("Environment not found");
	}

	const service = await findServiceByManifest(project.id, environment.id, manifest);
	if (!service) {
		throw new Error("Service not found");
	}

	const result = await deployService(service.id);

	return {
		serviceId: service.id,
		rolloutId: "rolloutId" in result ? result.rolloutId : null,
		status: "migrationStarted" in result ? "migration_started" : "queued",
	};
}

export async function getManifestStatus(identity: ManifestIdentity) {
	const project = await findProjectBySlug(identity.project);
	if (!project) {
		return null;
	}

	const environment = await findEnvironmentByName(
		project.id,
		slugify(identity.environment),
	);
	if (!environment) {
		return null;
	}

	const service = await findServiceByName(
		project.id,
		environment.id,
		identity.service.trim(),
	);
	if (!service) {
		return null;
	}

	const [latestRollout] = await db
		.select({
			id: rollouts.id,
			status: rollouts.status,
			currentStage: rollouts.currentStage,
			createdAt: rollouts.createdAt,
		})
		.from(rollouts)
		.where(eq(rollouts.serviceId, service.id))
		.orderBy(desc(rollouts.createdAt))
		.limit(1);

	const serviceDeployments = await db
		.select({
			id: deployments.id,
			status: deployments.status,
			serverId: deployments.serverId,
			createdAt: deployments.createdAt,
		})
		.from(deployments)
		.where(eq(deployments.serviceId, service.id))
		.orderBy(desc(deployments.createdAt));

	const ports = await db
		.select({
			id: servicePorts.id,
			port: servicePorts.port,
			isPublic: servicePorts.isPublic,
			domain: servicePorts.domain,
			protocol: servicePorts.protocol,
		})
		.from(servicePorts)
		.where(eq(servicePorts.serviceId, service.id));

	return {
		service: {
			id: service.id,
			name: service.name,
			image: service.image,
			hostname: service.hostname,
			replicas: service.replicas,
			sourceType: service.sourceType,
		},
		ports,
		latestRollout: latestRollout ?? null,
		deployments: serviceDeployments,
	};
}
