import { createHmac, createPrivateKey, timingSafeEqual } from "node:crypto";
import { SignJWT } from "jose";
import { pullRequestMergeRef } from "@/lib/service-revision-spec";

export class GitHubApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "GitHubApiError";
	}
}

function getAppId(): string {
	const appId = process.env.GITHUB_APP_ID;
	if (!appId) {
		throw new Error("GITHUB_APP_ID is required");
	}
	return appId;
}

function getPrivateKey(): string {
	const key = process.env.GITHUB_APP_PRIVATE_KEY;
	if (!key) {
		throw new Error("GITHUB_APP_PRIVATE_KEY is required");
	}
	return Buffer.from(key, "base64").toString("utf-8");
}

function getWebhookSecret(): string {
	const secret = process.env.GITHUB_WEBHOOK_SECRET;
	if (!secret) {
		throw new Error("GITHUB_WEBHOOK_SECRET is required");
	}
	return secret;
}

export function verifyWebhookSignature(
	payload: string,
	signature: string | null,
): boolean {
	if (!signature) {
		return false;
	}

	const secret = getWebhookSecret();
	const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

	try {
		return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
	} catch {
		return false;
	}
}

async function generateAppJwt(): Promise<string> {
	const appId = getAppId();
	const privateKey = getPrivateKey();

	const key = createPrivateKey(privateKey);

	const now = Math.floor(Date.now() / 1000);
	const jwt = await new SignJWT({})
		.setProtectedHeader({ alg: "RS256" })
		.setIssuedAt(now - 60)
		.setExpirationTime(now + 600)
		.setIssuer(appId)
		.sign(key);

	return jwt;
}

export async function getInstallationToken(
	installationId: number,
): Promise<string> {
	const jwt = await generateAppJwt();

	const response = await fetch(
		`https://api.github.com/app/installations/${installationId}/access_tokens`,
		{
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${jwt}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);

	if (!response.ok) {
		const error = await response.text();
		throw new GitHubApiError(
			`Failed to get installation token: ${error}`,
			response.status,
		);
	}

	const data = await response.json();
	return data.token;
}

export async function getInstallationRepositories(
	installationId: number,
): Promise<
	Array<{
		id: number;
		full_name: string;
		default_branch: string;
		private: boolean;
	}>
> {
	const token = await getInstallationToken(installationId);

	const response = await fetch(
		"https://api.github.com/installation/repositories?per_page=100",
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to get repositories: ${error}`);
	}

	const data = await response.json();
	return data.repositories;
}

export function buildCloneUrl(token: string, repoFullName: string): string {
	return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
}

function validateRepoFullName(repoFullName: string): void {
	if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repoFullName)) {
		throw new Error("Invalid repository name");
	}
}

export type GitHubCommit = {
	sha: string;
	message: string;
	author: string | null;
	date: string;
};

export type GitHubPullRequest = {
	number: number;
	state: "open" | "closed";
	draft: boolean;
	merged: boolean;
	title: string;
	updatedAt: string;
	user: { id: number; login: string };
	base: {
		ref: string;
		repository: { id: number; fullName: string };
	};
	head: {
		sha: string;
		repository: { id: number; fullName: string } | null;
	};
};

export function isFullCommitSha(value: string): boolean {
	return /^[0-9a-f]{40}$/i.test(value);
}

type GitHubCommitResponse = {
	sha: string;
	author: { login: string } | null;
	commit: {
		message: string;
		author: { name: string; date: string } | null;
	};
};

function mapGitHubCommit(commit: GitHubCommitResponse): GitHubCommit {
	return {
		sha: commit.sha,
		message: commit.commit.message,
		author: commit.author?.login ?? commit.commit.author?.name ?? null,
		date: commit.commit.author?.date ?? "",
	};
}

async function githubCommitRequest<T>(
	installationId: number,
	repoFullName: string,
	suffix: string,
): Promise<T> {
	validateRepoFullName(repoFullName);
	if (!Number.isSafeInteger(installationId) || installationId <= 0) {
		throw new Error("Invalid GitHub installation ID");
	}

	const token = await getInstallationToken(installationId);
	const response = await fetch(
		`https://api.github.com/repos/${repoFullName}/commits${suffix}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(
			`GitHub commit request failed (${response.status}): ${detail || response.statusText}`,
		);
	}
	return response.json() as Promise<T>;
}

