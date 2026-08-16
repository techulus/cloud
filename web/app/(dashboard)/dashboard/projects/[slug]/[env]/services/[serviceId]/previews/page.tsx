import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { PreviewDeploymentsPage } from "@/components/service/preview-deployments-page";
import { db } from "@/db";
import { getService, getSetting } from "@/db/queries";
import { githubRepos } from "@/db/schema";
import { getGitHubPullRequest } from "@/lib/github";
import { listPreviewDeployments } from "@/lib/preview-deployments";
import { SETTING_KEYS } from "@/lib/settings-keys";

export default async function PreviewsPage({
	params,
}: {
	params: Promise<{ serviceId: string }>;
}) {
	const { serviceId } = await params;
	const [service, repo, automaticDomain, previews] = await Promise.all([
		getService(serviceId),
		db
			.select()
			.from(githubRepos)
			.where(eq(githubRepos.serviceId, serviceId))
			.then((rows) => rows[0]),
		getSetting<string>(SETTING_KEYS.AUTO_SUBDOMAIN_DOMAIN),
		listPreviewDeployments(serviceId),
	]);
	if (!service || service.sourceType !== "github" || !repo) notFound();

	const withPullRequests = await Promise.all(
		previews.map(async (preview) => {
			try {
				const pullRequest = await getGitHubPullRequest(
					repo.installationId,
					repo.repoFullName,
					preview.pullRequestNumber,
				);
				return {
					...preview,
					title: pullRequest.title,
					author: pullRequest.user.login,
				};
			} catch {
				return { ...preview, title: null, author: null };
			}
		}),
	);

	return (
		<PreviewDeploymentsPage
			serviceId={service.id}
			enabled={service.previewDeploymentsEnabled}
			stateful={service.stateful}
			automaticDomain={automaticDomain}
			repository={repo.repoFullName}
			previews={withPullRequests}
		/>
	);
}
