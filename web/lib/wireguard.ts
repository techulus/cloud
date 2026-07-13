import { and, isNotNull, ne } from "drizzle-orm";
import { Address4 } from "ip-address";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { CONTAINER_SUBNET_PREFIX, WIREGUARD_SUBNET_PREFIX } from "./constants";

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

export async function assignSubnet(): Promise<{
	subnetId: number;
	wireguardIp: string;
}> {
	const existingServers = await db
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

export function findAvailableContainerIp(
	subnetId: number,
	existingIps: Iterable<string>,
): string {
	const usedIps = new Set(existingIps);

	for (let hostPart = 2; hostPart <= 254; hostPart++) {
		const ip = `${CONTAINER_SUBNET_PREFIX}.${subnetId}.${hostPart}`;
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
