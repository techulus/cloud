import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { servicePorts, deployments } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const domain = request.nextUrl.searchParams.get("domain");
  const clientIp = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";

  console.log(`[caddy-check] domain=${domain} ip=${clientIp}`);

  if (!domain) {
    console.log(`[caddy-check] REJECT: missing domain`);
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
    console.log(`[caddy-check] REJECT: domain=${domain} not found`);
    return NextResponse.json({ error: "Domain not allowed" }, { status: 404 });
  }

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
    console.log(`[caddy-check] RETRY: domain=${domain} no running deployments`);
    return NextResponse.json(
      { error: "Service not currently available" },
      { status: 503 }
    );
  }

  console.log(`[caddy-check] ALLOW: domain=${domain} deployments=${runningDeployments.length}`);
  return NextResponse.json({ allowed: true }, { status: 200 });
}
