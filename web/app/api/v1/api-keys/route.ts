import { z } from "zod";
import { requireRequestRole } from "@/lib/api-auth";
import { auth as betterAuth } from "@/lib/auth";
import { apiError, badRequest } from "@/lib/public-api";

const schema = z.strictObject({
	name: z.string().trim().min(1).max(32),
	metadata: z.record(z.string(), z.unknown()).optional(),
});
export async function POST(request: Request) {
	if (request.headers.has("x-api-key"))
		return apiError(
			"API keys cannot create API keys",
			"API_KEY_AUTH_FORBIDDEN",
			403,
		);
	const session = await requireRequestRole(request, [
		"admin",
		"developer",
		"reader",
	]);
	if (!session.ok) return session.response;
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return badRequest(parsed.error.issues[0]?.message ?? "Invalid request");
	try {
		const key = await betterAuth.api.createApiKey({
			headers: request.headers,
			body: parsed.data,
		});
		return Response.json(
			{ apiKey: key.key, keyId: key.id, name: key.name },
			{ status: 201 },
		);
	} catch (error) {
		console.error("[public-api] API key creation failed", error);
		return apiError("Failed to create API key", "API_KEY_CREATE_FAILED", 500);
	}
}
