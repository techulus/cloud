import { and, eq, gt, isNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { getEncryptionKeyHex } from "@/lib/crypto";
import { HOUR_IN_MILLISECONDS, subtractMilliseconds } from "@/lib/date";
import { EncryptionKeyUnavailableError } from "@/lib/kms";
import { agentRegisterSchema } from "@/lib/schemas";
import { formatZodErrors } from "@/lib/utils";
import { assignSubnet } from "@/lib/wireguard";

const TOKEN_EXPIRY_HOURS = 24;

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const parseResult = agentRegisterSchema.safeParse(body);

		if (!parseResult.success) {
			return NextResponse.json(
				{ error: formatZodErrors(parseResult.error) },
				{ status: 400 },
			);
		}

		const {
			token,
			wireguardPublicKey,
			signingPublicKey,
			publicIp,
			privateIp,
			isProxy,
		} = parseResult.data;

		const now = new Date();
		const expiryThreshold = subtractMilliseconds(
			now,
			TOKEN_EXPIRY_HOURS * HOUR_IN_MILLISECONDS,
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

		const encryptionKey = await getEncryptionKeyHex();

		const { subnetId, wireguardIp } = await assignSubnet();

		const claimedServers = await db
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
			.where(
				and(
					eq(servers.id, server.id),
					eq(servers.agentToken, token),
					isNull(servers.tokenUsedAt),
					gt(servers.tokenCreatedAt, expiryThreshold),
				),
			)
			.returning({ id: servers.id });

		if (claimedServers.length === 0) {
			return NextResponse.json(
				{ error: "Invalid, expired, or already used token" },
				{ status: 401 },
			);
		}

		return NextResponse.json({
			serverId: server.id,
			subnetId,
			wireguardIp,
			encryptionKey,
			loggingEndpoint: process.env.VICTORIA_LOGS_URL ?? null,
			metricsEndpoint: process.env.VICTORIA_METRICS_URL ?? null,
			registryUrl: process.env.REGISTRY_URL ?? null,
			registryUsername: process.env.REGISTRY_USERNAME ?? null,
			registryPassword: process.env.REGISTRY_PASSWORD ?? null,
			registryInsecure: process.env.REGISTRY_INSECURE !== "false",
		});
	} catch (error) {
		console.error("Agent registration error:", error);
		if (error instanceof EncryptionKeyUnavailableError) {
			return NextResponse.json(
				{ error: "Secret encryption service unavailable" },
				{ status: 503 },
			);
		}
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
