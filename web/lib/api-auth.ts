import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import type { MemberRole } from "@/db/types";
import { auth } from "@/lib/auth";
import {
	AdminNotConfiguredError,
	getUserRole,
	hasAnyRole,
} from "@/lib/members";

type AuthenticatedIdentity = {
	user: { id: string; name: string; email: string };
	session: { id: string; expiresAt: Date };
};

type SessionResult =
	| { ok: true; session: AuthenticatedIdentity }
	| { ok: false; response: Response };

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
			code:
				apiError.body?.code ??
				(apiError.statusCode === 401
					? "UNAUTHORIZED"
					: apiError.statusCode === 403
						? "FORBIDDEN"
						: apiError.statusCode === 429
							? "RATE_LIMITED"
							: "AUTH_ERROR"),
		},
		{ status: apiError.statusCode },
	);
}

function unauthorized() {
	return {
		ok: false as const,
		response: Response.json(
			{ message: "Unauthorized", code: "UNAUTHORIZED" },
			{ status: 401 },
		),
	};
}

function authProviderError(error: unknown) {
	console.error("[public-api] authentication failed", error);
	return {
		ok: false as const,
		response: Response.json(
			{
				message: "Authentication provider unavailable",
				code: "AUTH_PROVIDER_ERROR",
			},
			{ status: 500 },
		),
	};
}

export async function requireRequestSession(
	request: Request,
): Promise<SessionResult> {
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

		return authProviderError(error);
	}

	if (!session) {
		return unauthorized();
	}

	return {
		ok: true as const,
		session,
	};
}

/** Authenticate a canonical public API request using only X-API-Key. */
export async function requireApiKeySession(request: Request) {
	const apiKey = request.headers.get("x-api-key")?.trim();
	if (!apiKey) return unauthorized();

	try {
		const verification = await auth.api.verifyApiKey({
			body: { key: apiKey },
		});
		if (!verification.valid || !verification.key?.referenceId) {
			return unauthorized();
		}

		const principal = await db
			.select({
				id: user.id,
				name: user.name,
				email: user.email,
				banned: user.banned,
				banExpires: user.banExpires,
			})
			.from(user)
			.where(eq(user.id, verification.key.referenceId))
			.limit(1)
			.then((rows) => rows[0]);
		if (
			!principal ||
			(principal.banned &&
				(!principal.banExpires || principal.banExpires > new Date()))
		) {
			return unauthorized();
		}

		return {
			ok: true as const,
			session: {
				user: {
					id: principal.id,
					name: principal.name,
					email: principal.email,
				},
				session: {
					id: verification.key.id,
					expiresAt:
						verification.key.expiresAt ??
						new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
				},
			},
		};
	} catch (error) {
		const response = getAuthErrorResponse(error);
		if (response) {
			return response.status >= 400 &&
				response.status < 500 &&
				response.status !== 429
				? unauthorized()
				: { ok: false as const, response };
		}
		return authProviderError(error);
	}
}

async function requireSessionRole(
	sessionResult: SessionResult,
	allowedRoles: MemberRole[],
) {
	if (!sessionResult.ok) return sessionResult;

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

		console.error("[public-api] authorization lookup failed", error);
		return {
			ok: false as const,
			response: Response.json(
				{
					message: "Authorization provider unavailable",
					code: "AUTHORIZATION_ERROR",
				},
				{ status: 500 },
			),
		};
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

export async function requireRequestRole(
	request: Request,
	allowedRoles: MemberRole[],
) {
	return requireSessionRole(await requireRequestSession(request), allowedRoles);
}

export async function requireRequestDeveloperRole(request: Request) {
	return requireRequestRole(request, ["admin", "developer"]);
}

export async function requireApiKeyRole(
	request: Request,
	allowedRoles: MemberRole[],
) {
	return requireSessionRole(await requireApiKeySession(request), allowedRoles);
}

export async function requireApiKeyDeveloperRole(request: Request) {
	return requireApiKeyRole(request, ["admin", "developer"]);
}
