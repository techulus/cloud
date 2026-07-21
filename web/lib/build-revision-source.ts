import { buildCloneUrl, getInstallationToken } from "@/lib/github";
import type { ServiceRevisionSource } from "@/lib/service-revision-spec";

type GitHubRevisionSource = Extract<ServiceRevisionSource, { type: "github" }>;

export function revisionRepositoryFullName(repository: string): string {
	return new URL(repository).pathname.replace(/^\//, "").replace(/\.git$/i, "");
}

export async function cloneUrlForRevisionSource(
	source: GitHubRevisionSource,
	getToken: (installationId: number) => Promise<string> = getInstallationToken,
): Promise<string> {
	if (source.authentication.type === "github_app") {
		const token = await getToken(source.authentication.installationId);
		return buildCloneUrl(token, revisionRepositoryFullName(source.repository));
	}
	return source.repository.endsWith(".git")
		? source.repository
		: `${source.repository}.git`;
}
