import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	servers,
	serviceRevisions,
	services,
} from "@/db/schema";
import { getAllCertificatesForDomains } from "@/lib/acme-manager";
import {
	activeTrafficStates,
	isDeploymentRoutable,
	observedReadyPhases,
	runtimeExpectedStates,
} from "@/lib/deployment-status";
import {
	SERVICE_REVISION_SCHEMA_VERSION,
	type ServiceRevisionSecret,
	type ServiceRevisionSpec,
} from "@/lib/service-revision-spec";
import { getWireGuardPeers } from "@/lib/wireguard";

type Server = typeof servers.$inferSelect;
type Service = typeof services.$inferSelect;
type Deployment = typeof deployments.$inferSelect;
type ServiceRevision = typeof serviceRevisions.$inferSelect;
const SERVERLESS_GATEWAY_PORT = 18080;

type RouteServicePort = {
	id: string;
	serviceId: string;
	port: number;
	isPublic: boolean;
	domain: string | null;
	protocol: "http" | "tcp" | "udp";
	externalPort: number | null;
	tlsPassthrough: boolean;
};

export type RuntimeServiceRevision = {
	id: string;
	name: string;
	revisionId: string;
	specification: ServiceRevisionSpec;
};

export type RuntimeServiceRevisionRow = {
	deploymentId: string;
	serviceId: string;
	serviceName: string;
	serviceActiveRevisionId: string | null;
	revisionId: string;
	revisionServiceId: string;
	revisionSchemaVersion: number;
	specification: ServiceRevisionSpec;
};

export type ExpectedContainer = {
	deploymentId: string;
	revisionId: string;
	containerSpecHash: string;
	serviceId: string;
	serviceName: string;
	name: string;
	desiredState: "running" | "stopped";
	image: string;
	ipAddress: string | null;
	ports: Array<{ containerPort: number; hostPort: number }>;
	publishLocalPorts: boolean;
	env: Record<string, string>;
	startCommand: string | null;
	healthCheck: {
		cmd: string;
		interval: number;
		timeout: number;
		retries: number;
		startPeriod: number;
	} | null;
	volumes: Array<{ name: string; containerPath: string }>;
	resourceCpuLimit: number | null;
	resourceMemoryLimitMb: number | null;
};

type HttpRoute = {
	id: string;
	domain: string;
	upstreams: Array<{ url: string; weight: number }>;
	serviceId: string;
};

type TcpRoute = {
	id: string;
	serviceId: string;
	upstreams: string[];
	externalPort: number;
	tlsPassthrough: boolean;
};

type UdpRoute = {
	id: string;
	serviceId: string;
	upstreams: string[];
	externalPort: number;
};

export type ServerlessRouteUpstream = {
	deploymentId: string;
	serverId: string;
	url: string;
	local: boolean;
	alwaysOn: boolean;
};

export type ServerlessRoute = {
	serviceId: string;
	domain: string;
	port: number;
	sleepAfterSeconds: number;
	wakeTimeoutSeconds: number;
	localDeploymentIds: string[];
	upstreams: ServerlessRouteUpstream[];
};

export type AgentExpectedState = {
	schemaVersion: 1;
	serverName: string;
	containers: ExpectedContainer[];
	dns: { records: Array<{ name: string; ips: string[] }> };
	serverless: { routes: ServerlessRoute[] };
	traefik: {
		httpRoutes: HttpRoute[];
		tcpRoutes: TcpRoute[];
		udpRoutes: UdpRoute[];
		certificates?: Awaited<ReturnType<typeof getAllCertificatesForDomains>>;
		challengeRoute?: { controlPlaneUrl: string };
	};
	wireguard: { peers: Awaited<ReturnType<typeof getWireGuardPeers>> };
};

type DeploymentPortRow = {
	deploymentId: string;
	hostPort: number;
	containerPort: number;
};

type RoutableDeploymentRow = {
	serviceId: string;
	ipAddress: string | null;
	serverId: string;
};

type ProxyHostedServerlessDeploymentRow = {
	serviceId: string;
	serverId: string;
};

