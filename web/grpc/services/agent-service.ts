import { randomUUID } from "node:crypto";
import type * as grpc from "@grpc/grpc-js";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { verifyEd25519Signature } from "@/lib/crypto";
import {
	StatusUpdate,
	WorkComplete,
	Heartbeat,
	type AgentMessage,
	type AgentServiceServer,
	type ControlPlaneMessage,
} from "../generated/proto/agent";
import { handleStatusUpdate } from "../handlers/status";
import { handleWorkComplete } from "../handlers/work";
import { connectionStore } from "../store/connections";

type AgentStream = grpc.ServerDuplexStream<AgentMessage, ControlPlaneMessage>;

const TIMESTAMP_TOLERANCE_MS = 60 * 1000;

interface SessionContext {
	authenticated: boolean;
	serverId: string | null;
	serverName: string | null;
	sessionId: string | null;
	signingPublicKey: string | null;
}

function verifyMessage(msg: AgentMessage, publicKey: string): boolean {
	const timestampMs = Number.parseInt(msg.timestamp, 10);
	const now = Date.now();
	if (Math.abs(now - timestampMs) > TIMESTAMP_TOLERANCE_MS) {
		console.log(
			`[grpc:auth] timestamp expired: ${timestampMs} vs ${now} (diff=${Math.abs(now - timestampMs)}ms)`
		);
		return false;
	}

	let payloadBytes: Uint8Array;
	if (msg.status_update) {
		payloadBytes = StatusUpdate.encode(msg.status_update).finish();
	} else if (msg.work_complete) {
		payloadBytes = WorkComplete.encode(msg.work_complete).finish();
	} else if (msg.heartbeat) {
		payloadBytes = Heartbeat.encode(msg.heartbeat).finish();
	} else {
		return false;
	}

	const messageToVerify = Buffer.concat([
		Buffer.from(`${msg.timestamp}:`),
		Buffer.from(payloadBytes),
	]);

	return verifyEd25519Signature(publicKey, messageToVerify, msg.signature);
}

function sendError(
	call: AgentStream,
	serverId: string | null,
	code: number,
	message: string,
	fatal: boolean
): void {
	if (serverId) {
		connectionStore.sendMessage(serverId, {
			error: { code, message, fatal },
		});
	} else {
		call.write({ error: { code, message, fatal }, sequence: 1 });
	}
}

export function createAgentService(): AgentServiceServer {

	return {
		connect(call: AgentStream): void {
			const ctx: SessionContext = {
				authenticated: false,
				serverId: null,
				serverName: null,
				sessionId: null,
				signingPublicKey: null,
			};

			call.on("data", async (msg: AgentMessage) => {
				const msgType = msg.status_update
					? "StatusUpdate"
					: msg.work_complete
						? "WorkComplete"
						: msg.heartbeat
							? "Heartbeat"
							: "Unknown";
				console.log(
					`[grpc:recv] server=${msg.server_id} type=${msgType} seq=${msg.sequence}`
				);

				try {
					if (!ctx.authenticated) {
						if (!msg.status_update) {
							sendError(
								call,
								null,
								401,
								"First message must be a status update for authentication",
								true
							);
							call.end();
							return;
						}

						const serverResults = await db
							.select()
							.from(servers)
							.where(eq(servers.id, msg.server_id));

						const server = serverResults[0];
						if (!server || !server.signingPublicKey) {
							sendError(
								call,
								null,
								404,
								"Server not found or not registered",
								true
							);
							call.end();
							return;
						}

						if (server.status === "unknown") {
							sendError(
								call,
								null,
								403,
								"Server requires approval",
								true
							);
							call.end();
							return;
						}

						const isValid = verifyMessage(msg, server.signingPublicKey);
						if (!isValid) {
							sendError(call, null, 401, "Invalid signature", true);
							call.end();
							return;
						}

						ctx.authenticated = true;
						ctx.serverId = msg.server_id;
						ctx.serverName = server.name;
						ctx.sessionId = randomUUID();
						ctx.signingPublicKey = server.signingPublicKey;

						connectionStore.add(
							ctx.serverId,
							ctx.serverName,
							call,
							ctx.sessionId
						);

						connectionStore.sendMessage(ctx.serverId, {
							connected: { session_id: ctx.sessionId },
						});

						console.log(
							`[agent:${ctx.serverName}] connected via gRPC`
						);

						await handleStatusUpdate(ctx.serverId, {
							resources: msg.status_update.resources
								? {
										cpu_cores: msg.status_update.resources.cpu_cores,
										memory_total_mb: msg.status_update.resources.memory_total_mb,
										disk_total_gb: msg.status_update.resources.disk_total_gb,
									}
								: undefined,
							public_ip: msg.status_update.public_ip,
							container_health: msg.status_update.container_health,
						});

						return;
					}

					if (msg.server_id !== ctx.serverId) {
						sendError(
							call,
							ctx.serverId,
							400,
							"Server ID mismatch",
							true
						);
						call.end();
						return;
					}

					const isValid = verifyMessage(msg, ctx.signingPublicKey!);
					if (!isValid) {
						console.error(
							`[agent:${ctx.serverName}] signature verification failed for ${msgType}`
						);
						sendError(
							call,
							ctx.serverId,
							401,
							"Invalid signature",
							true
						);
						call.end();
						return;
					}

					if (
						!connectionStore.validateAndUpdateSequence(
							ctx.serverId!,
							msg.sequence
						)
					) {
						console.error(
							`[agent:${ctx.serverName}] replay attack detected: seq=${msg.sequence}`
						);
						sendError(
							call,
							ctx.serverId,
							400,
							"Invalid sequence number (replay detected)",
							true
						);
						call.end();
						return;
					}

					connectionStore.updateHeartbeat(ctx.serverId!);

					if (msg.status_update) {
						await handleStatusUpdate(ctx.serverId!, {
							resources: msg.status_update.resources
								? {
										cpu_cores: msg.status_update.resources.cpu_cores,
										memory_total_mb: msg.status_update.resources.memory_total_mb,
										disk_total_gb: msg.status_update.resources.disk_total_gb,
									}
								: undefined,
							public_ip: msg.status_update.public_ip,
							container_health: msg.status_update.container_health,
						});
					} else if (msg.work_complete) {
						await handleWorkComplete(ctx.serverId!, msg.work_complete);
						connectionStore.sendMessage(ctx.serverId!, {
							ack: {
								message_id: msg.work_complete.work_id,
								success: true,
							},
						});
					} else if (msg.heartbeat) {
						console.log(`[agent:${ctx.serverName}] heartbeat`);
					}
				} catch (error) {
					console.error(
						`[agent:${ctx.serverName || msg.server_id}] error:`,
						error
					);
					sendError(
						call,
						ctx.serverId,
						500,
						error instanceof Error ? error.message : "Internal error",
						false
					);
				}
			});

			call.on("end", () => {
				if (ctx.serverId) {
					connectionStore.remove(ctx.serverId);
					console.log(`[agent:${ctx.serverName}] disconnected`);
				}
				call.end();
			});

			call.on("error", (error) => {
				if (ctx.serverId) {
					connectionStore.remove(ctx.serverId);
					console.log(
						`[agent:${ctx.serverName}] connection error:`,
						error.message
					);
				}
			});
		},
	};
}
