import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	secrets,
	servers,
	servicePorts,
	services,
	serviceVolumes,
} from "@/db/schema";
import { getAllCertificatesForDomains } from "@/lib/acme-manager";
import {
	activeTrafficStates,
	isDeploymentRoutable,
	observedReadyPhases,
	runtimeExpectedStates,
} from "@/lib/deployment-status";
import {
	getDeployedServerlessConfig,
	getDeployedServicePorts,
	isDeployedServerlessService,
} from "@/lib/service-config";
import { slugify } from "@/lib/utils";
import { getWireGuardPeers } from "@/lib/wireguard";

type Server = typeof servers.$inferSelect;
type Service = typeof services.$inferSelect;
type Deployment = typeof deployments.$inferSelect;
type ServicePort = typeof servicePorts.$inferSelect;
const SERVERLESS_GATEWAY_PORT = 18080;

type RouteServicePort = Pick<
	ServicePort,
	| "id"
	| "serviceId"
	| "port"
	| "isPublic"
	| "domain"
	| "protocol"
	| "externalPort"
	| "tlsPassthrough"
>;

export type ExpectedContainer = {
	deploymentId: string;
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

type SecretRow = {
	serviceId: string;
	key: string;
	encryptedValue: string;
};

type VolumeRow = {
	serviceId: string;
	name: string;
	containerPath: string;
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
	const allServices = await getActiveServices();
	const containers = await buildExpectedContainers(server.id);
	const dnsRecords = await buildDnsRecords(allServices);
	const traefikConfig = await buildTraefikConfig(server, allServices);
	const serverless = await buildServerlessExpectedState(
		server,
		allServices,
		containers,
	);
	const wireguardPeers = await getWireGuardPeers(server.id, server.privateIp);

	return {
		serverName: server.name,
		containers,
		dns: { records: dnsRecords },
		serverless,
		traefik: traefikConfig,
		wireguard: { peers: wireguardPeers },
	};
}

async function getActiveServices() {
	return db.select().from(services).where(isNull(services.deletedAt));
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
	if (serviceIds.length === 0) return [];

	const [activeServices, depPorts, serviceSecrets, volumes] = await Promise.all(
		[
			db
				.select()
				.from(services)
				.where(
					and(inArray(services.id, serviceIds), isNull(services.deletedAt)),
				),
			fetchDeploymentPorts(serverDeployments.map((dep) => dep.id)),
			db
				.select({
					serviceId: secrets.serviceId,
					key: secrets.key,
					encryptedValue: secrets.encryptedValue,
				})
				.from(secrets)
				.where(inArray(secrets.serviceId, serviceIds)),
			db
				.select({
					serviceId: serviceVolumes.serviceId,
					name: serviceVolumes.name,
					containerPath: serviceVolumes.containerPath,
				})
				.from(serviceVolumes)
				.where(inArray(serviceVolumes.serviceId, serviceIds)),
		],
	);

	return buildExpectedContainersFromRows({
		deployments: serverDeployments,
		services: activeServices,
		deploymentPorts: depPorts,
		secrets: serviceSecrets,
		volumes,
	});
}

async function fetchDeploymentPorts(deploymentIds: string[]) {
	if (deploymentIds.length === 0) return [];

	return db
		.select({
			deploymentId: deploymentPorts.deploymentId,
			hostPort: deploymentPorts.hostPort,
			containerPort: servicePorts.port,
		})
		.from(deploymentPorts)
		.innerJoin(servicePorts, eq(deploymentPorts.servicePortId, servicePorts.id))
		.where(inArray(deploymentPorts.deploymentId, deploymentIds));
}

async function fetchServicePorts(serviceIds: string[]) {
	if (serviceIds.length === 0) return [];

	return db
		.select()
		.from(servicePorts)
		.where(inArray(servicePorts.serviceId, serviceIds));
}

export function buildExpectedContainersFromRows({
	deployments: deploymentRows,
	services: serviceRows,
	deploymentPorts: deploymentPortRows,
	secrets: secretRows,
	volumes: volumeRows,
}: {
	deployments: Deployment[];
	services: Service[];
	deploymentPorts: DeploymentPortRow[];
	secrets: SecretRow[];
	volumes: VolumeRow[];
}): ExpectedContainer[] {
	const servicesById = new Map(
		serviceRows.map((service) => [service.id, service]),
	);
	const portsByDeploymentId = groupBy(
		deploymentPortRows,
		(port) => port.deploymentId,
	);
	const secretsByServiceId = groupBy(secretRows, (secret) => secret.serviceId);
	const volumesByServiceId = groupBy(volumeRows, (volume) => volume.serviceId);

	return deploymentRows
		.slice()
		.sort((a, b) => a.id.localeCompare(b.id))
		.flatMap((dep) => {
			const service = servicesById.get(dep.serviceId);
			if (!service) return [];

			return [
				{
					deploymentId: dep.id,
					serviceId: dep.serviceId,
					serviceName: service.name,
					name: `${dep.serviceId}-${dep.id.slice(0, 8)}`,
					desiredState:
						dep.runtimeDesiredState === "stopped" ? "stopped" : "running",
					image: normalizeImage(service.image),
					ipAddress: dep.ipAddress,
					ports: (portsByDeploymentId.get(dep.id) ?? [])
						.slice()
						.sort((a, b) => a.containerPort - b.containerPort)
						.map((p) => ({
							containerPort: p.containerPort,
							hostPort: p.hostPort,
						})),
					publishLocalPorts: isDeployedServerlessService(service),
					env: buildEnv(secretsByServiceId.get(dep.serviceId) ?? []),
					startCommand: service.startCommand || null,
					healthCheck: buildHealthCheck(service),
					volumes: (volumesByServiceId.get(dep.serviceId) ?? [])
						.slice()
						.sort((a, b) => a.containerPath.localeCompare(b.containerPath))
						.map((v) => ({
							name: v.name,
							containerPath: v.containerPath,
						})),
					resourceCpuLimit: service.resourceCpuLimit,
					resourceMemoryLimitMb: service.resourceMemoryLimitMb,
				},
			];
		});
}

async function buildServerlessExpectedState(
	server: Server,
	allServices: Service[],
	containers: ExpectedContainer[],
): Promise<{ routes: ServerlessRoute[] }> {
	if (!server.isProxy) {
		return { routes: [] };
	}

	const serverlessServices = allServices.filter(isDeployedServerlessService);
	if (serverlessServices.length === 0) return { routes: [] };

	const serviceIds = serverlessServices.map((service) => service.id);
	const [ports, deploymentRows] = await Promise.all([
		db
			.select()
			.from(servicePorts)
			.where(inArray(servicePorts.serviceId, serviceIds)),
		db
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
			),
	]);

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
	services: Service[];
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
			getRuntimeServicePortsForRoutes(
				service,
				portsByServiceId.get(service.id) ?? [],
			).map((port) => ({ service, port })),
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
					sleepAfterSeconds:
						getDeployedServerlessConfig(service).sleepAfterSeconds,
					wakeTimeoutSeconds:
						getDeployedServerlessConfig(service).wakeTimeoutSeconds,
					localDeploymentIds,
					upstreams,
				},
			];
		});
}

