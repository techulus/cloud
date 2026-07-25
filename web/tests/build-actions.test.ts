import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const queryResult = {
		service: {
			id: "service-1",
			sourceType: "github",
		},
		githubRepo: {
			id: "repo-link-1",
			installationId: 123,
			repoFullName: "techulus/cloud",
			deployBranch: "production",
			defaultBranch: "main",
		},
	};
	const query = {
		from: vi.fn(),
		innerJoin: vi.fn(),
		where: vi.fn(),
		// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
		then: (resolve: (value: unknown[]) => unknown) =>
			Promise.resolve([queryResult]).then(resolve),
	};
	query.from.mockReturnValue(query);
	query.innerJoin.mockReturnValue(query);
	query.where.mockReturnValue(query);

	return {
		db: { select: vi.fn(() => query) },
		requireDeveloperRole: vi.fn(),
		listGitHubCommits: vi.fn(),
		triggerResolvedBuildInternal: vi.fn(),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/auth", () => ({
	requireDeveloperRole: mocks.requireDeveloperRole,
}));
vi.mock("@/lib/github", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/github")>()),
	listGitHubCommits: mocks.listGitHubCommits,
}));
vi.mock("@/lib/inngest/client", () => ({
	inngest: { send: vi.fn() },
}));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		buildTrigger: { create: vi.fn() },
	},
}));
vi.mock("@/lib/trigger-build", () => ({
	triggerResolvedBuildInternal: mocks.triggerResolvedBuildInternal,
}));

import { triggerManualBuild } from "@/actions/builds";

const selectedCommit = {
	sha: "0123456789abcdef0123456789abcdef01234567",
	message: "Deploy this commit",
	author: "octocat",
};

describe("manual commit builds", () => {
	beforeEach(() => {
		mocks.db.select.mockClear();
		mocks.requireDeveloperRole.mockReset();
		mocks.requireDeveloperRole.mockResolvedValue({
			user: { id: "user-1", name: "Alice" },
		});
		mocks.listGitHubCommits.mockReset();
		mocks.triggerResolvedBuildInternal.mockReset();
		mocks.triggerResolvedBuildInternal.mockResolvedValue({ status: "queued" });
	});

	it("queues a commit from the latest 50 on the deploy branch", async () => {
		mocks.listGitHubCommits.mockResolvedValue([selectedCommit]);

		await expect(
			triggerManualBuild("service-1", selectedCommit.sha),
		).resolves.toEqual({ success: true });

		expect(mocks.listGitHubCommits).toHaveBeenCalledWith(
			123,
			"techulus/cloud",
			"production",
		);
		expect(mocks.triggerResolvedBuildInternal).toHaveBeenCalledWith(
			"service-1",
			{
				trigger: "manual",
				commitSha: selectedCommit.sha,
				commitMessage: selectedCommit.message,
				author: "octocat",
				expectedRepository: "https://github.com/techulus/cloud",
				expectedBranch: "production",
				actor: { type: "user", userId: "user-1", name: "Alice" },
			},
		);
	});

	it("rejects a commit outside the latest 50 without queueing a build", async () => {
		mocks.listGitHubCommits.mockResolvedValue([]);

		await expect(
			triggerManualBuild("service-1", selectedCommit.sha),
		).rejects.toThrow(
			"Selected commit is no longer among the latest 50 commits on the source branch",
		);
		expect(mocks.triggerResolvedBuildInternal).not.toHaveBeenCalled();
	});

	it("rejects an unsafe SHA before querying the service", async () => {
		await expect(
			triggerManualBuild("service-1", "--upload-pack=/tmp/exploit"),
		).rejects.toThrow("Commit SHA must be a full 40-character hexadecimal SHA");
		expect(mocks.db.select).not.toHaveBeenCalled();
		expect(mocks.listGitHubCommits).not.toHaveBeenCalled();
		expect(mocks.triggerResolvedBuildInternal).not.toHaveBeenCalled();
	});
});
