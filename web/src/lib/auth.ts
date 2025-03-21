import db from "@/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { member } from "@/db/schema";

export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
	}),
	socialProviders: {
		github: {
			clientId: process.env.GITHUB_CLIENT_ID as string,
			clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
		},
	},
	plugins: [organization(), nextCookies()],
	databaseHooks: {
		session: {
			create: {
				before: async (session) => {
					const memberships = await db.query.member.findMany({
						where: eq(member.userId, session.userId),
					});
					return {
						data: {
							...session,
							activeOrganizationId:
								memberships.length > 0 ? memberships[0].organizationId : null,
						},
					};
				},
			},
		},
	},
});
