import { randomUUID } from "node:crypto";
import type * as grpc from "@grpc/grpc-js";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { verifyEd25519Signature } from "@/lib/crypto";
import { isProxyServer } from "@/lib/wireguard";
import {
	StatusUpdate,
	WorkComplete,
	Heartbeat,
	type AgentMessage,
	type AgentServiceServer,
	type ControlPlaneMessage,
} from "../generated/proto/agent";
import { pushCaddyConfigToProxies } from "../handlers/caddy";
import { handleStatusUpdate } from "../handlers/status";
import { handleWorkComplete } from "../handlers/work";
import { connectionStore } from "../store/connections";

type AgentStream = grpc.ServerDuplexStream<AgentMessage, ControlPlaneMessage>;

function verifyMessage(
	msg: AgentMessage,
	server: { signingPublicKey: string | null },
): boolean {
	if (!server.signingPublicKey) return false;

	const timestampMs = Number.parseInt(msg.timestamp, 10);
	const now = Date.now();
	if (Math.abs(now - timestampMs) > 5 * 60 * 1000) {
		console.log(`[grpc:auth] timestamp expired: ${timestampMs} vs ${now}`);
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

	const timestampBytes = Buffer.from(`${msg.timestamp}:`);
	const message = Buffer.concat([timestampBytes, payloadBytes]);

	return verifyEd25519Signature(
		server.signingPublicKey,
		message,
		msg.signature,
	);
}

export function createAgentService(): AgentServiceServer {
	return {
		connect(call: AgentStream): void {
			let authenticated = false;
			let serverId: string | null = null;
			let serverName: string | null = null;
			let sessionId: string | null = null;

			call.on("data", async (msg: AgentMessage) => {
				const msgType = msg.status_update
					? "StatusUpdate"
					: msg.work_complete
						? "WorkComplete"
						: msg.heartbeat
							? "Heartbeat"
							: "Unknown";
				console.log(`[grpc:recv] server=${msg.server_id} type=${msgType}`);

				try {
					if (!authenticated) {
						if (!msg.status_update) {
							call.write({
								error: {
									code: 401,
									message:
										"First message must be a status update for authentication",
									fatal: true,
								},
							});
							call.end();
							return;
						}

						const serverResults = await db
							.select()
							.from(servers)
							.where(eq(servers.id, msg.server_id));

						const server = serverResults[0];
						if (!server || !server.signingPublicKey) {
							call.write({
								error: {
									code: 404,
									message: "Server not found or not registered",
									fatal: true,
								},
							});
							call.end();
							return;
						}

						if (server.status === "unknown") {
							call.write({
								error: {
									code: 403,
									message: "Server requires approval",
									fatal: true,
								},
							});
							call.end();
							return;
						}

						const isValid = verifyMessage(msg, server);
						if (!isValid) {
							call.write({
								error: {
									code: 401,
									message: "Invalid signature",
									fatal: true,
								},
							});
							call.end();
							return;
						}

						authenticated = true;
						serverId = msg.server_id;
						serverName = server.name;
						sessionId = randomUUID();
						const isProxy = isProxyServer(server.wireguardIp);

						connectionStore.add(serverId, serverName, call, sessionId, isProxy);

						call.write({
							connected: { session_id: sessionId },
						});

						console.log(
							`[agent:${serverName}] connected via gRPC (proxy=${isProxy})`,
						);

						await handleStatusUpdate(serverId, {
							resources: msg.status_update.resources
								? {
										cpuCores: msg.status_update.resources.cpu_cores,
										memoryTotalMb: msg.status_update.resources.memory_total_mb,
										diskTotalGb: msg.status_update.resources.disk_total_gb,
									}
								: undefined,
							publicIp: msg.status_update.public_ip,
							containers: msg.status_update.containers,
							proxyRoutes: msg.status_update.proxy_routes?.map((r) => ({
								routeId: r.route_id,
								domain: r.domain,
								upstreams: r.upstreams,
							})),
						});

						if (isProxy) {
							await pushCaddyConfigToProxies();
						}

						return;
					}

					if (msg.server_id !== serverId) {
						call.write({
							error: {
								code: 400,
								message: "Server ID mismatch",
								fatal: true,
							},
						});
						call.end();
						return;
					}

					connectionStore.updateHeartbeat(serverId);

					if (msg.status_update) {
						await handleStatusUpdate(serverId, {
							resources: msg.status_update.resources
								? {
										cpuCores: msg.status_update.resources.cpu_cores,
										memoryTotalMb: msg.status_update.resources.memory_total_mb,
										diskTotalGb: msg.status_update.resources.disk_total_gb,
									}
								: undefined,
							publicIp: msg.status_update.public_ip,
							containers: msg.status_update.containers,
							proxyRoutes: msg.status_update.proxy_routes?.map((r) => ({
								routeId: r.route_id,
								domain: r.domain,
								upstreams: r.upstreams,
							})),
						});
					} else if (msg.work_complete) {
						await handleWorkComplete(serverId, msg.work_complete);
						call.write({
							ack: {
								message_id: msg.work_complete.work_id,
								success: true,
							},
						});
					} else if (msg.heartbeat) {
						console.log(`[agent:${serverName}] heartbeat`);
					}
				} catch (error) {
					console.error(`[agent:${serverName || msg.server_id}] error:`, error);
					call.write({
						error: {
							code: 500,
							message:
								error instanceof Error ? error.message : "Internal error",
							fatal: false,
						},
					});
				}
			});

			call.on("end", () => {
				if (serverId) {
					connectionStore.remove(serverId);
					console.log(`[agent:${serverName}] disconnected`);
				}
				call.end();
			});

			call.on("error", (error) => {
				if (serverId) {
					connectionStore.remove(serverId);
					console.log(`[agent:${serverName}] connection error:`, error.message);
				}
			});
		},
	};
}
