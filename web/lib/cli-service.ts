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
import {
	techulusManifestSchema,
	type TechulusManifest,
} from "@/lib/cli-manifest";
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

export type LinkServiceTarget = {
	id: string;
	name: string;
	project: string;
	environment: string;
	linkSupported: boolean;
	unsupportedReason: string | null;
};

export type LinkEnvironmentTarget = {
	id: string;
	name: string;
	services: LinkServiceTarget[];
};

export type LinkProjectTarget = {
	id: string;
	name: string;
	slug: string;
	environments: LinkEnvironmentTarget[];
};

export type LinkTargetsResult = {
	projects: LinkProjectTarget[];
};

export type LinkManifestResult = {
	manifest: TechulusManifest;
	service: {
		id: string;
		name: string;
		project: string;
		environment: string;
	};
};

type ManifestIdentity = {
	project: string;
	environment: string;
	service: string;
};

type ServiceCompatibilityRecord = Pick<
	typeof services.$inferSelect,
	| "sourceType"
	| "stateful"
	| "autoPlace"
	| "replicas"
	| "resourceCpuLimit"
	| "resourceMemoryLimitMb"
>;

type PortCompatibilityRecord = Pick<
	typeof servicePorts.$inferSelect,
	"protocol" | "isPublic" | "domain"
>;

type LinkValidationService = Pick<
	typeof services.$inferSelect,
	| "id"
	| "name"
	| "projectId"
	| "environmentId"
	| "hostname"
	| "image"
	| "sourceType"
	| "replicas"
	| "stateful"
	| "autoPlace"
	| "healthCheckCmd"
	| "healthCheckInterval"
	| "healthCheckTimeout"
	| "healthCheckRetries"
	| "healthCheckStartPeriod"
	| "startCommand"
	| "resourceCpuLimit"
	| "resourceMemoryLimitMb"
>;

type LinkValidationPort = Pick<
	typeof servicePorts.$inferSelect,
	"serviceId" | "port" | "isPublic" | "domain" | "protocol"
>;

