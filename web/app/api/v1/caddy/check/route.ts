import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { servicePorts, deployments } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const domain = request.nextUrl.searchParams.get("domain");

  if (!domain) {
    return NextResponse.json({ error: "Missing domain" }, { status: 400 });
  }

  const [port] = await db
    .select()
    .from(servicePorts)
    .where(
      and(
        eq(servicePorts.domain, domain),
        eq(servicePorts.isPublic, true)
      )
    );

  if (!port) {
    return NextResponse.json({ error: "Domain not allowed" }, { status: 404 });
  }

  // Verify service has at least one running deployment
  // This ensures DNS records will be present for ACME to validate
  const runningDeployments = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, port.serviceId),
        eq(deployments.status, "running")
      )
    );

  if (runningDeployments.length === 0) {
    // Service exists but has no running deployments yet
    // Return 503 (Service Unavailable) instead of 404 to tell Caddy to retry
    // This handles the case where deployment just started but isn't fully ready yet
    return NextResponse.json(
      { error: "Service not currently available" },
      { status: 503 }
    );
  }

  return NextResponse.json({ allowed: true }, { status: 200 });
}