async function publicGitHubCommitRequest<T>(
	repoFullName: string,
	suffix: string,
): Promise<T> {
	validateRepoFullName(repoFullName);
	const response = await fetch(
		`https://api.github.com/repos/${repoFullName}/commits${suffix}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(
			`Public GitHub commit request failed (${response.status}): ${detail || response.statusText}`,
		);
	}
	return response.json() as Promise<T>;
}

export async function resolveGitHubCommit(
	repoFullName: string,
	branch: string,
	installationId?: number,
): Promise<GitHubCommit> {
	const ref = branch.trim();
	if (!ref) throw new Error("GitHub branch is not configured");
	const suffix = `?sha=${encodeURIComponent(ref)}&per_page=1`;
	const commits = installationId
		? await githubCommitRequest<GitHubCommitResponse[]>(
				installationId,
				repoFullName,
				suffix,
			)
		: await publicGitHubCommitRequest<GitHubCommitResponse[]>(
				repoFullName,
				suffix,
			);
	const commit = commits[0];
	if (!commit || !isFullCommitSha(commit.sha)) {
		throw new Error("GitHub branch did not resolve to an exact commit");
	}
	return mapGitHubCommit(commit);
}

type GitHubPullRequestResponse = {
	number: number;
	state: string;
	draft?: boolean | null;
	merged?: boolean | null;
	title: string;
	updated_at: string;
	user: { id: number; login: string } | null;
	base: { ref: string; repo: { id: number; full_name: string } };
	head: { sha: string; repo: { id: number; full_name: string } | null };
};

function mapGitHubPullRequest(
	pullRequest: GitHubPullRequestResponse,
): GitHubPullRequest {
	if (
		!pullRequest.user ||
		(pullRequest.state !== "open" && pullRequest.state !== "closed")
	) {
		throw new Error("GitHub returned an invalid pull request");
	}
	return {
		number: pullRequest.number,
		state: pullRequest.state,
		draft: pullRequest.draft === true,
		merged: pullRequest.merged === true,
		title: pullRequest.title,
		updatedAt: pullRequest.updated_at,
		user: { id: pullRequest.user.id, login: pullRequest.user.login },
		base: {
			ref: pullRequest.base.ref,
			repository: {
				id: pullRequest.base.repo.id,
				fullName: pullRequest.base.repo.full_name,
			},
		},
		head: {
			sha: pullRequest.head.sha,
			repository: pullRequest.head.repo
				? {
						id: pullRequest.head.repo.id,
						fullName: pullRequest.head.repo.full_name,
					}
				: null,
		},
	};
}

async function githubPullRequestRequest<T>(
	installationId: number,
	repoFullName: string,
	suffix: string,
): Promise<T> {
	validateRepoFullName(repoFullName);
	if (!Number.isSafeInteger(installationId) || installationId <= 0) {
		throw new Error("Invalid GitHub installation ID");
	}
	const token = await getInstallationToken(installationId);
	const response = await fetch(
		`https://api.github.com/repos/${repoFullName}/pulls${suffix}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);
	if (!response.ok) {
		const detail = await response.text();
		throw new GitHubApiError(
			`GitHub pull request failed (${response.status}): ${detail || response.statusText}`,
			response.status,
		);
	}
	return response.json() as Promise<T>;
}

export async function getGitHubPullRequest(
	installationId: number,
	repoFullName: string,
	pullRequestNumber: number,
): Promise<GitHubPullRequest> {
	if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
		throw new Error("Invalid pull request number");
	}
	const pullRequest = await githubPullRequestRequest<GitHubPullRequestResponse>(
		installationId,
		repoFullName,
		`/${pullRequestNumber}`,
	);
	return mapGitHubPullRequest(pullRequest);
}

