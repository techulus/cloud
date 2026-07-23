import { requireApiKeyRole } from "@/lib/api-auth";
import {
	apiError,
	findNestedService,
	notFound,
	resolvePersistedSource,
} from "@/lib/public-api";
export async function GET(
	request: Request,
	{
		params,
	}: {
		params: Promise<{
			projectId: string;
			environmentId: string;
			serviceId: string;
		}>;
	},
) {
	const auth = await requireApiKeyRole(request, [
		"admin",
		"developer",
		"reader",
	]);
	if (!auth.ok) return auth.response;
	try {
		const p = await params;
		const service = await findNestedService(
			p.projectId,
			p.environmentId,
			p.serviceId,
		);
		if (!service) return notFound();
		return Response.json({
			service: {
				id: service.id,
				name: service.name,
				hostname: service.hostname,
				source: await resolvePersistedSource(service),
				createdAt: service.createdAt,
			},
		});
	} catch (error) {
		console.error("[public-api] read service failed", error);
		return apiError("Internal server error", "INTERNAL_ERROR", 500);
	}
}
