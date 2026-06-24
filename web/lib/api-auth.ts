import { auth } from "@/lib/auth";

function getAuthErrorResponse(error: unknown) {
	if (!(error instanceof Error)) {
		return null;
	}

	const apiError = error as Error & {
		statusCode?: number;
		body?: { message?: string; code?: string };
	};
	if (!apiError.statusCode) {
		return null;
	}

	return Response.json(
		{
			message: apiError.body?.message ?? apiError.message,
			code: apiError.body?.code,
		},
		{ status: apiError.statusCode },
	);
}

async function getRequestSession(request: Request) {
	return auth.api.getSession({
		headers: request.headers,
	});
}

export async function requireRequestSession(request: Request) {
	let session: Awaited<ReturnType<typeof getRequestSession>>;

	try {
		session = await getRequestSession(request);
	} catch (error) {
		const response = getAuthErrorResponse(error);
		if (response) {
			return {
				ok: false as const,
				response,
			};
		}

		throw error;
	}

	if (!session) {
		return {
			ok: false as const,
			response: Response.json(
				{ message: "Unauthorized", code: "UNAUTHORIZED" },
				{ status: 401 },
			),
		};
	}

	return {
		ok: true as const,
		session,
	};
}
