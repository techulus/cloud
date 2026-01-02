export const dynamic = "force-dynamic";

import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { db } from "@/db";
import { githubInstallations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getInstallationRepositories } from "@/lib/github";

export async function GET() {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const installations = await db
		.select()
		.from(githubInstallations)
		.where(eq(githubInstallations.userId, session.user.id));

	if (installations.length === 0) {
		return Response.json({ repos: [], installations: [] });
	}

	const allRepos: Array<{
		id: number;
		fullName: string;
		defaultBranch: string;
		private: boolean;
		installationId: number;
		accountLogin: string;
	}> = [];

	for (const installation of installations) {
		try {
			const repos = await getInstallationRepositories(installation.installationId);
			for (const repo of repos) {
				allRepos.push({
					id: repo.id,
					fullName: repo.full_name,
					defaultBranch: repo.default_branch,
					private: repo.private,
					installationId: installation.installationId,
					accountLogin: installation.accountLogin,
				});
			}
		} catch (error) {
			console.error(
				`[github:repos] failed to fetch repos for installation ${installation.installationId}:`,
				error
			);
		}
	}

	return Response.json({
		repos: allRepos,
		installations: installations.map((i) => ({
			id: i.installationId,
			accountLogin: i.accountLogin,
			accountType: i.accountType,
		})),
	});
}
