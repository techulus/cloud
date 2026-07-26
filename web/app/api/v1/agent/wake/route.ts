import { type NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { waitForAgentGeneration } from "@/lib/agent-wake";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	const auth = await verifyAgentRequest(request);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	const rawGeneration = request.nextUrl.searchParams.get("generation");
	if (!rawGeneration || !/^(0|[1-9]\d*)$/.test(rawGeneration)) {
		return NextResponse.json(
			{ error: "Invalid generation cursor" },
			{ status: 400 },
		);
	}
	const generation = Number(rawGeneration);
	if (!Number.isSafeInteger(generation)) {
		return NextResponse.json(
			{ error: "Invalid generation cursor" },
			{ status: 400 },
		);
	}

	const result = await waitForAgentGeneration(
		auth.serverId,
		generation,
		request.signal,
	);
	switch (result.kind) {
		case "advanced":
			return NextResponse.json({ generation: result.generation });
		case "timeout":
		case "aborted":
			return new NextResponse(null, { status: 204 });
		case "duplicate":
			return NextResponse.json(
				{ error: "A wake poll is already active for this server" },
				{ status: 409 },
			);
		case "capacity":
			return NextResponse.json(
				{ error: "Wake poll capacity reached" },
				{ status: 429 },
			);
		case "not-found":
			return NextResponse.json({ error: "Server not found" }, { status: 404 });
	}
}