type ServerlessDeploymentRow = {
	id: string;
	serviceId: string;
	serverId: string;
	ipAddress: string | null;
	runtimeDesiredState: Deployment["runtimeDesiredState"];
	trafficState: Deployment["trafficState"];
	observedPhase: Deployment["observedPhase"];
	serverIsProxy: boolean;
};

export async function getServer(serverId: string) {
	return db
		.select()
		.from(servers)
		.where(eq(servers.id, serverId))
		.then((r) => r[0]);
}

export async function buildAgentExpectedState(
	server: Server,
): Promise<AgentExpectedState> {
	const runtimeServices = await getRuntimeServiceRevisions();
	const [containers, dnsRecords, traefikConfig, wireguardPeers] =
		await Promise.all([
			buildExpectedContainers(server.id),
			buildDnsRecords(runtimeServices),
			buildTraefikConfig(server, runtimeServices),
			getWireGuardPeers(server.id, server.privateIp),
		]);
	const serverless = await buildServerlessExpectedState(
		server,
		runtimeServices,
		containers,
	);

	return {
		schemaVersion: 1,
		serverName: server.name,
		containers,
		dns: { records: dnsRecords },
		serverless,
		traefik: traefikConfig,
		wireguard: { peers: wireguardPeers },
	};
}

async function getRuntimeServiceRevisions(): Promise<RuntimeServiceRevision[]> {
	const rows = await db
		.select({
			deploymentId: deployments.id,
			serviceId: services.id,
			serviceName: services.name,
			serviceActiveRevisionId: services.activeRevisionId,
			revisionId: serviceRevisions.id,
			revisionServiceId: serviceRevisions.serviceId,
			revisionSchemaVersion: serviceRevisions.schemaVersion,
			specification: serviceRevisions.specification,
		})
		.from(deployments)
		.innerJoin(services, eq(deployments.serviceId, services.id))
		.innerJoin(
			serviceRevisions,
			eq(deployments.serviceRevisionId, serviceRevisions.id),
		)
		.where(
			and(
				isNull(services.deletedAt),
				inArray(deployments.runtimeDesiredState, runtimeExpectedStates),
				inArray(deployments.trafficState, activeTrafficStates),
			),
		);

	const { services: runtimeServices, errors } =
		selectRuntimeServiceRevisions(rows);
	for (const error of errors) {
		console.error(`[expected-state] ${error}`);
	}
	return runtimeServices;
}

export function selectRuntimeServiceRevisions(
	rows: RuntimeServiceRevisionRow[],
): { services: RuntimeServiceRevision[]; errors: string[] } {
	const rowsByService = groupBy(rows, (row) => row.serviceId);
	const runtimeServices: RuntimeServiceRevision[] = [];
	const errors: string[] = [];

	for (const [serviceId, serviceRows] of [...rowsByService.entries()].sort(
		([a], [b]) => a.localeCompare(b),
	)) {
		const invalidOwnership = serviceRows.find(
			(row) => row.revisionServiceId !== serviceId,
		);
		if (invalidOwnership) {
			errors.push(
				`service ${serviceId} omitted: deployment ${invalidOwnership.deploymentId} revision belongs to another service`,
			);
			continue;
		}

		const unsupported = serviceRows.find(
			(row) =>
				row.revisionSchemaVersion !== SERVICE_REVISION_SCHEMA_VERSION ||
				row.specification.schemaVersion !== SERVICE_REVISION_SCHEMA_VERSION,
		);
		if (unsupported) {
			errors.push(
				`service ${serviceId} omitted: deployment ${unsupported.deploymentId} uses an unsupported service revision`,
			);
			continue;
		}

		const rowsByRevision = new Map(
			serviceRows.map((row) => [row.revisionId, row]),
		);
		let selected: RuntimeServiceRevisionRow | undefined = [
			...rowsByRevision.values(),
		][0];
		if (rowsByRevision.size > 1) {
			const activeRevisionId = serviceRows[0]?.serviceActiveRevisionId;
			selected = activeRevisionId
				? rowsByRevision.get(activeRevisionId)
				: undefined;
			if (!selected) {
				errors.push(
					`service ${serviceId} omitted: multiple active revisions have no authoritative active revision`,
				);
				continue;
			}
			errors.push(
				`service ${serviceId} has multiple active revisions; using authoritative revision ${selected.revisionId}`,
			);
		}

		if (!selected) continue;
		runtimeServices.push({
			id: serviceId,
			name: selected.serviceName,
			revisionId: selected.revisionId,
			specification: selected.specification,
		});
	}

	return { services: runtimeServices, errors };
}

