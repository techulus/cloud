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
	dnsDeploymentStatuses,
	expectedDeploymentStatuses,
	routableDeploymentStatuses,
} from "@/lib/deployment-status";
import { slugify } from "@/lib/utils";
import { getWireGuardPeers } from "@/lib/wireguard";

type Server = typeof servers.$inferSelect;
type Service = typeof services.$inferSelect;
type Deployment = typeof deployments.$inferSelect;
type ServicePort = typeof servicePorts.$inferSelect;
const SERVERLESS_GATEWAY_PORT = 18080;

export type ExpectedContainer = {
	deploymentId: string;
	serviceId: string;
	serviceName: string;
	name: string;
	desiredState: "running" | "stopped";
	image: string;
	ipAddress: string | null;
	ports: Array<{ containerPort: number; hostPort: number }>;
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

export type AgentExpectedState = {
	serverName: string;
	containers: ExpectedContainer[];
	dns: { records: Array<{ name: string; ips: string[] }> };
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
const SERVERLESS_GATEWAY_CAPABILITY = "serverless_gateway";

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
	const wireguardPeers = await getWireGuardPeers(server.id, server.privateIp);

	return {
		serverName: server.name,
		containers,
		dns: { records: dnsRecords },
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
				eq(deployments.desired, true),
				inArray(deployments.status, expectedDeploymentStatuses),
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
					desiredState: dep.status === "sleeping" ? "stopped" : "running",
					image: normalizeImage(service.image),
					ipAddress: dep.ipAddress,
					ports: (portsByDeploymentId.get(dep.id) ?? [])
						.slice()
						.sort((a, b) => a.containerPort - b.containerPort)
						.map((p) => ({
							containerPort: p.containerPort,
							hostPort: p.hostPort,
						})),
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
				eq(deployments.desired, true),
				inArray(deployments.status, dnsDeploymentStatuses),
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
	const supportsServerlessGateway = hasAgentCapability(
		server,
		SERVERLESS_GATEWAY_CAPABILITY,
	);
	const [ports, routableDeployments, wakeRoutedDeployments] = await Promise.all(
		[
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
								eq(deployments.desired, true),
								inArray(deployments.status, routableDeploymentStatuses),
							),
						)
				: Promise.resolve([]),
			supportsServerlessGateway && serviceIds.length > 0
				? db
						.select({ serviceId: deployments.serviceId })
						.from(deployments)
						.where(
							and(
								inArray(deployments.serviceId, serviceIds),
								eq(deployments.desired, true),
								inArray(deployments.status, ["sleeping", "waking"]),
							),
						)
				: Promise.resolve([]),
		],
	);
	const wakeRoutedServiceIds = new Set(
		wakeRoutedDeployments.map((deployment) => deployment.serviceId),
	);
	const serverlessServiceIds = supportsServerlessGateway
		? new Set(
				allServices
					.filter(
						(service) =>
							!service.stateful &&
							(service.serverlessEnabled ||
								wakeRoutedServiceIds.has(service.id)),
					)
					.map((service) => service.id),
			)
		: new Set<string>();

	const routes = buildTraefikRoutes({
		serverId: server.id,
		ports,
		routableDeployments,
		serverlessServiceIds,
	});
	const routedDomains = routes.httpRoutes.map((r) => r.domain);
	const certificates = await getAllCertificatesForDomains(routedDomains);
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

function hasAgentCapability(server: Server, capability: string) {
	return server.agentHealth?.capabilities?.includes(capability) === true;
}

export function buildTraefikRoutes({
	serverId,
	ports,
	routableDeployments,
	serverlessServiceIds = new Set<string>(),
}: {
	serverId: string;
	ports: ServicePort[];
	routableDeployments: RoutableDeploymentRow[];
	serverlessServiceIds?: Set<string>;
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

function compareServicePorts(a: ServicePort, b: ServicePort) {
	return (
		a.serviceId.localeCompare(b.serviceId) ||
		a.protocol.localeCompare(b.protocol) ||
		a.port - b.port
	);
}

function unique<T>(items: T[]) {
	return Array.from(new Set(items));
}
