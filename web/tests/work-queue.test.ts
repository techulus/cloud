import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const state = {
		updatedRows: [] as unknown[],
		backupRows: [] as unknown[],
		rejectionRows: [] as unknown[],
		persistedStatus: "processing",
		pendingStatus: null as string | null,
		updateMatched: false,
	};

	function createQuery(result: unknown[]) {
		const query = {
			from: vi.fn(() => query),
			set: vi.fn(() => query),
			where: vi.fn(() => query),
			returning: vi.fn(() => query),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return query;
	}

	function createUpdateQuery() {
		const query = {
			set: vi.fn((values: { status?: string }) => {
				state.pendingStatus = values.status ?? null;
				return query;
			}),
			where: vi.fn(() => query),
			returning: vi.fn(() => query),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => {
				const row = state.updatedRows[0];
				const result =
					row && state.persistedStatus === "processing"
						? [{ ...(row as object), status: state.pendingStatus }]
						: [];
				state.updateMatched = result.length > 0;
				return Promise.resolve(result).then(resolve, reject);
			},
		};
		return query;
	}

	const tx = {
		update: vi.fn(() => createUpdateQuery()),
		select: vi.fn(() => createQuery(state.backupRows)),
	};

	return {
		state,
		tx,
		db: {
			transaction: vi.fn(
				async (callback: (transaction: typeof tx) => Promise<unknown>) => {
					state.pendingStatus = null;
					state.updateMatched = false;
					const result = await callback(tx);
					if (state.updateMatched && state.pendingStatus) {
						state.persistedStatus = state.pendingStatus;
					}
					return result;
				},
			),
			select: vi.fn(() => createQuery(state.rejectionRows)),
		},
		send: vi.fn(),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/inngest/client", () => ({
	inngest: { send: mocks.send },
}));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		restoreCompleted: {
			create: vi.fn((data, options) => ({
				name: "restore/completed",
				data,
				...options,
			})),
		},
		restoreFailed: {
			create: vi.fn((data, options) => ({
				name: "restore/failed",
				data,
				...options,
			})),
		},
		migrationRestoreFinished: {
			create: vi.fn((data, options) => ({
				name: "migration/restore-finished",
				data,
				...options,
			})),
		},
	},
}));
vi.mock("@/lib/work-queue-notifications", () => ({
	notifyWorkAvailable: vi.fn(),
}));

import { completeWorkItemResults } from "@/lib/work-queue";

function restoreWorkItem(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		serverId: "server-1",
		type: "restore_volume",
		payload: JSON.stringify({
			backupId: "backup-1",
			serviceId: "service-1",
			isMigrationRestore: false,
		}),
		status: "completed",
		attempts: 1,
		createdAt: new Date(),
		startedAt: new Date(),
		...overrides,
	};
}

beforeEach(() => {
	mocks.state.updatedRows = [restoreWorkItem("work-1")];
	mocks.state.backupRows = [{ volumeId: "volume-1", serviceId: "service-1" }];
	mocks.state.rejectionRows = [];
	mocks.state.persistedStatus = "processing";
	mocks.state.pendingStatus = null;
	mocks.state.updateMatched = false;
	mocks.tx.update.mockClear();
	mocks.tx.select.mockClear();
	mocks.db.transaction.mockClear();
	mocks.db.select.mockClear();
	mocks.send.mockReset();
	mocks.send.mockResolvedValue(undefined);
});

