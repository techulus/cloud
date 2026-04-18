export const dynamic = "force-dynamic";

import { techulusManifestSchema } from "@/lib/cli-manifest";
import { deployManifest } from "@/lib/cli-service";
import { requireRequestSession } from "@/lib/api-auth";

export async function POST(request: Request) {
	const sessionResult = await requireRequestSession(request);
	if (!sessionResult.ok) {
		return sessionResult.response;
	}

	const body = await request.json().catch(() => null);
	const parsed = techulusManifestSchema.safeParse(body);

	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.issues[0]?.message || "Invalid manifest" },
			{ status: 400 },
		);
	}

	try {
		const result = await deployManifest(parsed.data);
		return Response.json(result);
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Failed to deploy manifest" },
			{ status: 400 },
		);
	}
}
