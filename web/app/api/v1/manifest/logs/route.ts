export const dynamic = "force-dynamic";

import { z } from "zod";
import { requireRequestRole } from "@/lib/api-auth";
import { getManifestStatus } from "@/lib/cli-service";
import { isLogCursor } from "@/lib/log-query";
import { slugify } from "@/lib/utils";
import { isLoggingEnabled, queryLogsByService } from "@/lib/victoria-logs";

const querySchema = z.object({
	project: z.string().trim().min(1),
	environment: z.string().trim().min(1),
	service: z.string().trim().min(1),
	after: z
		.string()
		.trim()
		.min(1)
		.refine(isLogCursor, { message: "Invalid log cursor" })
		.optional(),
	tail: z.coerce.number().int().min(1).max(1000).default(100),
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
		after: searchParams.get("after") ?? undefined,
		tail: searchParams.get("tail") ?? undefined,
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

	if (!isLoggingEnabled()) {
		return Response.json({ loggingEnabled: false, logs: [] });
	}

	try {
		const result = await queryLogsByService({
			serviceId: status.service.id,
			limit: parsed.data.tail,
			after: parsed.data.after,
			logType: "container",
		});

		const logs = result.logs
			.map((log) => ({
				deploymentId: log.deployment_id,
				stream: log.stream || "stdout",
				message: log._msg,
				timestamp: log._time,
			}))
			.reverse();

		return Response.json({ loggingEnabled: true, logs });
	} catch (error) {
		console.error("[logs:manifest] failed to query logs:", error);
		return Response.json({ loggingEnabled: true, logs: [] });
	}
}
