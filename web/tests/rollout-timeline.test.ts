import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/schema", () => ({ rolloutStageTransitions: {} }));

import { recordRolloutStageBoundary } from "@/lib/rollout-timeline";

describe("rollout timeline", () => {
	it("uses one conflict-safe identity for a replayed boundary", async () => {
		const onConflictDoNothing = vi.fn();
		const values = vi.fn(() => ({ onConflictDoNothing }));
		const tx = { insert: vi.fn(() => ({ values })) };
		const at = new Date("2026-07-26T12:00:00Z");

		await recordRolloutStageBoundary(tx as never, {
			rolloutId: "rollout-1",
			stage: "expected_state_fetched",
			serverId: "server-1",
			generation: 7,
			at,
		});
		await recordRolloutStageBoundary(tx as never, {
			rolloutId: "rollout-1",
			stage: "expected_state_fetched",
			serverId: "server-1",
			generation: 7,
			at,
		});

		expect(values).toHaveBeenCalledTimes(2);
		expect(values).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ scope: "server-1:7", enteredAt: at }),
		);
		expect(values.mock.calls[0]).toEqual(values.mock.calls[1]);
		expect(onConflictDoNothing).toHaveBeenCalledTimes(2);
	});
});
