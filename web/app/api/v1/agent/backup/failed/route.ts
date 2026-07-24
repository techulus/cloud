import { type NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { completeLegacyVolumeWorkItem } from "@/lib/work-queue";

export async function POST(request: NextRequest) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const data = parsed as { backupId?: unknown; error?: unknown };

	if (
		typeof data.backupId !== "string" ||
		(data.error !== undefined && typeof data.error !== "string")
	) {
		return NextResponse.json(
			{ error: "Invalid backup failure payload" },
			{ status: 400 },
		);
	}

	const outcome = await completeLegacyVolumeWorkItem(
		auth.serverId,
		"backup_volume",
		data.backupId,
		{
			status: "failed",
			error: data.error || "Unknown error",
		},
	);

	if (outcome === "completed") return NextResponse.json({ ok: true });
	if (outcome === "pending") {
		return NextResponse.json(
			{ error: "Completion is pending" },
			{ status: 503 },
		);
	}
	if (outcome === "conflict") {
		return NextResponse.json(
			{ error: "Conflicting work item" },
			{ status: 409 },
		);
	}
	return NextResponse.json({ error: "Work item not found" }, { status: 404 });
}