async function buildExpectedContainers(
	serverId: string,
): Promise<ExpectedContainer[]> {
	const serverDeployments = await db
		.select()
		.from(deployments)
		.where(
			and(
				eq(deployments.serverId, serverId),
				inArray(deployments.runtimeDesiredState, runtimeExpectedStates),
			),
		);

	const serviceIds = unique(serverDeployments.map((dep) => dep.serviceId));
	const revisionIds = unique(
		serverDeployments.map((dep) => dep.serviceRevisionId),
	);
	if (serviceIds.length === 0) return [];

	const [activeServices, revisions, depPorts] = await Promise.all([
		db
			.select()
			.from(services)
			.where(and(inArray(services.id, serviceIds), isNull(services.deletedAt))),
		db
			.select()
			.from(serviceRevisions)
			.where(inArray(serviceRevisions.id, revisionIds)),
		fetchDeploymentPorts(serverDeployments.map((dep) => dep.id)),
	]);

	return buildExpectedContainersFromRows({
		deployments: serverDeployments,
		services: activeServices,
		revisions,
		deploymentPorts: depPorts,
	});
}

async function fetchDeploymentPorts(deploymentIds: string[]) {
	if (deploymentIds.length === 0) return [];

	return db
		.select({
			deploymentId: deploymentPorts.deploymentId,
			hostPort: deploymentPorts.hostPort,
			containerPort: deploymentPorts.containerPort,
		})
		.from(deploymentPorts)
		.where(inArray(deploymentPorts.deploymentId, deploymentIds))
		.orderBy(
			deploymentPorts.deploymentId,
			deploymentPorts.containerPort,
			deploymentPorts.hostPort,
		);
}

export function buildExpectedContainersFromRows({
	deployments: deploymentRows,
	services: serviceRows,
	revisions: revisionRows,
	deploymentPorts: deploymentPortRows,
}: {
	deployments: Deployment[];
	services: Service[];
	revisions: ServiceRevision[];
	deploymentPorts: DeploymentPortRow[];
}): ExpectedContainer[] {
	const servicesById = new Map(
		serviceRows.map((service) => [service.id, service]),
	);
	const portsByDeploymentId = groupBy(
		deploymentPortRows,
		(port) => port.deploymentId,
	);
	const revisionsById = new Map(
		revisionRows.map((revision) => [revision.id, revision]),
	);

	return deploymentRows
		.slice()
		.sort((a, b) => a.id.localeCompare(b.id))
		.flatMap((dep) => {
			const service = servicesById.get(dep.serviceId);
			const revision = revisionsById.get(dep.serviceRevisionId);
			if (!service) {
				console.error(
					`[expected-state] deployment ${dep.id} omitted because its service is deleted`,
				);
				return [];
			}
			if (!revision) {
				throw new Error(`Deployment ${dep.id} has no service revision`);
			}
			if (revision.serviceId !== dep.serviceId) {
				throw new Error(
					`Deployment ${dep.id} revision belongs to another service`,
				);
			}
			if (
				revision.schemaVersion !== SERVICE_REVISION_SCHEMA_VERSION ||
				revision.specification.schemaVersion !== SERVICE_REVISION_SCHEMA_VERSION
			) {
				throw new Error(
					`Deployment ${dep.id} uses an unsupported service revision`,
				);
			}
			const specification = revision.specification;
			const ports = (portsByDeploymentId.get(dep.id) ?? [])
				.slice()
				.sort(
					(a, b) =>
						a.containerPort - b.containerPort || a.hostPort - b.hostPort,
				)
				.map((port) => ({
					containerPort: port.containerPort,
					hostPort: port.hostPort,
				}));
			const expectedContainerPorts = specification.ports
				.map((port) => port.containerPort)
				.sort((a, b) => a - b);
			const allocatedContainerPorts = ports.map((port) => port.containerPort);
			if (
				JSON.stringify(expectedContainerPorts) !==
				JSON.stringify(allocatedContainerPorts)
			) {
				throw new Error(`Deployment ${dep.id} has incomplete port allocation`);
			}
			const env = buildEnv(specification.secrets);
			const volumes = specification.volumes
				.slice()
				.sort((a, b) => a.containerPath.localeCompare(b.containerPath))
				.map((volume) => ({
					name: volume.name,
					containerPath: volume.containerPath,
				}));
			const creationSpec = {
				image: normalizeImage(specification.image),
				ipAddress: dep.ipAddress,
				ports,
				publishLocalPorts: specification.serverless.enabled,
				env,
				startCommand: specification.startCommand,
				healthCheck: specification.healthCheck,
				volumes,
				resourceCpuLimit: specification.resourceLimits.cpuCores,
				resourceMemoryLimitMb: specification.resourceLimits.memoryMb,
			};

			return [
				{
					deploymentId: dep.id,
					revisionId: revision.id,
					containerSpecHash: hashContainerCreationSpec(creationSpec),
					serviceId: dep.serviceId,
					serviceName: service.name,
					name: `${dep.serviceId}-${dep.id.slice(0, 8)}`,
					desiredState:
						dep.runtimeDesiredState === "stopped" ? "stopped" : "running",
					image: creationSpec.image,
					ipAddress: dep.ipAddress,
					ports,
					publishLocalPorts: creationSpec.publishLocalPorts,
					env,
					startCommand: creationSpec.startCommand,
					healthCheck: creationSpec.healthCheck,
					volumes,
					resourceCpuLimit: creationSpec.resourceCpuLimit,
					resourceMemoryLimitMb: creationSpec.resourceMemoryLimitMb,
				},
			];
		});
}

