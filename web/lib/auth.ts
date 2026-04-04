import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey, bearer, deviceAuthorization } from "better-auth/plugins";
import { db } from "@/db";
import * as schema from "@/db/schema";

export const TECHULUS_CLI_CLIENT_ID = "techulus-cli";

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
			verificationUri: "/device",
			validateClient: async (clientId) => clientId === TECHULUS_CLI_CLIENT_ID,
		}),
		apiKey({
			enableSessionForAPIKeys: true,
			apiKeyHeaders: "x-api-key",
			defaultPrefix: "tcl_",
			enableMetadata: true,
			requireName: true,
		}),
		bearer(),
	],
});
