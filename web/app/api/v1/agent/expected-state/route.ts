import { type NextRequest, NextResponse } from "next/server";
import { buildAgentExpectedState, getServer } from "@/lib/agent/expected-state";
import { verifyAgentRequest } from "@/lib/agent-auth";
import {
	getAgentCompatibilityStatus,
	SERVICE_REVISION_CAPABILITY,
} from "@/lib/agent-capabilities";

export async function GET(request: NextRequest) {
	const auth = await verifyAgentRequest(request);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	const server = await getServer(auth.serverId);
	if (!server) {
		return NextResponse.json({ error: "Server not found" }, { status: 404 });
	}
	if (process.env.EXPECTED_STATE_MAINTENANCE_MODE === "true") {
		return NextResponse.json(
			{
				error: "Expected state is paused for maintenance",
				code: "EXPECTED_STATE_MAINTENANCE",
			},
			{
				status: 503,
				headers: { "Retry-After": "30" },
			},
		);
	}
	if (getAgentCompatibilityStatus(server.agentHealth) === "upgrade_required") {
		return NextResponse.json(
			{
				error: "Agent upgrade required",
				code: "AGENT_UPGRADE_REQUIRED",
				requiredCapabilities: [SERVICE_REVISION_CAPABILITY],
			},
			{ status: 426 },
		);
	}

	try {
		return NextResponse.json(await buildAgentExpectedState(server));
	} catch (error) {
		console.error(
			`[expected-state] failed to build state for server ${server.id}:`,
			error,
		);
		return NextResponse.json(
			{
				error: "Expected state is temporarily unavailable",
				code: "EXPECTED_STATE_BUILD_FAILED",
			},
			{
				status: 503,
				headers: { "Retry-After": "15" },
			},
		);
	}
}
