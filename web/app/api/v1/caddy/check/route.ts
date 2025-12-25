import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { services } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const domain = request.nextUrl.searchParams.get("domain");

  if (!domain) {
    return NextResponse.json({ error: "Missing domain" }, { status: 400 });
  }

  const [service] = await db
    .select()
    .from(services)
    .where(eq(services.exposedDomain, domain));

  if (service) {
    return NextResponse.json({ allowed: true }, { status: 200 });
  }

  return NextResponse.json({ error: "Domain not allowed" }, { status: 404 });
}
