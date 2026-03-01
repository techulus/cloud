import { createHmac, createPrivateKey, timingSafeEqual } from "node:crypto";
import { SignJWT } from "jose";

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
		throw new Error(`Failed to get installation token: ${error}`);
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

type DeploymentState =
	| "pending"
	| "in_progress"
	| "success"
	| "failure"
	| "error";

export async function createGitHubDeployment(
	installationId: number,
	repoFullName: string,
	ref: string,
	environment: string,
	description: string,
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
				auto_merge: false,
				required_contexts: [],
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
