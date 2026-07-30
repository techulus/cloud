import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { Address4 } from "ip-address";
import { db } from "@/db";
import { deployments, servers } from "@/db/schema";
import { CONTAINER_SUBNET_PREFIX, WIREGUARD_SUBNET_PREFIX } from "./constants";

type AllocationTransaction = Parameters<
	Parameters<typeof db.transaction>[0]
>[0];

export const SUBNET_ALLOCATION_CONSTRAINTS = new Set([
	"servers_subnet_id_unique",
	"servers_wireguard_ip_unique",
]);
export const CONTAINER_IP_ALLOCATION_CONSTRAINTS = new Set([
	"deployments_server_id_ip_address_unique_idx",
]);
const ALLOCATION_RETRY_LIMIT = 3;

function sameSubnet(ip1: string, ip2: string, prefix: number = 16): boolean {
	if (!ip1 || !ip2) return false;
	try {
		const a = new Address4(ip1);
		const b = new Address4(ip2);
		return a.mask(prefix) === b.mask(prefix);
	} catch {
		return false;
	}
}

export async function withAllocationRetry<T>(
	operation: () => Promise<T>,
	constraints: ReadonlySet<string>,
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await operation();
		} catch (error) {
			const databaseError = (
				error instanceof DrizzleQueryError ? error.cause : error
			) as { code?: string; constraint?: string };
			if (
				databaseError.code !== "23505" ||
				!databaseError.constraint ||
				!constraints.has(databaseError.constraint) ||
				attempt >= ALLOCATION_RETRY_LIMIT
			) {
				throw error;
			}
		}
	}
}

export async function assignSubnet(tx: AllocationTransaction): Promise<{
	subnetId: number;
	wireguardIp: string;
}> {
	await tx.execute(
		sql`SELECT pg_advisory_xact_lock(hashtext('subnet_allocation'))`,
	);

	const existingServers = await tx
		.select({ subnetId: servers.subnetId })
		.from(servers)
		.where(isNotNull(servers.subnetId));

	const usedSubnets = new Set(existingServers.map((s) => s.subnetId));

	for (let subnetId = 1; subnetId <= 255; subnetId++) {
		if (!usedSubnets.has(subnetId)) {
			const wireguardIp = `${WIREGUARD_SUBNET_PREFIX}.${subnetId}.1`;
			return { subnetId, wireguardIp };
		}
	}

	throw new Error("No available subnets");
}

export async function assignContainerIp(
	tx: AllocationTransaction,
	serverId: string,
): Promise<string> {
	await tx.execute(
		sql`SELECT pg_advisory_xact_lock(hashtext('container_ip_allocation'), hashtext(${serverId}))`,
	);

	const server = await tx
		.select({ subnetId: servers.subnetId })
		.from(servers)
		.where(eq(servers.id, serverId))
		.then((r) => r[0]);

	if (!server?.subnetId) {
		throw new Error("Server does not have a subnet assigned");
	}

	const existingDeployments = await tx
		.select({ ipAddress: deployments.ipAddress })
		.from(deployments)
		.where(
			and(eq(deployments.serverId, serverId), isNotNull(deployments.ipAddress)),
		);

	const usedIps = new Set(existingDeployments.map((d) => d.ipAddress));

	for (let hostPart = 2; hostPart <= 254; hostPart++) {
		const ip = `${CONTAINER_SUBNET_PREFIX}.${server.subnetId}.${hostPart}`;
		if (!usedIps.has(ip)) {
			return ip;
		}
	}

	throw new Error("No available IPs in server subnet");
}

export async function getWireGuardPeers(
	excludeServerId: string,
	requestingServerPrivateIp: string | null = null,
) {
	const allServers = await db
		.select({
			id: servers.id,
			subnetId: servers.subnetId,
			wireguardIp: servers.wireguardIp,
			wireguardPublicKey: servers.wireguardPublicKey,
			publicIp: servers.publicIp,
			privateIp: servers.privateIp,
		})
		.from(servers)
		.where(
			and(
				isNotNull(servers.wireguardPublicKey),
				isNotNull(servers.subnetId),
				ne(servers.id, excludeServerId),
			),
		);

	return allServers.map((s) => {
		let endpoint: string | null = null;

		if (
			requestingServerPrivateIp &&
			s.privateIp &&
			sameSubnet(requestingServerPrivateIp, s.privateIp, 16)
		) {
			endpoint = `${s.privateIp}:51820`;
		} else if (s.publicIp) {
			endpoint = `${s.publicIp}:51820`;
		}

		return {
			publicKey: s.wireguardPublicKey,
			allowedIps: `${WIREGUARD_SUBNET_PREFIX}.${s.subnetId}.0/24,${CONTAINER_SUBNET_PREFIX}.${s.subnetId}.0/24`,
			endpoint,
		};
	});
}
