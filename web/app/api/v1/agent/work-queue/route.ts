import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { workQueue } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";

export async function GET(request: NextRequest) {
	const auth = await verifyAgentRequest(request);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	const { serverId } = auth;

	const items = await db
		.select()
		.from(workQueue)
		.where(and(eq(workQueue.serverId, serverId), eq(workQueue.status, "pending")));

	return NextResponse.json({ items });
}

export async function POST(request: NextRequest) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	let data: { id: string; status: "completed" | "failed"; error?: string };
	try {
		data = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	await db
		.update(workQueue)
		.set({
			status: data.status,
		})
		.where(eq(workQueue.id, data.id));

	return NextResponse.json({ ok: true });
}
