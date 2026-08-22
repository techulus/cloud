import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => mocks);

import { reportOperationFailure, reportServerError } from "@/lib/server-errors";

describe("server error reporting", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reports caught exceptions with operation metadata", () => {
		const error = new Error("provider unavailable");

		reportServerError(error, "github.repositories.list", {
			tags: { installationId: "installation-1" },
			extra: { attempt: 2 },
		});

		expect(mocks.captureException).toHaveBeenCalledWith(error, {
			tags: {
				operation: "github.repositories.list",
				installationId: "installation-1",
			},
			extra: { attempt: 2 },
		});
	});

	it("groups business failures by operation", () => {
		reportOperationFailure("build.failed", {
			occurrenceId: "build-1",
			reason: "Build timed out",
			tags: { serverId: "server-1" },
			extra: { timeoutSeconds: 300 },
		});

		expect(mocks.captureMessage).toHaveBeenCalledWith(
			"Business operation failed: build.failed",
			{
				level: "error",
				fingerprint: ["business-failure", "build.failed"],
				tags: {
					operation: "build.failed",
					serverId: "server-1",
				},
				extra: {
					timeoutSeconds: 300,
					occurrenceId: "build-1",
					reason: "Build timed out",
				},
			},
		);
	});

	it("bounds and strips control characters from business reasons", () => {
		reportOperationFailure("work-item.failed", {
			occurrenceId: "work-1",
			reason: `failed\n${"x".repeat(600)}`,
		});

		expect(mocks.captureMessage).toHaveBeenCalledWith(
			"Business operation failed: work-item.failed",
			expect.objectContaining({
				extra: {
					occurrenceId: "work-1",
					reason: `failed ${"x".repeat(493)}`,
				},
			}),
		);
	});
});
