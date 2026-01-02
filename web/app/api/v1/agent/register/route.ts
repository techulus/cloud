import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { servers, workQueue } from "@/db/schema";
import { eq, and, isNull, gt, isNotNull, ne } from "drizzle-orm";
import { assignSubnet, getWireGuardPeers } from "@/lib/wireguard";
import { randomUUID } from "node:crypto";

const TOKEN_EXPIRY_HOURS = 24;

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const { token, wireguardPublicKey, signingPublicKey, publicIp } = body;

		if (!token || !wireguardPublicKey || !signingPublicKey) {
			return NextResponse.json(
				{
					error:
						"Missing required fields: token, wireguardPublicKey, signingPublicKey",
				},
				{ status: 400 },
			);
		}

		const now = new Date();
		const expiryThreshold = new Date(
			now.getTime() - TOKEN_EXPIRY_HOURS * 60 * 60 * 1000,
		);

		const serverResults = await db
			.select()
			.from(servers)
			.where(
				and(
					eq(servers.agentToken, token),
					isNull(servers.tokenUsedAt),
					gt(servers.tokenCreatedAt, expiryThreshold),
				),
			);

		const server = serverResults[0];

		if (!server) {
			return NextResponse.json(
				{ error: "Invalid, expired, or already used token" },
				{ status: 401 },
			);
		}

		const { subnetId, wireguardIp } = await assignSubnet();

		await db
			.update(servers)
			.set({
				wireguardPublicKey,
				signingPublicKey,
				subnetId,
				wireguardIp,
				publicIp: publicIp || null,
				tokenUsedAt: now,
				status: "online",
				lastHeartbeat: now,
			})
			.where(eq(servers.id, server.id));

		const peers = await getWireGuardPeers(server.id);

		const existingServers = await db
			.select({ id: servers.id })
			.from(servers)
			.where(
				and(
					eq(servers.status, "online"),
					isNotNull(servers.subnetId),
					ne(servers.id, server.id),
				),
			);

		for (const existingServer of existingServers) {
			const existingPeers = await getWireGuardPeers(existingServer.id);
			await db.insert(workQueue).values({
				id: randomUUID(),
				serverId: existingServer.id,
				type: "update_wireguard",
				payload: JSON.stringify({ peers: existingPeers }),
			});
		}

		return NextResponse.json({
			serverId: server.id,
			subnetId,
			wireguardIp,
			peers,
			encryptionKey: process.env.ENCRYPTION_KEY,
		});
	} catch (error) {
		console.error("Agent registration error:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
