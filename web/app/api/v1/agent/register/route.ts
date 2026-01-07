import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { eq, and, isNull, gt } from "drizzle-orm";
import { assignSubnet } from "@/lib/wireguard";

const TOKEN_EXPIRY_HOURS = 24;

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const {
			token,
			wireguardPublicKey,
			signingPublicKey,
			publicIp,
			privateIp,
			isProxy,
		} = body;

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
				privateIp: privateIp || null,
				isProxy: isProxy === true,
				tokenUsedAt: now,
				status: "online",
				lastHeartbeat: now,
			})
			.where(eq(servers.id, server.id));

		return NextResponse.json({
			serverId: server.id,
			subnetId,
			wireguardIp,
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
