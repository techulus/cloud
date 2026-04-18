export const dynamic = "force-dynamic";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireRequestSession } from "@/lib/api-auth";

const exchangeSchema = z
	.object({
		machineName: z.string().trim().min(1).max(128).optional(),
		platform: z.string().trim().min(1).max(128).optional(),
		cliVersion: z.string().trim().min(1).max(64).optional(),
	})
	.strict();

export async function POST(request: Request) {
	const sessionResult = await requireRequestSession(request);
	if (!sessionResult.ok) {
		return sessionResult.response;
	}

	const body = await request.json().catch(() => ({}));
	const parsed = exchangeSchema.safeParse(body);

	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.issues[0]?.message || "Invalid request" },
			{ status: 400 },
		);
	}

	const metadata = {
		creationSource: "techulus-cli",
		machineName: parsed.data.machineName ?? null,
		platform: parsed.data.platform ?? null,
		cliVersion: parsed.data.cliVersion ?? null,
		host: new URL(request.url).origin,
	};

	const name = parsed.data.machineName
		? `CLI - ${parsed.data.machineName}`.slice(0, 32)
		: "CLI";

	const apiKey = await auth.api.createApiKey({
		headers: request.headers,
		body: {
			name,
			metadata,
		},
	});

	return Response.json({
		apiKey: apiKey.key,
		keyId: apiKey.id,
		name: apiKey.name,
		user: sessionResult.session.user,
	});
}
