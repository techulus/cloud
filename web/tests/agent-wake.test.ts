import { describe, expect, it, vi } from "vitest";
import { waitForAgentGeneration } from "@/lib/agent-wake";

const signal = () => new AbortController().signal;

describe("agent wake polling", () => {
	it("returns an already advanced generation", async () => {
		const result = await waitForAgentGeneration("advanced", 3, signal(), {
			readGeneration: vi.fn().mockResolvedValue(4),
			subscribe: async () => () => undefined,
		});

		expect(result).toEqual({ kind: "advanced", generation: 4 });
	});

	it("registers before re-reading to close the lost-wake window", async () => {
		const events: string[] = [];
		const result = await waitForAgentGeneration("lost-wake", 8, signal(), {
			readGeneration: async () => {
				events.push("read");
				return 9;
			},
			subscribe: async () => {
				events.push("subscribe");
				return () => events.push("unsubscribe");
			},
		});

		expect(result).toEqual({ kind: "advanced", generation: 9 });
		expect(events).toEqual(["subscribe", "read", "unsubscribe"]);
	});

	it("times out and removes its subscription", async () => {
		const unsubscribe = vi.fn();
		const result = await waitForAgentGeneration("timeout", 2, signal(), {
			readGeneration: vi.fn().mockResolvedValue(2),
			subscribe: async () => unsubscribe,
			timeoutMs: 5,
			pollIntervalMs: 100,
		});

		expect(result).toEqual({ kind: "timeout" });
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("rejects a second outstanding poll for the same server", async () => {
		let releaseSubscription: (() => void) | undefined;
		const first = waitForAgentGeneration("duplicate", 1, signal(), {
			readGeneration: vi.fn().mockResolvedValue(1),
			subscribe: () =>
				new Promise((resolve) => {
					releaseSubscription = () => resolve(() => undefined);
				}),
			timeoutMs: 5,
		});

		expect(
			await waitForAgentGeneration("duplicate", 1, signal(), {
				readGeneration: vi.fn(),
			}),
		).toEqual({ kind: "duplicate" });
		releaseSubscription?.();
		await first;
	});
});
