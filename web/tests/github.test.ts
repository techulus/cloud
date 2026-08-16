import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createGitHubDeployment,
	isFullCommitSha,
	listOpenGitHubPullRequests,
	resolveGitHubCommit,
	resolveGitHubPullRequestMergeRef,
} from "@/lib/github";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function configureGitHubApp() {
	const { privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	vi.stubEnv("GITHUB_APP_ID", "123");
	vi.stubEnv(
		"GITHUB_APP_PRIVATE_KEY",
		Buffer.from(privateKey).toString("base64"),
	);
}

function pullRequest(number: number) {
	return {
		number,
		state: "open",
		draft: false,
		merged: false,
		title: `PR ${number}`,
		updated_at: "2026-08-16T00:00:00Z",
		user: { id: number, login: `user-${number}` },
		base: { ref: "main", repo: { id: 1, full_name: "acme/app" } },
		head: {
			sha: number.toString(16).padStart(40, "0"),
			repo: { id: 1, full_name: "acme/app" },
		},
	};
}

describe("GitHub commit SHA validation", () => {
	it("accepts only full hexadecimal commit SHAs", () => {
		expect(isFullCommitSha("0123456789abcdef0123456789abcdef01234567")).toBe(
			true,
		);
		expect(isFullCommitSha("0123456789ABCDEF0123456789ABCDEF01234567")).toBe(
			true,
		);
		expect(isFullCommitSha("0123456")).toBe(false);
		expect(isFullCommitSha("--upload-pack=/tmp/exploit")).toBe(false);
		expect(isFullCommitSha("g123456789abcdef0123456789abcdef01234567")).toBe(
			false,
		);
	});
});

describe("public GitHub branch resolution", () => {
	it("resolves a branch to one exact immutable commit", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify([
					{
						sha: "0123456789ABCDEF0123456789ABCDEF01234567",
						author: { login: "octocat" },
						commit: {
							message: "Ship it",
							author: {
								name: "Octo Cat",
								date: "2026-07-20T00:00:00Z",
							},
						},
					},
				]),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			resolveGitHubCommit("techulus/cloud", "feature/public api"),
		).resolves.toMatchObject({
			sha: "0123456789ABCDEF0123456789ABCDEF01234567",
			message: "Ship it",
			author: "octocat",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/techulus/cloud/commits?sha=feature%2Fpublic%20api&per_page=1",
			expect.objectContaining({
				headers: expect.not.objectContaining({
					Authorization: expect.anything(),
				}),
			}),
		);
	});
});

describe("GitHub pull request deployment helpers", () => {
	it("paginates all open pull requests targeting the configured branch", async () => {
		configureGitHubApp();
		const firstPage = Array.from({ length: 100 }, (_, index) =>
			pullRequest(index + 1),
		);
		const fetchMock = vi.fn(
			async (input: string | URL | Request, _init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/access_tokens")) {
					return Response.json({ token: "installation-token" });
				}
				const page = new URL(url).searchParams.get("page");
				if (page === "1") return Response.json(firstPage);
				if (page === "2") return Response.json([pullRequest(101)]);
				throw new Error(`Unexpected GitHub request: ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			listOpenGitHubPullRequests(10, "acme/app", "main"),
		).resolves.toHaveLength(101);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/acme/app/pulls?state=open&base=main&per_page=100&page=2",
			expect.any(Object),
		);
	});

	it("fails when the synthetic merge ref is unavailable without using the PR head", async () => {
		configureGitHubApp();
		const fetchMock = vi.fn(
			async (input: string | URL | Request, _init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/access_tokens")) {
					return Response.json({ token: "installation-token" });
				}
				return new Response("Not Found", { status: 404 });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			resolveGitHubPullRequestMergeRef(10, "acme/app", 42),
		).rejects.toThrow("refs/pull/42/merge is unavailable");
		const commitRequests = fetchMock.mock.calls
			.map(([input]) => String(input))
			.filter((url) => url.includes("/commits"));
		expect(commitRequests).toEqual([
			"https://api.github.com/repos/acme/app/commits?sha=refs%2Fpull%2F42%2Fmerge&per_page=1",
		]);
	});

	it("creates a transient non-production GitHub deployment", async () => {
		configureGitHubApp();
		const fetchMock = vi.fn(
			async (input: string | URL | Request, _init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/access_tokens")) {
					return Response.json({ token: "installation-token" });
				}
				return Response.json({ id: 99 });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			createGitHubDeployment(
				10,
				"acme/app",
				"a".repeat(40),
				"preview/web/pr-42",
				"Preview PR #42",
				{
					transientEnvironment: true,
					productionEnvironment: false,
					payload: { pullRequestNumber: 42 },
				},
			),
		).resolves.toBe(99);

		const deploymentCall = fetchMock.mock.calls.find(([input]) =>
			String(input).endsWith("/repos/acme/app/deployments"),
		);
		expect(deploymentCall).toBeDefined();
		const body = JSON.parse(
			(deploymentCall?.[1] as RequestInit | undefined)?.body as string,
		);
		expect(body).toMatchObject({
			ref: "a".repeat(40),
			environment: "preview/web/pr-42",
			transient_environment: true,
			production_environment: false,
			payload: { pullRequestNumber: 42 },
			auto_merge: false,
			required_contexts: [],
		});
	});
});
