import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selectResults: [] as unknown[][],
	selectCall: 0,
	set: vi.fn(),
	returningResults: [] as unknown[][],
}));

vi.mock("@/db", () => ({
	db: {
		transaction: vi.fn(async (callback) => {
			const tx = {
				execute: vi.fn(),
				select: vi.fn(() => {
					const isInitialRolloutQuery = mocks.selectCall++ === 0;
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
						return {
							where: vi.fn(() => ({
								returning: vi.fn(() =>
									Promise.resolve(mocks.returningResults.shift() ?? []),
								),
							})),
						};
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

import {
	acquireRolloutTurn,
	failQueuedRolloutOnTimeout,
} from "@/lib/inngest/functions/rollout-workflow";

describe("rollout turn acquisition", () => {
	beforeEach(() => {
		mocks.selectResults.length = 0;
		mocks.selectCall = 0;
		mocks.set.mockClear();
		mocks.returningResults.length = 0;
	});

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
		expect(mocks.set).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "superseded",
				currentStage: "superseded",
			}),
		);
		expect(mocks.set).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "in_progress" }),
		);
	});

	it("makes an older queued rollout terminal when the newer event executes first", async () => {
		mocks.selectResults.push(
			[
				{
					status: "queued",
					currentStage: null,
					createdAt: new Date("2026-07-23T10:00:00Z"),
				},
			],
			[{ id: "newer-rollout" }],
		);

		await expect(acquireRolloutTurn("older", "service-1")).resolves.toBe(
			"terminal",
		);
		expect(mocks.set).toHaveBeenCalledWith(
			expect.objectContaining({ status: "superseded" }),
		);
		expect(mocks.set).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "in_progress" }),
		);
	});

	it("supersedes an older queued rollout before waiting when its event executes first", async () => {
		mocks.selectResults.push(
			[
				{
					status: "queued",
					currentStage: "queued",
					createdAt: new Date("2026-07-23T10:00:01Z"),
				},
			],
			[],
			[{ id: "older-in-progress" }],
		);

		await expect(acquireRolloutTurn("newer", "service-1")).resolves.toBe(
			"waiting",
		);
		expect(mocks.set).toHaveBeenCalledWith(
			expect.objectContaining({ status: "superseded" }),
		);
	});

	it("uses the id tie-break when timestamps are equal", async () => {
		mocks.selectResults.push(
			[
				{
					status: "queued",
					currentStage: "queued",
					createdAt: new Date("2026-07-23T10:00:00Z"),
				},
			],
			[{ id: "b" }],
		);

		await expect(acquireRolloutTurn("a", "service-1")).resolves.toBe(
			"terminal",
		);
	});

	it("supersedes itself when the newer rollout is already completed", async () => {
		mocks.selectResults.push(
			[
				{
					status: "queued",
					currentStage: "queued",
					createdAt: new Date("2026-07-23T10:00:00Z"),
				},
			],
			[{ id: "completed-newer" }],
		);

		await expect(acquireRolloutTurn("older", "service-1")).resolves.toBe(
			"terminal",
		);
		expect(mocks.set).toHaveBeenCalledWith(
			expect.objectContaining({ status: "superseded" }),
		);
	});

	it("does not apply a queue timeout after the rollout status changed", async () => {
		mocks.returningResults.push([]);

		await expect(failQueuedRolloutOnTimeout("rollout-1")).resolves.toBe(false);
		expect(mocks.set).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "failed",
				currentStage: "queue_timeout",
			}),
		);
	});
});
