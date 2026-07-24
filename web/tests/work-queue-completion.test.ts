import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const selectResults: unknown[][] = [];
	const updateSets: Array<Record<string, unknown>> = [];
	const insertValues: Array<Record<string, unknown>> = [];

	function selectQuery(result: unknown[]) {
		const query = {
			from: vi.fn(() => query),
			where: vi.fn(() => query),
			for: vi.fn(() => query),
			orderBy: vi.fn(() => query),
			limit: vi.fn(() => query),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return query;
	}

	function updateQuery() {
		const query = {
			set: vi.fn((value: Record<string, unknown>) => {
				updateSets.push(value);
				return query;
			}),
			where: vi.fn(() => query),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (resolve: (value: unknown[]) => unknown) =>
				Promise.resolve([]).then(resolve),
		};
		return query;
	}

	function insertQuery() {
		const query = {
			values: vi.fn((value: Record<string, unknown>) => {
				insertValues.push(value);
				return query;
			}),
			onConflictDoNothing: vi.fn(() => query),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (resolve: (value: unknown[]) => unknown) =>
				Promise.resolve([]).then(resolve),
		};
		return query;
	}

	const tx = {
		select: vi.fn(() => selectQuery(selectResults.shift() ?? [])),
		update: vi.fn(() => updateQuery()),
		insert: vi.fn(() => insertQuery()),
	};

	return {
		selectResults,
		updateSets,
		insertValues,
		tx,
		send: vi.fn(),
		revalidatePath: vi.fn(),
		db: {
			select: vi.fn(() => selectQuery(selectResults.shift() ?? [])),
			update: vi.fn(() => updateQuery()),
			insert: vi.fn(() => insertQuery()),
			transaction: vi.fn(
				(callback: (transaction: typeof tx) => Promise<unknown>) =>
					callback(tx),
			),
		},
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/inngest/client", () => ({
	inngest: { send: mocks.send },
}));

import {
	completeLegacyVolumeWorkItem,
	completeWorkItemResults,
	dispatchWorkCompletionOutbox,
	validateWorkItemResultOutput,
} from "@/lib/work-queue";

const checksum = "a".repeat(64);

function workItem(type: "backup_volume" | "restore_volume", payload: object) {
	return {
		id: "work-1",
		serverId: "server-1",
		type,
		payload: JSON.stringify(payload),
		status: "processing" as const,
		createdAt: new Date(),
		startedAt: new Date(),
		attempts: 1,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.selectResults.length = 0;
	mocks.updateSets.length = 0;
	mocks.insertValues.length = 0;
	mocks.send.mockResolvedValue(undefined);
	mocks.revalidatePath.mockReset();
});

describe("work result output validation", () => {
	it("accepts a valid completed backup output", () => {
		expect(
			validateWorkItemResultOutput("backup_volume", {
				id: "work-1",
				attempt: 1,
				status: "completed",
				output: { sizeBytes: 42, checksum },
			}),
		).toBeNull();
	});

	it.each([
		undefined,
		{},
		{ sizeBytes: -1, checksum },
		{ sizeBytes: 1.5, checksum },
		{ sizeBytes: Number.MAX_SAFE_INTEGER + 1, checksum },
		{ sizeBytes: 1, checksum: "not-a-checksum" },
	])("rejects malformed completed backup output %#", (output) => {
		expect(
			validateWorkItemResultOutput("backup_volume", {
				id: "work-1",
				attempt: 1,
				status: "completed",
				output: output as never,
			}),
		).toBe("invalid_output");
	});
});

