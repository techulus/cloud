import { auth } from "@/lib/auth";

export async function getRequestSession(request: Request) {
	return auth.api.getSession({
		headers: request.headers,
	});
}

export async function requireRequestSession(request: Request) {
	const session = await getRequestSession(request);

	if (!session) {
		return {
			ok: false as const,
			response: Response.json({ error: "Unauthorized" }, { status: 401 }),
		};
	}

	return {
		ok: true as const,
		session,
	};
}
