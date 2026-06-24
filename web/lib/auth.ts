import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { headers } from "next/headers";
import { db } from "@/db";
import * as schema from "@/db/schema";

const TECHULUS_CLI_CLIENT_ID = "techulus-cli";

export const auth = betterAuth({
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