describe("durable work completion", () => {
	it("atomically records backup state, terminal work, and its event", async () => {
		mocks.selectResults.push(
			[
				workItem("backup_volume", {
					backupId: "backup-1",
					serviceId: "service-1",
				}),
			],
			[{ agentHealth: { capabilities: ["typed_work_results_v1"] } }],
			[
				{
					id: "backup-1",
					serverId: "server-1",
					serviceId: "service-1",
					status: "pending",
				},
			],
			[],
		);

		const result = await completeWorkItemResults("server-1", [
			{
				id: "work-1",
				attempt: 1,
				status: "completed",
				output: { sizeBytes: 42, checksum: checksum.toUpperCase() },
			},
		]);

		expect(result).toEqual({
			accepted: ["work-1"],
			rejected: [],
			retryable: [],
		});
		expect(mocks.updateSets).toEqual([
			expect.objectContaining({
				status: "completed",
				sizeBytes: 42,
				checksum,
			}),
			{ status: "completed" },
		]);
		expect(mocks.insertValues).toHaveLength(1);
		expect(mocks.insertValues[0]).toMatchObject({
			workItemId: "work-1",
			revalidateProjects: true,
			events: [
				expect.objectContaining({
					id: "work-completion:work-1:resource-status-changed",
					name: "resource/status-changed",
				}),
			],
		});
	});

	it("stores a self-contained migration restore event bundle", async () => {
		mocks.selectResults.push(
			[
				workItem("restore_volume", {
					backupId: "backup-1",
					serviceId: "service-1",
					isMigrationRestore: true,
				}),
			],
			[{ agentHealth: { capabilities: ["typed_work_results_v1"] } }],
			[{ volumeId: "volume-1", serviceId: "service-1" }],
			[],
		);

		const result = await completeWorkItemResults("server-1", [
			{ id: "work-1", attempt: 1, status: "completed" },
		]);

		expect(result.accepted).toEqual(["work-1"]);
		const events = mocks.insertValues[0].events as Array<{
			id: string;
			data: Record<string, unknown>;
		}>;
		expect(events).toHaveLength(3);
		expect(new Set(events.map((event) => event.id)).size).toBe(3);
		expect(events[0].data).toMatchObject({
			workItemId: "work-1",
			backupId: "backup-1",
			volumeId: "volume-1",
			serviceId: "service-1",
			isMigrationRestore: true,
		});
	});

	it("rejects a result that conflicts with an already-terminal backup", async () => {
		mocks.selectResults.push(
			[
				workItem("backup_volume", {
					backupId: "backup-1",
					serviceId: "service-1",
				}),
			],
			[{ agentHealth: { capabilities: ["typed_work_results_v1"] } }],
			[
				{
					id: "backup-1",
					serverId: "server-1",
					serviceId: "service-1",
					status: "failed",
				},
			],
		);

		const result = await completeWorkItemResults("server-1", [
			{
				id: "work-1",
				attempt: 1,
				status: "completed",
				output: { sizeBytes: 42, checksum },
			},
		]);

		expect(result.rejected).toEqual([
			{ id: "work-1", reason: "conflicting_terminal_state" },
		]);
		expect(mocks.updateSets).toEqual([]);
		expect(mocks.insertValues).toEqual([]);
	});

	it("does not expire a work item whose lease was renewed", async () => {
		mocks.selectResults.push([
			workItem("restore_volume", {
				backupId: "backup-1",
				serviceId: "service-1",
				isMigrationRestore: false,
			}),
		]);

		const result = await completeWorkItemResults(
			"server-1",
			[
				{
					id: "work-1",
					attempt: 1,
					status: "failed",
					error: "Work item attempts exhausted",
				},
			],
			{
				source: "system",
				processingStartedBefore: new Date(Date.now() - 60_000),
			},
		);

		expect(result.rejected).toEqual([{ id: "work-1", reason: "not_stale" }]);
		expect(mocks.updateSets).toEqual([]);
	});

	it("requires legacy callbacks from agents without typed results", async () => {
		mocks.selectResults.push(
			[
				workItem("restore_volume", {
					backupId: "backup-1",
					serviceId: "service-1",
					isMigrationRestore: false,
				}),
			],
			[{ agentHealth: { capabilities: [] } }],
		);

		const result = await completeWorkItemResults("server-1", [
			{ id: "work-1", attempt: 1, status: "completed" },
		]);

		expect(result.accepted).toEqual([]);
		expect(result.rejected).toEqual([
			{ id: "work-1", reason: "legacy_callback_required" },
		]);
		expect(mocks.updateSets).toEqual([]);
		expect(mocks.insertValues).toEqual([]);
	});
});

