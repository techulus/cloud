import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { workQueue } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";

const MAX_TIMEOUT = 30000;
const POLL_INTERVAL = 2000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: NextRequest) {
	const auth = await verifyAgentRequest(request);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	const { serverId } = auth;
	const rawTimeout = request.nextUrl.searchParams.get("timeout");
	const timeout = rawTimeout
		? Math.min(Math.max(0, parseInt(rawTimeout, 10) || 0), MAX_TIMEOUT)
		: MAX_TIMEOUT;

	const startTime = Date.now();

	console.log(
		`[work-queue] long poll started for server=${serverId} timeout=${timeout}ms`,
	);

	while (true) {
		if (request.signal.aborted) {
			console.log(`[work-queue] request aborted for server=${serverId}`);
			return NextResponse.json({ items: [] });
		}

		const items = await db
			.select()
			.from(workQueue)
			.where(
				and(eq(workQueue.serverId, serverId), eq(workQueue.status, "pending")),
			);

		if (items.length > 0) {
			await db
				.update(workQueue)
				.set({ status: "processing", startedAt: new Date() })
				.where(
					inArray(
						workQueue.id,
						items.map((i) => i.id),
					),
				);

			console.log(
				`[work-queue] found ${items.length} items for server=${serverId}`,
			);
			return NextResponse.json({ items });
		}

		if (Date.now() - startTime >= timeout) {
			console.log(`[work-queue] timeout elapsed for server=${serverId}`);
			return NextResponse.json({ items: [] });
		}

		await sleep(POLL_INTERVAL);
	}
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

	const { serverId } = auth;

	const result = await db
		.update(workQueue)
		.set({
			status: data.status,
		})
		.where(and(eq(workQueue.id, data.id), eq(workQueue.serverId, serverId)))
		.returning();

	if (result.length === 0) {
		return NextResponse.json(
			{ error: "Work queue item not found" },
			{ status: 404 },
		);
	}

	return NextResponse.json({ ok: true });
}
