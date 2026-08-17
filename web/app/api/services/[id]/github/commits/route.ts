import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { githubRepos, services } from "@/db/schema";
import { requireRequestDeveloperRole } from "@/lib/api-auth";
import { listGitHubCommits } from "@/lib/github";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const authResult = await requireRequestDeveloperRole(request);
	if (!authResult.ok) return authResult.response;

	const { id: serviceId } = await params;
	const [result] = await db
		.select({ service: services, githubRepo: githubRepos })
		.from(services)
		.innerJoin(githubRepos, eq(githubRepos.serviceId, services.id))
		.where(and(eq(services.id, serviceId), isNull(services.deletedAt)));

	if (!result) {
		return Response.json(
			{ message: "Active GitHub App-connected service not found" },
			{ status: 404 },
		);
	}
	if (result.service.sourceType !== "github") {
		return Response.json(
			{ message: "Service is not connected to GitHub" },
			{ status: 409 },
		);
	}

	const branch =
		result.githubRepo.deployBranch || result.githubRepo.defaultBranch || "main";
	try {
		const commits = await listGitHubCommits(
			result.githubRepo.installationId,
			result.githubRepo.repoFullName,
			branch,
		);
		return Response.json({ branch, commits });
	} catch (error) {
		return Response.json(
			{
				message:
					error instanceof Error
						? error.message
						: "Failed to load commits from GitHub",
			},
			{ status: 502 },
		);
	}
}