async function buildDnsRecords(allServices: Service[]) {
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

			const hostname = service.hostname || slugify(service.name);
			return [{ name: `${hostname}.internal`, ips }];
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

async function buildTraefikConfig(server: Server, allServices: Service[]) {
	const emptyConfig = { httpRoutes: [], tcpRoutes: [], udpRoutes: [] };
	if (!server.isProxy) return emptyConfig;

	const serviceIds = allServices.map((service) => service.id);
	const [ports, routableDeployments, proxyHostedServerlessDeployments] =
		await Promise.all([
			serviceIds.length > 0
				? db
						.select()
						.from(servicePorts)
						.where(inArray(servicePorts.serviceId, serviceIds))
				: Promise.resolve([]),
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

	const routePorts = buildRuntimeRoutePorts(allServices, ports);
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
	services: Service[];
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
					isDeployedServerlessService(service) &&
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

function buildHealthCheck(service: Service): ExpectedContainer["healthCheck"] {
	if (!service.healthCheckCmd) return null;

	return {
		cmd: service.healthCheckCmd,
		interval: service.healthCheckInterval ?? 10,
		timeout: service.healthCheckTimeout ?? 5,
		retries: service.healthCheckRetries ?? 3,
		startPeriod: service.healthCheckStartPeriod ?? 30,
	};
}

function buildEnv(secretRows: SecretRow[]) {
	const env: Record<string, string> = {};
	for (const secret of secretRows
		.slice()
		.sort((a, b) => a.key.localeCompare(b.key))) {
		env[secret.key] = secret.encryptedValue;
	}
	return env;
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
	serviceRows: Service[],
	portRows: ServicePort[],
): RouteServicePort[] {
	const portsByServiceId = groupBy(portRows, (port) => port.serviceId);
	return serviceRows.flatMap((service) =>
		getRuntimeServicePortsForRoutes(
			service,
			portsByServiceId.get(service.id) ?? [],
		),
	);
}

function getRuntimeServicePortsForRoutes(
	service: Service,
	livePorts: RouteServicePort[],
): RouteServicePort[] {
	const ports = isDeployedServerlessService(service)
		? getDeployedServicePorts(service, livePorts)
		: livePorts;
	return ports.map((port, index) => {
		const routePort = port as Partial<RouteServicePort>;
		return {
			id:
				typeof routePort.id === "string"
					? routePort.id
					: `${service.id}:deployed:${index}`,
			serviceId: service.id,
			port: port.port,
			isPublic: port.isPublic,
			domain: port.domain,
			protocol: port.protocol ?? "http",
			externalPort:
				typeof routePort.externalPort === "number"
					? routePort.externalPort
					: null,
			tlsPassthrough: routePort.tlsPassthrough ?? false,
		};
	});
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
