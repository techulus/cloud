import { type NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { completeLegacyVolumeWorkItem } from "@/lib/work-queue";

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

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
	const data = parsed as {
		backupId?: unknown;
		sizeBytes?: unknown;
		checksum?: unknown;
	};

	if (
		typeof data.backupId !== "string" ||
		!Number.isSafeInteger(data.sizeBytes) ||
		(data.sizeBytes as number) < 0 ||
		typeof data.checksum !== "string" ||
		!SHA256_PATTERN.test(data.checksum)
	) {
		return NextResponse.json(
			{ error: "Invalid backup completion payload" },
			{ status: 400 },
		);
	}

	const outcome = await completeLegacyVolumeWorkItem(
		auth.serverId,
		"backup_volume",
		data.backupId,
		{
			status: "completed",
			output: {
				sizeBytes: data.sizeBytes as number,
				checksum: data.checksum,
			},
		},
	);

	return legacyCompletionResponse(outcome);
}

function legacyCompletionResponse(
	outcome: "completed" | "pending" | "conflict" | "not_found",
) {
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
