export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireRequestSession } from "@/lib/api-auth";
import { exportManifestForLinkedService } from "@/lib/cli-service";

const bodySchema = z.object({
	serviceId: z.string().trim().min(1),
});

export async function POST(request: Request) {
	const sessionResult = await requireRequestSession(request);
	if (!sessionResult.ok) {
		return sessionResult.response;
	}

	const body = await request.json().catch(() => null);
	const parsed = bodySchema.safeParse(body);

	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.issues[0]?.message || "Invalid request" },
			{ status: 400 },
		);
	}

	try {
		const result = await exportManifestForLinkedService(parsed.data.serviceId);
		return Response.json(result);
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Failed to link service" },
			{ status: 400 },
		);
	}
}
