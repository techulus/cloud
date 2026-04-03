export const dynamic = "force-dynamic";

import { requireRequestSession } from "@/lib/api-auth";

export async function GET(request: Request) {
	const sessionResult = await requireRequestSession(request);
	if (!sessionResult.ok) {
		return sessionResult.response;
	}

	return Response.json({
		user: sessionResult.session.user,
		session: {
			id: sessionResult.session.session.id,
			expiresAt: sessionResult.session.session.expiresAt,
		},
	});
}
