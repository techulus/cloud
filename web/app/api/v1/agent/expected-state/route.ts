import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
	deployments,
	deploymentPorts,
	services,
	servicePorts,
	serviceVolumes,
	secrets,
	servers,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { slugify } from "@/lib/utils";
import { getWireGuardPeers } from "@/lib/wireguard";
import { getAllCertificatesForDomains } from "@/lib/acme-manager";

const EXPECTED_STATUSES = [
	"pending",
	"pulling",
	"starting",
	"healthy",
	"running",
	"draining",
	"unknown",
] as const;

const ROUTABLE_STATUSES = ["healthy", "running", "unknown"] as const;
const DNS_STATUSES = ["healthy", "running", "unknown"] as const;

export async function GET(request: NextRequest) {
	const auth = await verifyAgentRequest(request);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	const { serverId } = auth;

	const server = await db
		.select()
		.from(servers)
		.where(eq(servers.id, serverId))
		.then((r) => r[0]);

	if (!server) {
		return NextResponse.json({ error: "Server not found" }, { status: 404 });
	}

	const serverDeployments = await db
		.select()
		.from(deployments)
		.where(
			and(
				eq(deployments.serverId, serverId),
				inArray(deployments.status, [...EXPECTED_STATUSES]),
			),
		);

	const containers = [];

	for (const dep of serverDeployments) {
		const service = await db
			.select()
			.from(services)
			.where(eq(services.id, dep.serviceId))
			.then((r) => r[0]);

		if (!service) continue;

		const depPorts = await db
			.select({
				hostPort: deploymentPorts.hostPort,
				containerPort: servicePorts.port,
			})
			.from(deploymentPorts)
			.innerJoin(
				servicePorts,
				eq(deploymentPorts.servicePortId, servicePorts.id),
			)
			.where(eq(deploymentPorts.deploymentId, dep.id));

		const serviceSecrets = await db
			.select()
			.from(secrets)
			.where(eq(secrets.serviceId, dep.serviceId));

		const env: Record<string, string> = {};
		for (const secret of serviceSecrets) {
			env[secret.key] = secret.encryptedValue;
		}

		const volumes = await db
			.select()
			.from(serviceVolumes)
			.where(eq(serviceVolumes.serviceId, dep.serviceId));

		const volumeMounts = volumes.map((v) => ({
			name: v.name,
			containerPath: v.containerPath,
		}));

		let image = service.image;
		if (!image.includes("/")) {
			image = `docker.io/library/${image}`;
		} else if (!image.includes(".") && image.split("/").length === 2) {
			image = `docker.io/${image}`;
		}

		containers.push({
			deploymentId: dep.id,
			serviceId: dep.serviceId,
			serviceName: service.name,
			name: `${dep.serviceId}-${dep.id.slice(0, 8)}`,
			image,
			ipAddress: dep.ipAddress,
			ports: depPorts.map((p) => ({
				containerPort: p.containerPort,
				hostPort: p.hostPort,
			})),
			env,
			startCommand: service.startCommand || null,
			healthCheck: service.healthCheckCmd
				? {
						cmd: service.healthCheckCmd,
						interval: service.healthCheckInterval ?? 10,
						timeout: service.healthCheckTimeout ?? 5,
						retries: service.healthCheckRetries ?? 3,
						startPeriod: service.healthCheckStartPeriod ?? 30,
					}
				: null,
			volumes: volumeMounts,
			resourceCpuLimit: service.resourceCpuLimit,
			resourceMemoryLimitMb: service.resourceMemoryLimitMb,
		});
	}

	const allServices = await db.select().from(services);
	const dnsRecords = [];

	for (const service of allServices) {
		const dnsDeployments = await db
			.select({ ipAddress: deployments.ipAddress })
			.from(deployments)
			.where(
				and(
					eq(deployments.serviceId, service.id),
					inArray(deployments.status, [...DNS_STATUSES]),
				),
			);

		const ips = dnsDeployments
			.map((d) => d.ipAddress)
			.filter((ip): ip is string => ip !== null);

		if (ips.length > 0) {
			const hostname = service.hostname || slugify(service.name);
			dnsRecords.push({
				name: `${hostname}.internal`,
				ips,
			});
		}
	}

	const httpRoutes: Array<{
		id: string;
		domain: string;
		upstreams: Array<{ url: string; weight: number }>;
		serviceId: string;
	}> = [];
	const tcpRoutes: Array<{
		id: string;
		serviceId: string;
		upstreams: string[];
		externalPort: number;
		tlsPassthrough: boolean;
	}> = [];
	const udpRoutes: Array<{
		id: string;
		serviceId: string;
		upstreams: string[];
		externalPort: number;
	}> = [];

	if (server.isProxy) {
		for (const service of allServices) {
			const ports = await db
				.select()
				.from(servicePorts)
				.where(eq(servicePorts.serviceId, service.id));

			for (const port of ports) {
				const routableDeployments = await db
					.select({
						ipAddress: deployments.ipAddress,
						serverId: deployments.serverId,
					})
					.from(deployments)
					.where(
						and(
							eq(deployments.serviceId, service.id),
							inArray(deployments.status, [...ROUTABLE_STATUSES]),
						),
					);

				if (port.isPublic && port.protocol === "http" && port.domain) {
					const localDeployments = routableDeployments.filter(
						(d) => d.serverId === serverId && d.ipAddress,
					);
					const remoteDeployments = routableDeployments.filter(
						(d) => d.serverId !== serverId && d.ipAddress,
					);

					const upstreams = [
						...localDeployments.map((d) => ({
							url: `${d.ipAddress}:${port.port}`,
							weight: 5,
						})),
						...remoteDeployments.map((d) => ({
							url: `${d.ipAddress}:${port.port}`,
							weight: 1,
						})),
					];

					if (upstreams.length > 0) {
						httpRoutes.push({
							id: port.domain,
							domain: port.domain,
							upstreams,
							serviceId: service.id,
						});
					}
				} else if (
					port.isPublic &&
					port.protocol === "tcp" &&
					port.externalPort
				) {
					const upstreams = routableDeployments
						.filter((d) => d.ipAddress)
						.map((d) => `${d.ipAddress}:${port.port}`);

					if (upstreams.length > 0) {
						tcpRoutes.push({
							id: `tcp-${service.id}-${port.port}`,
							serviceId: service.id,
							upstreams,
							externalPort: port.externalPort,
							tlsPassthrough: port.tlsPassthrough,
						});
					}
				} else if (
					port.isPublic &&
					port.protocol === "udp" &&
					port.externalPort
				) {
					const upstreams = routableDeployments
						.filter((d) => d.ipAddress)
						.map((d) => `${d.ipAddress}:${port.port}`);

					if (upstreams.length > 0) {
						udpRoutes.push({
							id: `udp-${service.id}-${port.port}`,
							serviceId: service.id,
							upstreams,
							externalPort: port.externalPort,
						});
					}
				}
			}
		}
	}

	const wireguardPeers = await getWireGuardPeers(serverId, server.privateIp);

	let traefikConfig: {
		httpRoutes: typeof httpRoutes;
		tcpRoutes: typeof tcpRoutes;
		udpRoutes: typeof udpRoutes;
		certificates?: Array<{
			domain: string;
			certificate: string;
			certificateKey: string;
		}>;
		challengeRoute?: {
			controlPlaneUrl: string;
		};
	} = { httpRoutes, tcpRoutes, udpRoutes };

	if (server.isProxy) {
		const routedDomains = httpRoutes.map((r) => r.domain);
		const certificates = await getAllCertificatesForDomains(routedDomains);

		const controlPlaneUrl = process.env.APP_URL;
		if (!controlPlaneUrl) {
			console.warn(
				"[expected-state] APP_URL not set - ACME challenge route will not be configured",
			);
		}

		traefikConfig = {
			httpRoutes,
			tcpRoutes,
			udpRoutes,
			certificates,
			challengeRoute: controlPlaneUrl ? { controlPlaneUrl } : undefined,
		};
	}

	return NextResponse.json({
		serverName: server.name,
		containers,
		dns: { records: dnsRecords },
		traefik: traefikConfig,
		wireguard: { peers: wireguardPeers },
	});
}