async function buildServerlessExpectedState(
	server: Server,
	allServices: RuntimeServiceRevision[],
	containers: ExpectedContainer[],
): Promise<{ routes: ServerlessRoute[] }> {
	if (!server.isProxy) {
		return { routes: [] };
	}

	const serverlessServices = allServices.filter(
		(service) => service.specification.serverless.enabled,
	);
	if (serverlessServices.length === 0) return { routes: [] };

	const serviceIds = serverlessServices.map((service) => service.id);
	const deploymentRows = await db
		.select({
			id: deployments.id,
			serviceId: deployments.serviceId,
			serverId: deployments.serverId,
			ipAddress: deployments.ipAddress,
			runtimeDesiredState: deployments.runtimeDesiredState,
			trafficState: deployments.trafficState,
			observedPhase: deployments.observedPhase,
			serverIsProxy: servers.isProxy,
		})
		.from(deployments)
		.innerJoin(servers, eq(deployments.serverId, servers.id))
		.where(
			and(
				inArray(deployments.serviceId, serviceIds),
				inArray(deployments.runtimeDesiredState, runtimeExpectedStates),
			),
		);
	const ports = buildRuntimeRoutePorts(serverlessServices);

	return {
		routes: buildServerlessRoutesFromRows({
			serverId: server.id,
			services: serverlessServices,
			ports,
			deployments: deploymentRows,
			containers,
		}),
	};
}

