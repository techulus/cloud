import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { isAPIError } from "better-auth/api";
import { bearer, deviceAuthorization, twoFactor } from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { userAc } from "better-auth/plugins/admin/access";
import { headers } from "next/headers";
import { db } from "@/db";
import * as schema from "@/db/schema";
import type { MemberRole } from "@/db/types";
import { getUserRole, hasAnyRole } from "@/lib/members";
import { type DeleteConfirmation, getDeleteTotpCode } from "@/lib/two-factor";

const TECHULUS_CLI_CLIENT_ID = "techulus-cli";
const APP_NAME = "Techulus Cloud";

export const auth = betterAuth({
	appName: APP_NAME,
	database: drizzleAdapter(db, {
		provider: "pg",
		schema,
	}),
	emailAndPassword: {
		enabled: true,
		disableSignUp: process.env.ALLOW_SIGNUP !== "true",
	},
	plugins: [
		deviceAuthorization({
			schema: {},
			verificationUri: "/device",
			validateClient: async (clientId) => clientId === TECHULUS_CLI_CLIENT_ID,
		}),
		apiKey({
			enableSessionForAPIKeys: true,
			apiKeyHeaders: "x-api-key",
			defaultPrefix: "tcl_",
			enableMetadata: true,
			requireName: true,
			rateLimit: {
				maxRequests: 10_000,
				timeWindow: 1000 * 60 * 60 * 24,
			},
		}),
		admin({
			defaultRole: "reader",
			adminRoles: ["admin"],
			roles: {
				admin: userAc,
				developer: userAc,
				reader: userAc,
			},
		}),
		twoFactor({
			issuer: APP_NAME,
		}),
		bearer(),
	],
});

export async function requireAuth() {
	let requestHeaders: Headers;

	try {
		requestHeaders = await headers();
	} catch {
		// Server actions are also reused by trusted background jobs where no
		// request context exists; browser-invoked actions still require a session.
		return null;
	}

	const session = await auth.api.getSession({
		headers: requestHeaders,
	});

	if (!session) {
		throw new Error("Unauthorized");
	}

	return session;
}

export async function requireRole(allowedRoles: MemberRole[]) {
	const session = await requireAuth();
	if (!session) {
		return null;
	}

	const role = await getUserRole(session.user.id);
	if (!role || !hasAnyRole(role, allowedRoles)) {
		throw new Error("Forbidden");
	}

	return { ...session, user: { ...session.user, role } };
}

export async function requireDeveloperRole() {
	return requireRole(["admin", "developer"]);
}

export async function verifyDeleteConfirmation(
	session: Awaited<ReturnType<typeof requireDeveloperRole>>,
	confirmation: DeleteConfirmation | undefined,
	resource: string,
) {
	if (!session) {
		throw new Error("Unauthorized");
	}

	const totpCode = getDeleteTotpCode(
		Boolean(
			(session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled,
		),
		confirmation,
		resource,
	);
	if (!totpCode) return;

	try {
		await auth.api.verifyTOTP({
			body: { code: totpCode },
			headers: await headers(),
		});
	} catch (error) {
		if (isAPIError(error)) {
			throw new Error("Invalid authenticator code");
		}
		throw error;
	}
}

export async function requireAdminRole() {
	return requireRole(["admin"]);
}
