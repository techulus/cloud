import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { servers, workQueue } from "@/db/schema";
import { eq, and, isNull, gt } from "drizzle-orm";
import { assignWireGuardIp, getWireGuardPeers, isProxyServer } from "@/lib/wireguard";
import { PROXY_WIREGUARD_IP } from "@/lib/constants";
import { randomUUID } from "crypto";

const TOKEN_EXPIRY_HOURS = 24;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, wireguardPublicKey, signingPublicKey, publicIp } = body;

    if (!token || !wireguardPublicKey || !signingPublicKey) {
      return NextResponse.json(
        { error: "Missing required fields: token, wireguardPublicKey, signingPublicKey" },
        { status: 400 }
      );
    }

    const now = new Date();
    const expiryThreshold = new Date(
      now.getTime() - TOKEN_EXPIRY_HOURS * 60 * 60 * 1000
    );

    const serverResults = await db
      .select()
      .from(servers)
      .where(
        and(
          eq(servers.agentToken, token),
          isNull(servers.tokenUsedAt),
          gt(servers.tokenCreatedAt, expiryThreshold)
        )
      );

    const server = serverResults[0];

    if (!server) {
      return NextResponse.json(
        { error: "Invalid, expired, or already used token" },
        { status: 401 }
      );
    }

    const wireguardIp = await assignWireGuardIp();

    await db
      .update(servers)
      .set({
        wireguardPublicKey,
        signingPublicKey,
        wireguardIp,
        publicIp: publicIp || null,
        tokenUsedAt: now,
        status: "online",
        lastHeartbeat: now,
      })
      .where(eq(servers.id, server.id));

    const peers = await getWireGuardPeers(server.id, wireguardIp);

    if (!isProxyServer(wireguardIp)) {
      const proxyServer = await db
        .select({ id: servers.id, wireguardIp: servers.wireguardIp })
        .from(servers)
        .where(
          and(
            eq(servers.status, "online"),
            eq(servers.wireguardIp, PROXY_WIREGUARD_IP)
          )
        )
        .then((r) => r[0]);

      if (proxyServer) {
        const proxyPeers = await getWireGuardPeers(
          proxyServer.id,
          proxyServer.wireguardIp!
        );
        await db.insert(workQueue).values({
          id: randomUUID(),
          serverId: proxyServer.id,
          type: "update_wireguard",
          payload: JSON.stringify({ peers: proxyPeers }),
        });
      }
    }

    return NextResponse.json({
      serverId: server.id,
      wireguardIp,
      peers,
    });
  } catch (error) {
    console.error("Agent registration error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