describe("completion outbox delivery", () => {
	it("does not mark an event bundle processed when Inngest rejects it", async () => {
		mocks.selectResults.push([
			{
				workItemId: "work-1",
				events: [{ id: "event-1", name: "restore/completed", data: {} }],
				processedAt: null,
			},
		]);
		mocks.send.mockRejectedValueOnce(new Error("inngest unavailable"));

		await expect(dispatchWorkCompletionOutbox("work-1")).rejects.toThrow(
			"inngest unavailable",
		);
		expect(mocks.updateSets).toEqual([]);
	});

	it("marks an event bundle processed only after Inngest accepts it", async () => {
		const events = [{ id: "event-1", name: "restore/completed", data: {} }];
		mocks.selectResults.push([
			{ workItemId: "work-1", events, processedAt: null },
		]);

		await dispatchWorkCompletionOutbox("work-1");

		expect(mocks.send).toHaveBeenCalledWith(events);
		expect(mocks.updateSets).toEqual([{ processedAt: expect.any(Date) }]);
	});

	it("leaves an event bundle pending when project revalidation fails", async () => {
		const events = [{ id: "event-1", name: "restore/completed", data: {} }];
		mocks.selectResults.push([
			{
				workItemId: "work-1",
				events,
				revalidateProjects: true,
				processedAt: null,
			},
		]);
		mocks.revalidatePath.mockImplementationOnce(() => {
			throw new Error("cache unavailable");
		});

		await expect(dispatchWorkCompletionOutbox("work-1")).rejects.toThrow(
			"cache unavailable",
		);
		expect(mocks.send).toHaveBeenCalledWith(events);
		expect(mocks.updateSets).toEqual([]);
	});
});

describe("legacy volume callbacks", () => {
	it("adapts a matching old-agent backup callback to the fenced protocol", async () => {
		const item = workItem("backup_volume", {
			backupId: "backup-1",
			serviceId: "service-1",
		});
		mocks.selectResults.push(
			[item],
			[item],
			[
				{
					id: "backup-1",
					serverId: "server-1",
					serviceId: "service-1",
					status: "pending",
				},
			],
			[],
		);

		const outcome = await completeLegacyVolumeWorkItem(
			"server-1",
			"backup_volume",
			"backup-1",
			{
				status: "completed",
				output: { sizeBytes: 42, checksum },
			},
		);

		expect(outcome).toBe("completed");
		expect(mocks.db.transaction).toHaveBeenCalledOnce();
		expect(mocks.updateSets).toEqual([
			expect.objectContaining({ status: "completed", checksum }),
			{ status: "completed" },
		]);
	});

	it("refuses an ambiguous old-agent callback", async () => {
		const item = workItem("restore_volume", {
			backupId: "backup-1",
			serviceId: "service-1",
			isMigrationRestore: false,
		});
		mocks.selectResults.push([item, { ...item, id: "work-2" }]);

		await expect(
			completeLegacyVolumeWorkItem("server-1", "restore_volume", "backup-1", {
				status: "completed",
			}),
		).resolves.toBe("conflict");
		expect(mocks.db.transaction).not.toHaveBeenCalled();
	});

	it("accepts a duplicate completed backup callback only when its output matches", async () => {
		mocks.selectResults.push(
			[],
			[{ status: "completed" }],
			[{ sizeBytes: 42, checksum }],
		);

		await expect(
			completeLegacyVolumeWorkItem("server-1", "backup_volume", "backup-1", {
				status: "completed",
				output: { sizeBytes: 42, checksum },
			}),
		).resolves.toBe("completed");
	});

	it("rejects a duplicate completed backup callback with different output", async () => {
		mocks.selectResults.push(
			[],
			[{ status: "completed" }],
			[{ sizeBytes: 42, checksum }],
		);

		await expect(
			completeLegacyVolumeWorkItem("server-1", "backup_volume", "backup-1", {
				status: "completed",
				output: { sizeBytes: 43, checksum },
			}),
		).resolves.toBe("not_found");
	});
});
