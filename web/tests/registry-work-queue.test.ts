import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workQueue } from "@/db/schema";

const mocks = vi.hoisted(() => ({
	notifyWorkAvailable: vi.fn(),
}));

vi.mock("@/lib/work-queue-notifications", () => ({
	notifyWorkAvailable: mocks.notifyWorkAvailable,
}));

import { enqueueRegistrySyncForAllRegisteredServers } from "@/lib/work-queue";

type RegistrySyncTransaction = Parameters<
	typeof enqueueRegistrySyncForAllRegisteredServers
>[1];

function awaitable<T>(value: T) {
	return {
		// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
		then: <TResult1 = T, TResult2 = never>(
			resolve?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
			reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
		) => Promise.resolve(value).then(resolve, reject),
	};
}

describe("registry synchronization fan-out", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("targets every registered server and coalesces only pending sync work", async () => {
		const inserted: Array<Record<string, unknown>> = [];
		const conflicts: Array<Record<string, unknown>> = [];
		const selectQuery = {
			from: vi.fn(() => selectQuery),
			where: vi.fn(() => awaitable([{ id: "online" }, { id: "offline" }])),
		};
		const tx = {
			select: vi.fn(() => selectQuery),
			insert: vi.fn(() => ({
				values: vi.fn((values: Record<string, unknown>) => {
					inserted.push(values);
					return {
						onConflictDoUpdate: vi.fn((config: Record<string, unknown>) => {
							conflicts.push(config);
							return Promise.resolve();
						}),
					};
				}),
			})),
		} as unknown as RegistrySyncTransaction;

		await enqueueRegistrySyncForAllRegisteredServers("version-2", tx);

		expect(inserted).toHaveLength(2);
		expect(inserted).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					serverId: "online",
					type: "sync_registries",
					payload: JSON.stringify({ version: "version-2" }),
				}),
				expect.objectContaining({
					serverId: "offline",
					type: "sync_registries",
					payload: JSON.stringify({ version: "version-2" }),
				}),
			]),
		);
		expect(conflicts).toHaveLength(2);
		expect(mocks.notifyWorkAvailable.mock.calls).toEqual([
			["online", tx],
			["offline", tx],
		]);

		const pendingSyncIndex = getTableConfig(workQueue).indexes.find(
			(index) =>
				index.config.name === "work_queue_one_pending_registry_sync_idx",
		);
		if (!pendingSyncIndex?.config.where)
			throw new Error("pending registry sync index is missing");
		expect(pendingSyncIndex?.config.unique).toBe(true);
		expect(
			new PgDialect().sqlToQuery(pendingSyncIndex.config.where).sql,
		).toContain(
			`"work_queue"."type" = 'sync_registries' AND "work_queue"."status" = 'pending'`,
		);
	});
});
