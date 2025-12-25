import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { servers, workQueue, deployments } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyEd25519Signature } from "@/lib/crypto";
import { syncServiceRoute } from "@/lib/caddy";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: workId } = await params;
    const serverId = request.headers.get("x-server-id");
    const signature = request.headers.get("x-signature");
    const timestamp = request.headers.get("x-timestamp");

    if (!serverId || !signature || !timestamp) {
      return NextResponse.json(
        { error: "Missing required headers" },
        { status: 400 }
      );
    }

    const timestampMs = parseInt(timestamp, 10);
    const now = Date.now();
    if (Math.abs(now - timestampMs) > 5 * 60 * 1000) {
      return NextResponse.json(
        { error: "Request timestamp too old" },
        { status: 401 }
      );
    }

    const serverResults = await db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId));

    const server = serverResults[0];

    if (!server || !server.signingPublicKey) {
      return NextResponse.json({ error: "Server not found" }, { status: 404 });
    }

    const body = await request.text();
    const message = `${timestamp}:${body}`;

    const isValid = verifyEd25519Signature(
      server.signingPublicKey,
      message,
      signature
    );

    if (!isValid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const workResults = await db
      .select()
      .from(workQueue)
      .where(
        and(
          eq(workQueue.id, workId),
          eq(workQueue.serverId, serverId),
          eq(workQueue.status, "processing")
        )
      );

    const work = workResults[0];

    if (!work) {
      return NextResponse.json(
        { error: "Work item not found or not processing" },
        { status: 404 }
      );
    }

    const parsedBody = body ? JSON.parse(body) : {};
    const { status, logs } = parsedBody;

    if (status !== "completed" && status !== "failed") {
      return NextResponse.json(
        { error: "Invalid status, must be 'completed' or 'failed'" },
        { status: 400 }
      );
    }

    await db
      .update(workQueue)
      .set({ status })
      .where(eq(workQueue.id, workId));

    if (work.type === "deploy") {
      const payload = JSON.parse(work.payload);
      const deploymentId = payload.deploymentId;
      const serviceId = payload.serviceId;

      if (deploymentId) {
        if (status === "completed") {
          const containerIdMatch = logs?.match(/Container started: ([a-f0-9]+)/);
          const containerId = containerIdMatch ? containerIdMatch[1] : null;

          await db
            .update(deployments)
            .set({
              status: "running",
              containerId,
            })
            .where(eq(deployments.id, deploymentId));

          if (serviceId) {
            syncServiceRoute(serviceId).catch(console.error);
          }
        } else {
          await db
            .update(deployments)
            .set({ status: "failed" })
            .where(eq(deployments.id, deploymentId));
        }
      }
    }

    if (work.type === "stop") {
      const payload = JSON.parse(work.payload);
      const deploymentId = payload.deploymentId;

      if (deploymentId && status === "completed") {
        const [dep] = await db
          .select({ serviceId: deployments.serviceId })
          .from(deployments)
          .where(eq(deployments.id, deploymentId));

        await db
          .update(deployments)
          .set({ status: "stopped" })
          .where(eq(deployments.id, deploymentId));

        if (dep?.serviceId) {
          syncServiceRoute(dep.serviceId).catch(console.error);
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Work complete error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
