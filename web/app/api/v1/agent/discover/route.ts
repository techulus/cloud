import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    loggingEndpoint: process.env.VICTORIA_LOGS_URL ?? null,
    version: 1,
  });
}
