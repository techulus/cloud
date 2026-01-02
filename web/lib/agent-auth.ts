import type { NextRequest } from "next/server";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyEd25519Signature } from "./crypto";

const TIMESTAMP_TOLERANCE_MS = 60 * 1000;

export type AuthResult =
	| { success: true; serverId: string; serverName: string }
	| { success: false; error: string; status: number };

export async function verifyAgentRequest(
	request: NextRequest,
	body?: string,
): Promise<AuthResult> {
	const serverId = request.headers.get("x-server-id");
	const timestamp = request.headers.get("x-timestamp");
	const signature = request.headers.get("x-signature");

	if (!serverId || !timestamp || !signature) {
		return {
			success: false,
			error: "Missing required headers: x-server-id, x-timestamp, x-signature",
			status: 400,
		};
	}

	const timestampMs = Number.parseInt(timestamp, 10);
	const now = Date.now();
	if (
		Number.isNaN(timestampMs) ||
		Math.abs(now - timestampMs) > TIMESTAMP_TOLERANCE_MS
	) {
		return {
			success: false,
			error: "Request timestamp expired or invalid",
			status: 401,
		};
	}

	const serverResults = await db
		.select()
		.from(servers)
		.where(eq(servers.id, serverId));

	const server = serverResults[0];
	if (!server || !server.signingPublicKey) {
		return {
			success: false,
			error: "Server not found or not registered",
			status: 404,
		};
	}

	const messageToVerify = `${timestamp}:${body ?? ""}`;
	const isValid = verifyEd25519Signature(
		server.signingPublicKey,
		messageToVerify,
		signature,
	);

	if (!isValid) {
		return {
			success: false,
			error: "Invalid signature",
			status: 401,
		};
	}

	return {
		success: true,
		serverId: server.id,
		serverName: server.name,
	};
}
