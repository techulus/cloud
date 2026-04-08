export const dynamic = "force-dynamic";

import { requireRequestSession } from "@/lib/api-auth";
import { listLinkTargets } from "@/lib/cli-service";

export async function GET(request: Request) {
	const sessionResult = await requireRequestSession(request);
	if (!sessionResult.ok) {
		return sessionResult.response;
	}

	try {
		const result = await listLinkTargets();
		return Response.json(result);
	} catch (error) {
		console.error("Failed to list link targets", error);
		return Response.json(
			{ error: "Failed to list link targets" },
			{ status: 500 },
		);
	}
}
