import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selectResults: [] as unknown[][],
	set: vi.fn(),
}));

vi.mock("@/db", () => ({
	db: {
		transaction: vi.fn(async (callback) => {
			const tx = {
				execute: vi.fn(),
				select: vi.fn(() => {
					const isInitialRolloutQuery = mocks.selectResults.length === 2;
					const rows = mocks.selectResults.shift() ?? [];
					return {
						from: () => ({
							where: () =>
								isInitialRolloutQuery
									? Promise.resolve(rows)
									: { limit: () => Promise.resolve(rows) },
						}),
					};
				}),
				update: vi.fn(() => ({
					set: (value: unknown) => {
						mocks.set(value);
						return { where: vi.fn() };
					},
				})),
			};
			return callback(tx);
		}),
	},
}));

vi.mock("@/lib/inngest/client", () => ({
	inngest: { createFunction: vi.fn(() => ({})) },
}));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		rolloutCreated: {},
		rolloutCancelled: {},
	},
}));

import { acquireRolloutTurn } from "@/lib/inngest/functions/rollout-workflow";

describe("rollout turn acquisition", () => {
	it("supersedes a delayed enqueue failure when another intent exists", async () => {
		mocks.selectResults.push(
			[
				{
					status: "failed",
					currentStage: "enqueue_failed",
					createdAt: new Date("2026-07-23T10:00:00Z"),
				},
			],
			[{ id: "newer-rollout" }],
		);

		await expect(
			acquireRolloutTurn("delayed-rollout", "service-1"),
		).resolves.toBe("terminal");
		expect(mocks.set).toHaveBeenCalledWith({ currentStage: "superseded" });
		expect(mocks.set).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "in_progress" }),
		);
	});
});