describe("restore work completion", () => {
	it("publishes an authorized normal restore success", async () => {
		const result = await completeWorkItemResults("server-1", [
			{ id: "work-1", attempt: 1, status: "completed" },
		]);

		expect(result).toEqual({ accepted: ["work-1"], rejected: [] });
		expect(mocks.send).toHaveBeenCalledWith({
			name: "restore/completed",
			id: "restore-completed-work-1",
			data: {
				backupId: "backup-1",
				volumeId: "volume-1",
				serviceId: "service-1",
				isMigrationRestore: false,
			},
		});
	});

	it("publishes an authorized normal restore failure", async () => {
		await completeWorkItemResults("server-1", [
			{
				id: "work-1",
				attempt: 1,
				status: "failed",
				error: "checksum mismatch",
			},
		]);

		expect(mocks.send).toHaveBeenCalledWith({
			name: "restore/failed",
			id: "restore-failed-work-1",
			data: {
				backupId: "backup-1",
				volumeId: "volume-1",
				serviceId: "service-1",
				isMigrationRestore: false,
				error: "checksum mismatch",
			},
		});
	});

	it("publishes the terminal migration event from persisted context", async () => {
		mocks.state.updatedRows = [
			restoreWorkItem("work-1", {
				payload: JSON.stringify({
					backupId: "backup-1",
					serviceId: "service-1",
					isMigrationRestore: true,
				}),
			}),
		];

		await completeWorkItemResults("server-1", [
			{ id: "work-1", attempt: 1, status: "failed" },
		]);

		expect(mocks.send).toHaveBeenCalledWith({
			name: "migration/restore-finished",
			id: "migration-restore-failed-work-1",
			data: {
				backupId: "backup-1",
				serviceId: "service-1",
				status: "failed",
				error: "Restore failed",
			},
		});
	});

	it("publishes a successful terminal migration event", async () => {
		mocks.state.updatedRows = [
			restoreWorkItem("work-1", {
				payload: JSON.stringify({
					backupId: "backup-1",
					serviceId: "service-1",
					isMigrationRestore: true,
				}),
			}),
		];

		await completeWorkItemResults("server-1", [
			{ id: "work-1", attempt: 1, status: "completed" },
		]);

		expect(mocks.send).toHaveBeenCalledWith({
			name: "migration/restore-finished",
			id: "migration-restore-completed-work-1",
			data: {
				backupId: "backup-1",
				serviceId: "service-1",
				status: "completed",
			},
		});
	});

	it("does not publish an event for a rejected result", async () => {
		mocks.state.updatedRows = [];
		mocks.state.rejectionRows = [
			{ serverId: "server-2", status: "processing", attempts: 1 },
		];

		const result = await completeWorkItemResults("server-1", [
			{ id: "work-1", attempt: 1, status: "completed" },
		]);

		expect(result).toEqual({
			accepted: [],
			rejected: [{ id: "work-1", reason: "server_mismatch" }],
		});
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it.each([
		["invalid JSON", "{"],
		[
			"missing migration context",
			JSON.stringify({ backupId: "backup-1", serviceId: "service-1" }),
		],
	])("rejects %s in the persisted payload", async (_label, payload) => {
		mocks.state.updatedRows = [restoreWorkItem("work-1", { payload })];

		await expect(
			completeWorkItemResults("server-1", [
				{ id: "work-1", attempt: 1, status: "completed" },
			]),
		).rejects.toThrow("Restore work item work-1");
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("rejects a backup from a different service", async () => {
		mocks.state.backupRows = [{ volumeId: "volume-1", serviceId: "service-2" }];

		await expect(
			completeWorkItemResults("server-1", [
				{ id: "work-1", attempt: 1, status: "completed" },
			]),
		).rejects.toThrow("mismatched service context");
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("leaves publication failures unacknowledged so they can be retried", async () => {
		mocks.send.mockRejectedValueOnce(new Error("Inngest unavailable"));

		await expect(
			completeWorkItemResults("server-1", [
				{ id: "work-1", attempt: 1, status: "completed" },
			]),
		).rejects.toThrow("Inngest unavailable");
		expect(mocks.state.persistedStatus).toBe("processing");

		const retried = await completeWorkItemResults("server-1", [
			{ id: "work-1", attempt: 1, status: "completed" },
		]);
		expect(retried.accepted).toEqual(["work-1"]);
		expect(mocks.state.persistedStatus).toBe("completed");
		expect(mocks.send.mock.calls.map(([event]) => event.id)).toEqual([
			"restore-completed-work-1",
			"restore-completed-work-1",
		]);
	});

	it("uses work item IDs to distinguish repeated restores of one backup", async () => {
		await completeWorkItemResults("server-1", [
			{ id: "work-1", attempt: 1, status: "completed" },
		]);
		mocks.state.updatedRows = [restoreWorkItem("work-2")];
		mocks.state.persistedStatus = "processing";
		await completeWorkItemResults("server-1", [
			{ id: "work-2", attempt: 1, status: "completed" },
		]);

		expect(mocks.send.mock.calls.map(([event]) => event.id)).toEqual([
			"restore-completed-work-1",
			"restore-completed-work-2",
		]);
	});
});