type ServiceLinkValidation = {
	service: LinkValidationService;
	ports: LinkValidationPort[];
	unsupportedReason: string | null;
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

function getUnsupportedReason(
	service: ServiceCompatibilityRecord,
	ports: PortCompatibilityRecord[],
	volumeCount: number,
) {
	if (service.sourceType !== "image") {
		return "CLI v1 only supports image-backed services. This service uses an unsupported source.";
	}

	if (service.stateful || volumeCount > 0) {
		return "CLI v1 does not support stateful services or volumes. Manage this service from the web UI.";
	}

	if (!service.autoPlace) {
		return "CLI v1 only supports auto-placement. Manage this service from the web UI.";
	}

	if (ports.some((port) => port.protocol !== "http")) {
		return "CLI v1 only supports HTTP ports. This service has TCP or UDP ports configured.";
	}

	if (ports.some((port) => port.isPublic && !port.domain)) {
		return "CLI v1 requires every public HTTP port to have a domain.";
	}

	if (service.replicas < 1 || service.replicas > 10) {
		return "CLI v1 only supports replica counts between 1 and 10.";
	}

	const hasCpu = service.resourceCpuLimit !== null;
	const hasMemory = service.resourceMemoryLimitMb !== null;

	if (hasCpu !== hasMemory) {
		return "CLI v1 requires both CPU and memory limits to be set together.";
	}

	return null;
}

async function getServiceLinkValidation(
	serviceId: string,
): Promise<ServiceLinkValidation | null> {
	const [service] = await db
		.select({
			id: services.id,
			name: services.name,
			projectId: services.projectId,
			environmentId: services.environmentId,
			hostname: services.hostname,
			image: services.image,
			sourceType: services.sourceType,
			replicas: services.replicas,
			stateful: services.stateful,
			autoPlace: services.autoPlace,
			healthCheckCmd: services.healthCheckCmd,
			healthCheckInterval: services.healthCheckInterval,
			healthCheckTimeout: services.healthCheckTimeout,
			healthCheckRetries: services.healthCheckRetries,
			healthCheckStartPeriod: services.healthCheckStartPeriod,
			startCommand: services.startCommand,
			resourceCpuLimit: services.resourceCpuLimit,
			resourceMemoryLimitMb: services.resourceMemoryLimitMb,
		})
		.from(services)
		.where(eq(services.id, serviceId))
		.limit(1);

	if (!service) {
		return null;
	}

	const [ports, volumes] = await Promise.all([
		db
			.select({
				serviceId: servicePorts.serviceId,
				port: servicePorts.port,
				isPublic: servicePorts.isPublic,
				domain: servicePorts.domain,
				protocol: servicePorts.protocol,
			})
			.from(servicePorts)
			.where(eq(servicePorts.serviceId, serviceId))
			.orderBy(servicePorts.port),
		db
			.select({ id: serviceVolumes.id })
			.from(serviceVolumes)
			.where(eq(serviceVolumes.serviceId, serviceId)),
	]);

	return {
		service,
		ports,
		unsupportedReason: getUnsupportedReason(service, ports, volumes.length),
	};
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
	currentService: Pick<
		LinkValidationService,
		| "healthCheckCmd"
		| "healthCheckInterval"
		| "healthCheckTimeout"
		| "healthCheckRetries"
		| "healthCheckStartPeriod"
	>,
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
	currentService: Pick<
		LinkValidationService,
		"resourceCpuLimit" | "resourceMemoryLimitMb"
	>,
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
	currentService: Pick<LinkValidationService, "autoPlace" | "replicas">,
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
	const validation = await getServiceLinkValidation(serviceId);
	if (!validation) {
		throw new Error("Service not found");
	}

	if (validation.unsupportedReason) {
		throw new Error(validation.unsupportedReason);
	}

	return validation.service;
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

export async function listLinkTargets(): Promise<LinkTargetsResult> {
	const [projectRows, environmentRows, serviceRows, portRows, volumeRows] =
		await Promise.all([
			db
				.select({
					id: projects.id,
					name: projects.name,
					slug: projects.slug,
				})
				.from(projects)
				.orderBy(projects.createdAt),
			db
				.select({
					id: environments.id,
					projectId: environments.projectId,
					name: environments.name,
				})
				.from(environments)
				.orderBy(environments.createdAt),
			db
				.select({
					id: services.id,
					name: services.name,
					projectId: services.projectId,
					environmentId: services.environmentId,
					sourceType: services.sourceType,
					stateful: services.stateful,
					autoPlace: services.autoPlace,
					replicas: services.replicas,
					resourceCpuLimit: services.resourceCpuLimit,
					resourceMemoryLimitMb: services.resourceMemoryLimitMb,
				})
				.from(services)
				.orderBy(services.createdAt),
			db
				.select({
					serviceId: servicePorts.serviceId,
					protocol: servicePorts.protocol,
					isPublic: servicePorts.isPublic,
					domain: servicePorts.domain,
				})
				.from(servicePorts),
			db.select({ serviceId: serviceVolumes.serviceId })
				.from(serviceVolumes)
				.orderBy(serviceVolumes.id),
		]);

	const projectNameById = new Map(
		projectRows.map((project) => [project.id, project.name]),
	);
	const environmentById = new Map(
		environmentRows.map((environment) => [environment.id, environment]),
	);

	const portsByServiceId = new Map<string, PortCompatibilityRecord[]>();
	for (const port of portRows) {
		const current = portsByServiceId.get(port.serviceId) ?? [];
		current.push(port);
		portsByServiceId.set(port.serviceId, current);
	}

	const volumeCountByServiceId = new Map<string, number>();
	for (const volume of volumeRows) {
		volumeCountByServiceId.set(
			volume.serviceId,
			(volumeCountByServiceId.get(volume.serviceId) ?? 0) + 1,
		);
	}

	const servicesByEnvironmentId = new Map<string, LinkServiceTarget[]>();
	for (const service of serviceRows) {
		const projectName = projectNameById.get(service.projectId);
		const environment = environmentById.get(service.environmentId);
		if (!projectName || !environment) {
			continue;
		}

		const current = servicesByEnvironmentId.get(service.environmentId) ?? [];
		const ports = portsByServiceId.get(service.id) ?? [];
		const unsupportedReason = getUnsupportedReason(
			service,
			ports,
			volumeCountByServiceId.get(service.id) ?? 0,
		);

		current.push({
			id: service.id,
			name: service.name,
			project: projectName,
			environment: environment.name,
			linkSupported: unsupportedReason === null,
			unsupportedReason,
		});
		servicesByEnvironmentId.set(service.environmentId, current);
	}

	const environmentsByProjectId = new Map<string, LinkEnvironmentTarget[]>();
	for (const environment of environmentRows) {
		const current = environmentsByProjectId.get(environment.projectId) ?? [];
		current.push({
			id: environment.id,
			name: environment.name,
			services: servicesByEnvironmentId.get(environment.id) ?? [],
		});
		environmentsByProjectId.set(environment.projectId, current);
	}

	return {
		projects: projectRows.map((project) => ({
			id: project.id,
			name: project.name,
			slug: project.slug,
			environments: environmentsByProjectId.get(project.id) ?? [],
		})),
	};
}

export async function exportManifestForLinkedService(
	serviceId: string,
): Promise<LinkManifestResult> {
	const validation = await getServiceLinkValidation(serviceId);
	if (!validation) {
		throw new Error("Service not found");
	}

	if (validation.unsupportedReason) {
		throw new Error(validation.unsupportedReason);
	}

	const [project, environment] = await Promise.all([
		db
			.select()
			.from(projects)
			.where(eq(projects.id, validation.service.projectId))
			.limit(1),
		db
			.select()
			.from(environments)
			.where(eq(environments.id, validation.service.environmentId))
			.limit(1),
	]);

	const projectRow = project[0];
	const environmentRow = environment[0];

	if (!projectRow || !environmentRow) {
		throw new Error("Failed to resolve the selected service");
	}

	const manifest = techulusManifestSchema.parse({
		apiVersion: "v1",
		project: projectRow.name,
		environment: environmentRow.name,
		service: {
			name: validation.service.name,
			source: {
				type: "image",
				image: validation.service.image,
			},
			...(validation.service.hostname
				? { hostname: validation.service.hostname }
				: {}),
			ports: validation.ports.map((port) => ({
				port: port.port,
				public: port.isPublic,
				...(port.isPublic && port.domain ? { domain: port.domain } : {}),
			})),
			replicas: {
				count: validation.service.replicas,
			},
			...(validation.service.healthCheckCmd
				? {
						healthCheck: {
							cmd: validation.service.healthCheckCmd,
							interval: validation.service.healthCheckInterval ?? 10,
							timeout: validation.service.healthCheckTimeout ?? 5,
							retries: validation.service.healthCheckRetries ?? 3,
							startPeriod: validation.service.healthCheckStartPeriod ?? 30,
						},
					}
				: {}),
			...(validation.service.startCommand
				? { startCommand: validation.service.startCommand }
				: {}),
			...(validation.service.resourceCpuLimit !== null &&
			validation.service.resourceMemoryLimitMb !== null
				? {
						resources: {
							cpuCores: validation.service.resourceCpuLimit,
							memoryMb: validation.service.resourceMemoryLimitMb,
						},
					}
				: {}),
		},
	});

	return {
		manifest,
		service: {
			id: validation.service.id,
			name: validation.service.name,
			project: projectRow.name,
			environment: environmentRow.name,
		},
	};
}
