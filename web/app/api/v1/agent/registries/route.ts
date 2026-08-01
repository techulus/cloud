import { type NextRequest, NextResponse } from "next/server";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { getRegistryBundle } from "@/lib/registry-credentials";

const PRIVATE_HEADERS = {
	"Cache-Control": "private, no-store",
	Pragma: "no-cache",
};

export async function GET(request: NextRequest) {
	const auth = await verifyAgentRequest(request);
	if (!auth.success)
		return NextResponse.json(
			{ error: auth.error },
			{ status: auth.status, headers: PRIVATE_HEADERS },
		);
	try {
		return NextResponse.json(await getRegistryBundle(), {
			headers: PRIVATE_HEADERS,
		});
	} catch (error) {
		console.error("Registry bundle error:", error);
		return NextResponse.json(
			{ error: "Registry credentials unavailable" },
			{ status: 503, headers: PRIVATE_HEADERS },
		);
	}
}
