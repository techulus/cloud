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

const EXPECTED_STATUSES = [
	"pending",
	"pulling",
	"starting",
	"healthy",
	"running",
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
			hostPath: `/var/lib/techulus-agent/volumes/${dep.serviceId}/${v.name}`,
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

	const caddyRoutes = [];

	for (const service of allServices) {
		const ports = await db
			.select()
			.from(servicePorts)
			.where(eq(servicePorts.serviceId, service.id));

		for (const port of ports) {
			if (port.isPublic && port.domain) {
				const routableDeployments = await db
					.select({ ipAddress: deployments.ipAddress })
					.from(deployments)
					.where(
						and(
							eq(deployments.serviceId, service.id),
							inArray(deployments.status, [...ROUTABLE_STATUSES]),
						),
					);

				const upstreams = routableDeployments
					.filter((d) => d.ipAddress)
					.map((d) => `${d.ipAddress}:${port.port}`);

				if (upstreams.length > 0) {
					caddyRoutes.push({
						id: port.domain,
						domain: port.domain,
						upstreams,
						serviceId: service.id,
					});
				}
			}
		}
	}

	const wireguardPeers = await getWireGuardPeers(serverId);

	return NextResponse.json({
		containers,
		dns: { records: dnsRecords },
		caddy: { routes: caddyRoutes },
		wireguard: { peers: wireguardPeers },
	});
}
