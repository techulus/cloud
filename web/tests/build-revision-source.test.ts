import { describe, expect, it, vi } from "vitest";
import { cloneUrlForRevisionSource } from "@/lib/build-revision-source";

const baseSource = {
	type: "github" as const,
	repository: "https://github.com/techulus/cloud",
	repositoryId: 123,
	branch: "main",
	commitSha: "0123456789abcdef0123456789abcdef01234567",
	rootDir: "web",
};

describe("revision-backed GitHub clone authentication", () => {
	it("uses the snapshotted GitHub App installation", async () => {
		const getToken = vi.fn().mockResolvedValue("installation-token");

		await expect(
			cloneUrlForRevisionSource(
				{
					...baseSource,
					authentication: { type: "github_app", installationId: 456 },
				},
				getToken,
			),
		).resolves.toBe(
			"https://x-access-token:installation-token@github.com/techulus/cloud.git",
		);
		expect(getToken).toHaveBeenCalledWith(456);
	});

	it("never falls back to an anonymous clone when App authentication fails", async () => {
		const getToken = vi.fn().mockRejectedValue(new Error("installation removed"));

		await expect(
			cloneUrlForRevisionSource(
				{
					...baseSource,
					authentication: { type: "github_app", installationId: 456 },
				},
				getToken,
			),
		).rejects.toThrow("installation removed");
		expect(getToken).toHaveBeenCalledTimes(1);
	});

	it("uses the snapshotted public repository only for anonymous sources", async () => {
		const getToken = vi.fn();

		await expect(
			cloneUrlForRevisionSource(
				{
					...baseSource,
					repositoryId: null,
					authentication: { type: "anonymous" },
				},
				getToken,
			),
		).resolves.toBe("https://github.com/techulus/cloud.git");
		expect(getToken).not.toHaveBeenCalled();
	});
});
