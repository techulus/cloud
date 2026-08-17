import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	findGitHubDeployment,
	isFullCommitSha,
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
	it("finds a deployment created for the same preview revision", async () => {
		configureGitHubApp();
		const fetchMock = vi.fn(
			async (input: string | URL | Request, _init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/access_tokens")) {
					return Response.json({ token: "installation-token" });
				}
				return Response.json([
					{
						id: 101,
						payload: {
							previewServiceId: "preview-1",
							serviceRevisionId: "revision-1",
						},
					},
				]);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			findGitHubDeployment(
				10,
				"acme/app",
				"0123456789abcdef0123456789abcdef01234567",
				"preview/app/pr-42",
				{
					previewServiceId: "preview-1",
					serviceRevisionId: "revision-1",
				},
			),
		).resolves.toBe(101);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"https://api.github.com/repos/acme/app/deployments?sha=0123456789abcdef0123456789abcdef01234567&environment=preview%2Fapp%2Fpr-42&per_page=100",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer installation-token",
				}),
			}),
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
});
