export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireRequestRole } from "@/lib/api-auth";
import { getManifestStatus } from "@/lib/cli-service";
import { slugify } from "@/lib/utils";

const querySchema = z.object({
	project: z.string().trim().min(1),
	environment: z.string().trim().min(1),
	service: z.string().trim().min(1),
});

export async function GET(request: Request) {
	const sessionResult = await requireRequestRole(request, [
		"admin",
		"developer",
		"reader",
	]);
	if (!sessionResult.ok) {
		return sessionResult.response;
	}

	const { searchParams } = new URL(request.url);
	const parsed = querySchema.safeParse({
		project: searchParams.get("project"),
		environment: searchParams.get("environment"),
		service: searchParams.get("service"),
	});

	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.issues[0]?.message || "Invalid request" },
			{ status: 400 },
		);
	}

	const status = await getManifestStatus({
		project: slugify(parsed.data.project),
		environment: parsed.data.environment,
		service: parsed.data.service,
	});

	if (!status) {
		return Response.json({ error: "Service not found" }, { status: 404 });
	}

	return Response.json(status);
}
