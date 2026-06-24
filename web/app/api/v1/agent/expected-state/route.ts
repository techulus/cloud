import { type NextRequest, NextResponse } from "next/server";
import {
	buildAgentExpectedState,
	getServer,
} from "@/lib/agent/expected-state";
import { verifyAgentRequest } from "@/lib/agent-auth";

export async function GET(request: NextRequest) {
	const auth = await verifyAgentRequest(request);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	const server = await getServer(auth.serverId);
	if (!server) {
		return NextResponse.json({ error: "Server not found" }, { status: 404 });
	}

	return NextResponse.json(await buildAgentExpectedState(server));
}