export function buildServerlessRoutesFromRows({
	serverId,
	services: serviceRows,
	ports,
	deployments: deploymentRows,
	containers,
}: {
	serverId: string;
	services: RuntimeServiceRevision[];
	ports: RouteServicePort[];
	deployments: ServerlessDeploymentRow[];
	containers: ExpectedContainer[];
}): ServerlessRoute[] {
	const deploymentsByServiceId = groupBy(
		deploymentRows,
		(deployment) => deployment.serviceId,
	);
	const portsByServiceId = groupBy(ports, (port) => port.serviceId);
	const expectedDeploymentIds = new Set(
		containers.map((container) => container.deploymentId),
	);

	return serviceRows
		.flatMap((service) =>
			(portsByServiceId.get(service.id) ?? []).map((port) => ({
				service,
				port,
			})),
		)
		.sort((a, b) => compareServicePorts(a.port, b.port))
		.flatMap(({ service, port }) => {
			if (!port.isPublic || port.protocol !== "http" || !port.domain) {
				return [];
			}

			const serviceDeployments = deploymentsByServiceId.get(service.id) ?? [];
			if (!serviceDeployments.some((deployment) => deployment.serverIsProxy)) {
				return [];
			}

			const localDeploymentIds = serviceDeployments
				.filter(
					(deployment) =>
						deployment.serverId === serverId &&
						deployment.serverIsProxy &&
						deployment.trafficState === "active" &&
						expectedDeploymentIds.has(deployment.id),
				)
				.map((deployment) => deployment.id)
				.sort();

			const upstreams = serviceDeployments
				.filter(
					(deployment) =>
						deployment.ipAddress &&
						deployment.runtimeDesiredState === "running" &&
						isDeploymentRoutable(deployment),
				)
				.map((deployment) => ({
					deploymentId: deployment.id,
					serverId: deployment.serverId,
					url: `${deployment.ipAddress}:${port.port}`,
					local: deployment.serverId === serverId,
					alwaysOn: !deployment.serverIsProxy,
				}))
				.sort(compareServerlessUpstreams);

			return [
				{
					serviceId: service.id,
					domain: port.domain,
					port: port.port,
					sleepAfterSeconds: service.specification.serverless.sleepAfterSeconds,
					wakeTimeoutSeconds:
						service.specification.serverless.wakeTimeoutSeconds,
					localDeploymentIds,
					upstreams,
				},
			];
		});
}

