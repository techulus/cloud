import { afterEach, describe, expect, it, vi } from "vitest";
import { isFullCommitSha, resolveGitHubCommit } from "@/lib/github";

afterEach(() => {
	vi.unstubAllGlobals();
});

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
