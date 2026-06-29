import type { MemberRole } from "@/db/types";
import { auth } from "@/lib/auth";
import {
	AdminNotConfiguredError,
	getUserRole,
	hasAnyRole,
} from "@/lib/members";

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

export async function requireRequestSession(request: Request) {
	let session: Awaited<ReturnType<typeof auth.api.getSession>>;

	try {
		session = await auth.api.getSession({
			headers: request.headers,
		});
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

export async function requireRequestRole(
	request: Request,
	allowedRoles: MemberRole[],
) {
	const sessionResult = await requireRequestSession(request);
	if (!sessionResult.ok) {
		return sessionResult;
	}

	let role: MemberRole | null;
	try {
		role = await getUserRole(sessionResult.session.user.id);
	} catch (error) {
		if (error instanceof AdminNotConfiguredError) {
			return {
				ok: false as const,
				response: Response.json(
					{ message: error.message, code: error.code },
					{ status: 503 },
				),
			};
		}

		throw error;
	}

	if (!role || !hasAnyRole(role, allowedRoles)) {
		return {
			ok: false as const,
			response: Response.json(
				{ message: "Forbidden", code: "FORBIDDEN" },
				{ status: 403 },
			),
		};
	}

	return {
		ok: true as const,
		session: {
			...sessionResult.session,
			user: { ...sessionResult.session.user, role },
		},
	};
}

export async function requireRequestDeveloperRole(request: Request) {
	return requireRequestRole(request, ["admin", "developer"]);
}

export async function requireRequestAdminRole(request: Request) {
	return requireRequestRole(request, ["admin"]);
}
