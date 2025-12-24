import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { servers, workQueue } from "@/db/schema";
import { eq, and, isNull, gt, ne } from "drizzle-orm";
import { assignWireGuardIp, getWireGuardPeers } from "@/lib/wireguard";
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

    const peers = await getWireGuardPeers(server.id);

    const otherServers = await db
      .select({ id: servers.id })
      .from(servers)
      .where(
        and(
          ne(servers.id, server.id),
          eq(servers.status, "online")
        )
      );

    for (const otherServer of otherServers) {
      const otherPeers = await getWireGuardPeers(otherServer.id);
      await db.insert(workQueue).values({
        id: randomUUID(),
        serverId: otherServer.id,
        type: "update_wireguard",
        payload: JSON.stringify({ peers: otherPeers }),
      });
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