export async function upsertGitHubPullRequestComment(
	installationId: number,
	repoFullName: string,
	pullRequestNumber: number,
	marker: string,
	content: string,
): Promise<number> {
	validateRepoFullName(repoFullName);
	if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
		throw new Error("Invalid pull request number");
	}
	if (!/^<!-- [^\r\n]+ -->$/.test(marker)) {
		throw new Error("Invalid pull request comment marker");
	}
	const body = `${marker}\n${content.trim()}`;
	if (body.length > 65_536) {
		throw new Error("Pull request comment is too long");
	}

	const token = await getInstallationToken(installationId);
	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};
	let existingCommentId: number | null = null;
	for (let page = 1; ; page++) {
		const response = await fetch(
			`https://api.github.com/repos/${repoFullName}/issues/${pullRequestNumber}/comments?per_page=100&page=${page}`,
			{ headers },
		);
		if (!response.ok) {
			const detail = await response.text();
			throw new GitHubApiError(
				`Failed to list pull request comments (${response.status}): ${detail || response.statusText}`,
				response.status,
			);
		}
		const comments = (await response.json()) as unknown;
		if (!Array.isArray(comments)) {
			throw new Error("GitHub returned invalid pull request comments");
		}
		const existing = comments.find(
			(comment) =>
				comment !== null &&
				typeof comment === "object" &&
				"body" in comment &&
				typeof comment.body === "string" &&
				(comment.body === marker || comment.body.startsWith(`${marker}\n`)),
		) as { id?: unknown } | undefined;
		if (existing) {
			if (!Number.isSafeInteger(existing.id) || Number(existing.id) <= 0) {
				throw new Error("GitHub returned an invalid pull request comment ID");
			}
			existingCommentId = Number(existing.id);
			break;
		}
		if (comments.length < 100) break;
	}

	const response = await fetch(
		existingCommentId
			? `https://api.github.com/repos/${repoFullName}/issues/comments/${existingCommentId}`
			: `https://api.github.com/repos/${repoFullName}/issues/${pullRequestNumber}/comments`,
		{
			method: existingCommentId ? "PATCH" : "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ body }),
		},
	);
	if (!response.ok) {
		const detail = await response.text();
		throw new GitHubApiError(
			`Failed to ${existingCommentId ? "update" : "create"} pull request comment (${response.status}): ${detail || response.statusText}`,
			response.status,
		);
	}
	const comment = (await response.json()) as { id?: unknown };
	if (!Number.isSafeInteger(comment.id) || Number(comment.id) <= 0) {
		throw new Error("GitHub returned an invalid pull request comment ID");
	}
	return Number(comment.id);
}

export async function listOpenGitHubPullRequests(
	installationId: number,
	repoFullName: string,
	baseBranch: string,
): Promise<GitHubPullRequest[]> {
	if (!baseBranch.trim()) throw new Error("GitHub branch is not configured");
	const pullRequests: GitHubPullRequestResponse[] = [];
	for (let page = 1; ; page++) {
		const batch = await githubPullRequestRequest<GitHubPullRequestResponse[]>(
			installationId,
			repoFullName,
			`?state=open&base=${encodeURIComponent(baseBranch)}&per_page=100&page=${page}`,
		);
		pullRequests.push(...batch);
		if (batch.length < 100) break;
	}
	return pullRequests.map(mapGitHubPullRequest);
}

