import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { workQueue } from "@/db/schema";
import { verifyAgentRequest } from "@/lib/agent-auth";

const digestReference = /^.+@sha256:[0-9a-f]{64}$/;

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}
	let result: {
		attempt?: unknown;
		imageDigest?: unknown;
		durationMs?: unknown;
	};
	try {
		result = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (
		!Number.isInteger(result.attempt) ||
		(result.attempt as number) < 1 ||
		typeof result.imageDigest !== "string" ||
		!digestReference.test(result.imageDigest) ||
		!Number.isInteger(result.durationMs) ||
		(result.durationMs as number) < 0
	) {
		return NextResponse.json(
			{ error: "Invalid manifest result" },
			{ status: 400 },
		);
	}
	const { id } = await params;
	const updated = await db
		.update(workQueue)
		.set({
			resultImageUri: result.imageDigest,
			durationMs: result.durationMs as number,
		})
		.where(
			and(
				eq(workQueue.id, `manifest-work-${id}`),
				eq(workQueue.serverId, auth.serverId),
				eq(workQueue.type, "create_manifest"),
				eq(workQueue.status, "processing"),
				eq(workQueue.attempts, result.attempt as number),
			),
		)
		.returning({ id: workQueue.id });
	if (updated.length === 0) {
		return NextResponse.json(
			{ error: "Manifest work not found" },
			{ status: 404 },
		);
	}
	return NextResponse.json({ ok: true });
}