async function buildDnsRecords(allServices: RuntimeServiceRevision[]) {
	const serviceIds = allServices.map((service) => service.id);
	if (serviceIds.length === 0) return [];

	const dnsDeployments = await db
		.select({
			serviceId: deployments.serviceId,
			ipAddress: deployments.ipAddress,
		})
		.from(deployments)
		.where(
			and(
				inArray(deployments.serviceId, serviceIds),
				eq(deployments.runtimeDesiredState, "running"),
				inArray(deployments.trafficState, activeTrafficStates),
				inArray(deployments.observedPhase, observedReadyPhases),
			),
		);

	const ipsByServiceId = groupBy(
		dnsDeployments,
		(deployment) => deployment.serviceId,
	);

	return allServices
		.flatMap((service) => {
			const ips = (ipsByServiceId.get(service.id) ?? [])
				.map((d) => d.ipAddress)
				.filter((ip): ip is string => ip !== null)
				.sort();

			if (ips.length === 0) return [];

			return [{ name: `${service.specification.hostname}.internal`, ips }];
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

async function buildTraefikConfig(
	server: Server,
	allServices: RuntimeServiceRevision[],
) {
	const emptyConfig = { httpRoutes: [], tcpRoutes: [], udpRoutes: [] };
	if (!server.isProxy) return emptyConfig;

	const serviceIds = allServices.map((service) => service.id);
	const [routableDeployments, proxyHostedServerlessDeployments] =
		await Promise.all([
			serviceIds.length > 0
				? db
						.select({
							serviceId: deployments.serviceId,
							ipAddress: deployments.ipAddress,
							serverId: deployments.serverId,
						})
						.from(deployments)
						.where(
							and(
								inArray(deployments.serviceId, serviceIds),
								eq(deployments.runtimeDesiredState, "running"),
								inArray(deployments.trafficState, activeTrafficStates),
								inArray(deployments.observedPhase, observedReadyPhases),
							),
						)
				: Promise.resolve([]),
			serviceIds.length > 0
				? db
						.select({
							serviceId: deployments.serviceId,
							serverId: deployments.serverId,
						})
						.from(deployments)
						.innerJoin(servers, eq(deployments.serverId, servers.id))
						.where(
							and(
								inArray(deployments.serviceId, serviceIds),
								eq(servers.isProxy, true),
								inArray(deployments.runtimeDesiredState, runtimeExpectedStates),
								inArray(deployments.trafficState, activeTrafficStates),
							),
						)
				: Promise.resolve([]),
		]);
	const { serverlessServiceIds, serverlessRouteSuppressedServiceIds } =
		buildServerlessTraefikRouteSets({
			serverId: server.id,
			services: allServices,
			proxyHostedServerlessDeployments,
		});

	const routePorts = buildRuntimeRoutePorts(allServices);
	const routes = buildTraefikRoutes({
		serverId: server.id,
		ports: routePorts,
		routableDeployments,
		serverlessServiceIds,
		serverlessRouteSuppressedServiceIds,
	});
	const certificateDomains = buildTraefikCertificateDomains(routePorts);
	const certificates = await getAllCertificatesForDomains(certificateDomains);
	const controlPlaneUrl = process.env.APP_URL;

	if (!controlPlaneUrl) {
		console.warn(
			"[expected-state] APP_URL not set - ACME challenge route will not be configured",
		);
	}

	return {
		...routes,
		certificates,
		challengeRoute: controlPlaneUrl ? { controlPlaneUrl } : undefined,
	};
}

export function buildTraefikRoutes({
	serverId,
	ports,
	routableDeployments,
	serverlessServiceIds = new Set<string>(),
	serverlessRouteSuppressedServiceIds = new Set<string>(),
}: {
	serverId: string;
	ports: RouteServicePort[];
	routableDeployments: RoutableDeploymentRow[];
	serverlessServiceIds?: Set<string>;
	serverlessRouteSuppressedServiceIds?: Set<string>;
}) {
	const httpRoutes: HttpRoute[] = [];
	const tcpRoutes: TcpRoute[] = [];
	const udpRoutes: UdpRoute[] = [];
	const deploymentsByServiceId = groupBy(
		routableDeployments,
		(deployment) => deployment.serviceId,
	);

	for (const port of ports.slice().sort(compareServicePorts)) {
		const serviceDeployments = deploymentsByServiceId.get(port.serviceId) ?? [];

		if (port.isPublic && port.protocol === "http" && port.domain) {
			if (serverlessServiceIds.has(port.serviceId)) {
				httpRoutes.push({
					id: port.domain,
					domain: port.domain,
					upstreams: [
						{ url: `127.0.0.1:${SERVERLESS_GATEWAY_PORT}`, weight: 1 },
					],
					serviceId: port.serviceId,
				});
				continue;
			}

			if (serverlessRouteSuppressedServiceIds.has(port.serviceId)) {
				continue;
			}

			const localDeployments = serviceDeployments.filter(
				(d) => d.serverId === serverId && d.ipAddress,
			);
			const remoteDeployments = serviceDeployments.filter(
				(d) => d.serverId !== serverId && d.ipAddress,
			);

			const upstreams = [
				...localDeployments
					.map((d) => ({
						url: `${d.ipAddress}:${port.port}`,
						weight: 5,
					}))
					.sort((a, b) => a.url.localeCompare(b.url)),
				...remoteDeployments
					.map((d) => ({
						url: `${d.ipAddress}:${port.port}`,
						weight: 1,
					}))
					.sort((a, b) => a.url.localeCompare(b.url)),
			];

			if (upstreams.length > 0) {
				httpRoutes.push({
					id: port.domain,
					domain: port.domain,
					upstreams,
					serviceId: port.serviceId,
				});
			}
		} else if (port.isPublic && port.protocol === "tcp" && port.externalPort) {
			const upstreams = upstreamUrls(serviceDeployments, port.port);

			if (upstreams.length > 0) {
				tcpRoutes.push({
					id: `tcp-${port.serviceId}-${port.port}`,
					serviceId: port.serviceId,
					upstreams,
					externalPort: port.externalPort,
					tlsPassthrough: port.tlsPassthrough,
				});
			}
		} else if (port.isPublic && port.protocol === "udp" && port.externalPort) {
			const upstreams = upstreamUrls(serviceDeployments, port.port);

			if (upstreams.length > 0) {
				udpRoutes.push({
					id: `udp-${port.serviceId}-${port.port}`,
					serviceId: port.serviceId,
					upstreams,
					externalPort: port.externalPort,
				});
			}
		}
	}

	return { httpRoutes, tcpRoutes, udpRoutes };
}

export function buildServerlessTraefikRouteSets({
	serverId,
	services: serviceRows,
	proxyHostedServerlessDeployments,
}: {
	serverId: string;
	services: RuntimeServiceRevision[];
	proxyHostedServerlessDeployments: ProxyHostedServerlessDeploymentRow[];
}) {
	const proxyHostedServerlessServiceIds = new Set(
		proxyHostedServerlessDeployments.map((deployment) => deployment.serviceId),
	);
	const localProxyHostedServerlessServiceIds = new Set(
		proxyHostedServerlessDeployments
			.filter((deployment) => deployment.serverId === serverId)
			.map((deployment) => deployment.serviceId),
	);
	const serverlessProxyRoutedServiceIds = new Set(
		serviceRows
			.filter(
				(service) =>
					service.specification.serverless.enabled &&
					proxyHostedServerlessServiceIds.has(service.id),
			)
			.map((service) => service.id),
	);
	const serverlessServiceIds = new Set(
		[...serverlessProxyRoutedServiceIds].filter((serviceId) =>
			localProxyHostedServerlessServiceIds.has(serviceId),
		),
	);
	const serverlessRouteSuppressedServiceIds = new Set(
		[...serverlessProxyRoutedServiceIds].filter(
			(serviceId) => !serverlessServiceIds.has(serviceId),
		),
	);

	return { serverlessServiceIds, serverlessRouteSuppressedServiceIds };
}

export function buildTraefikCertificateDomains(ports: RouteServicePort[]) {
	return Array.from(
		new Set(
			ports
				.filter((port) => port.isPublic && port.protocol === "http")
				.map((port) => port.domain?.trim())
				.filter((domain): domain is string => Boolean(domain)),
		),
	).sort();
}

function buildEnv(secretRows: ServiceRevisionSecret[]) {
	const env: Record<string, string> = {};
	for (const secret of secretRows
		.slice()
		.sort((a, b) => a.key.localeCompare(b.key))) {
		env[secret.key] = secret.encryptedValue;
	}
	return env;
}

function hashContainerCreationSpec(specification: {
	image: string;
	ipAddress: string | null;
	ports: ExpectedContainer["ports"];
	publishLocalPorts: boolean;
	env: Record<string, string>;
	startCommand: string | null;
	healthCheck: ServiceRevisionSpec["healthCheck"];
	volumes: ExpectedContainer["volumes"];
	resourceCpuLimit: number | null;
	resourceMemoryLimitMb: number | null;
}) {
	return createHash("sha256")
		.update(JSON.stringify(specification))
		.digest("hex");
}

function upstreamUrls(deployments: RoutableDeploymentRow[], port: number) {
	return deployments
		.map((d) => d.ipAddress)
		.filter((ip): ip is string => ip !== null)
		.map((ip) => `${ip}:${port}`)
		.sort();
}

function compareServerlessUpstreams(
	a: ServerlessRouteUpstream,
	b: ServerlessRouteUpstream,
) {
	if (a.local !== b.local) return a.local ? -1 : 1;
	if (a.alwaysOn !== b.alwaysOn) return a.alwaysOn ? -1 : 1;
	return a.url.localeCompare(b.url);
}

function normalizeImage(image: string) {
	if (!image.includes("/")) {
		return `docker.io/library/${image}`;
	}
	if (!image.includes(".") && image.split("/").length === 2) {
		return `docker.io/${image}`;
	}
	return image;
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K) {
	const groups = new Map<K, T[]>();
	for (const item of items) {
		const key = keyFn(item);
		const group = groups.get(key);
		if (group) {
			group.push(item);
		} else {
			groups.set(key, [item]);
		}
	}
	return groups;
}

export function buildRuntimeRoutePorts(
	serviceRows: RuntimeServiceRevision[],
): RouteServicePort[] {
	return serviceRows.flatMap((service) =>
		service.specification.ports.map((port, index) => ({
			id: `${service.revisionId}:${index}`,
			serviceId: service.id,
			port: port.containerPort,
			isPublic: port.isPublic,
			domain: port.domain,
			protocol: port.protocol,
			externalPort: port.externalPort,
			tlsPassthrough: port.tlsPassthrough,
		})),
	);
}

function compareServicePorts(a: RouteServicePort, b: RouteServicePort) {
	return (
		a.serviceId.localeCompare(b.serviceId) ||
		a.protocol.localeCompare(b.protocol) ||
		a.port - b.port
	);
}

function unique<T>(items: T[]) {
	return Array.from(new Set(items));
}