export async function resolveGitHubPullRequestMergeRef(
	installationId: number,
	repoFullName: string,
	pullRequestNumber: number,
): Promise<{ gitRef: string; sha: string }> {
	const gitRef = pullRequestMergeRef(pullRequestNumber);
	try {
		const commits = await githubCommitRequest<GitHubCommitResponse[]>(
			installationId,
			repoFullName,
			`?sha=${encodeURIComponent(gitRef)}&per_page=1`,
		);
		const sha = commits[0]?.sha;
		if (!sha || !isFullCommitSha(sha)) {
			throw new Error("GitHub returned no merge commit");
		}
		return { gitRef, sha: sha.toLowerCase() };
	} catch (error) {
		throw new Error(
			`Merge ref ${gitRef} is unavailable; resolve merge conflicts and retry`,
			{ cause: error },
		);
	}
}

export async function listGitHubCommits(
	installationId: number,
	repoFullName: string,
	branch: string,
): Promise<GitHubCommit[]> {
	if (!branch.trim()) throw new Error("GitHub branch is not configured");
	const commits = await githubCommitRequest<GitHubCommitResponse[]>(
		installationId,
		repoFullName,
		`?sha=${encodeURIComponent(branch)}&per_page=50`,
	);
	return commits.map(mapGitHubCommit);
}

type DeploymentState =
	| "pending"
	| "in_progress"
	| "success"
	| "failure"
	| "error"
	| "inactive";

export async function findGitHubDeployment(
	installationId: number,
	repoFullName: string,
	commitSha: string,
	environment: string,
	expectedPayload: Record<string, unknown>,
): Promise<number | null> {
	validateRepoFullName(repoFullName);
	const token = await getInstallationToken(installationId);
	const parameters = new URLSearchParams({
		sha: commitSha,
		environment,
		per_page: "100",
	});
	const response = await fetch(
		`https://api.github.com/repos/${repoFullName}/deployments?${parameters}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);
	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to list deployments: ${error}`);
	}
	const deployments = (await response.json()) as Array<{
		id: number;
		payload: unknown;
	}>;
	for (const deployment of deployments) {
		let payload = deployment.payload;
		if (typeof payload === "string") {
			try {
				payload = JSON.parse(payload);
			} catch {
				continue;
			}
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			continue;
		}
		const payloadRecord = payload as Record<string, unknown>;
		if (
			Number.isSafeInteger(deployment.id) &&
			Object.entries(expectedPayload).every(
				([key, value]) =>
					Object.hasOwn(payloadRecord, key) && payloadRecord[key] === value,
			)
		) {
			return deployment.id;
		}
	}
	return null;
}

export async function createGitHubDeployment(
	installationId: number,
	repoFullName: string,
	ref: string,
	environment: string,
	description: string,
	options: {
		transientEnvironment?: boolean;
		productionEnvironment?: boolean;
		payload?: Record<string, unknown>;
	} = {},
): Promise<number> {
	validateRepoFullName(repoFullName);
	const token = await getInstallationToken(installationId);

	const response = await fetch(
		`https://api.github.com/repos/${repoFullName}/deployments`,
		{
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				ref,
				environment,
				description,
				payload: options.payload ?? {},
				auto_merge: false,
				required_contexts: [],
				transient_environment: options.transientEnvironment,
				production_environment: options.productionEnvironment,
			}),
		},
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to create deployment: ${error}`);
	}

	const data = await response.json();
	return data.id;
}

export async function updateGitHubDeploymentStatus(
	installationId: number,
	repoFullName: string,
	deploymentId: number,
	state: DeploymentState,
	options?: {
		description?: string;
		logUrl?: string;
		environmentUrl?: string;
	},
): Promise<void> {
	validateRepoFullName(repoFullName);
	const token = await getInstallationToken(installationId);

	const body: Record<string, unknown> = {
		state,
	};

	if (options?.description) {
		body.description = options.description;
	}

	if (options?.logUrl) {
		body.log_url = options.logUrl;
	}

	if (options?.environmentUrl) {
		body.environment_url = options.environmentUrl;
	}

	const response = await fetch(
		`https://api.github.com/repos/${repoFullName}/deployments/${deploymentId}/statuses`,
		{
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to update deployment status: ${error}`);
	}
}
