import { NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { applyStatusReport, type StatusReport } from "@/lib/agent-status";

export async function POST(request: NextRequest) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	let data: { statusReport?: StatusReport };
	try {
		data = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (!data.statusReport || !Array.isArray(data.statusReport.containers)) {
		return NextResponse.json(
			{ error: "Invalid statusReport payload" },
			{ status: 400 },
		);
	}

	const { serverId } = auth;

	await applyStatusReport(serverId, data.statusReport);

	return NextResponse.json({ ok: true });
}
