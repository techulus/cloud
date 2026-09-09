import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { services } from "@/db/schema";

const mocks = vi.hoisted(() => {
	const service = {
		id: "service-1",
		projectId: "project-1",
		sourceType: "github",
		stateful: false,
	};
	const rows: unknown[][] = [];
	function query(result: unknown[]) {
		const builder = {
			from: vi.fn(() => builder),
			where: vi.fn(() => builder),
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle queries are awaitable.
			then: (resolve: (value: unknown[]) => unknown) =>
				Promise.resolve(result).then(resolve),
		};
		return builder;
	}
	const tx = {
		execute: vi.fn(),
		select: vi.fn(() => query([service])),
		update: vi.fn(() => ({
			set: () => ({
				where: () => ({ returning: () => Promise.resolve([service]) }),
			}),
		})),
	};
	return {
		service,
		rows,
		db: {
			select: vi.fn(() => query(rows.shift() ?? [])),
			transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
				callback(tx),
			),
			delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
		},
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/db/queries", () => ({
	getService: vi.fn(async () => mocks.service),
}));
vi.mock("@/lib/auth", () => ({
	requireDeveloperRole: vi.fn(),
	verifyDeleteConfirmation: vi.fn(),
}));
vi.mock("@/lib/deploy-service", () => ({ deployServiceInternal: vi.fn() }));
vi.mock("@/lib/preview-lifecycle", () => ({
	deletePreviewsForBaseService: vi.fn(),
}));
vi.mock("@/actions/backups", () => ({ deleteBackup: vi.fn() }));
vi.mock("@/lib/backups/delete-backup", () => ({
	deleteBackupInternal: vi.fn(),
}));
vi.mock("@/lib/server-errors", () => ({ reportServerError: vi.fn() }));
vi.mock("@/lib/work-queue", () => ({ enqueueWork: vi.fn() }));
vi.mock("@/lib/inngest/client", () => ({
	inngest: {
		createFunction: (_options: unknown, handler: unknown) => handler,
	},
}));

import { deleteService } from "@/actions/projects";
import { expiredDeletedServicesPurge } from "@/lib/inngest/functions/service-deletion-workflow";

describe("service deletion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.rows.length = 0;
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("Registry unavailable"),
		);
	});
	afterEach(() => vi.restoreAllMocks());

	it("hard-deletes a stateless service without registry cleanup", async () => {
		mocks.rows.push([], [], []);

		await expect(deleteService("service-1")).resolves.toEqual({
			success: true,
		});
		expect(mocks.db.delete).toHaveBeenLastCalledWith(services);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("purges an expired service without registry cleanup", async () => {
		mocks.rows.push([mocks.service], []);
		const handler = expiredDeletedServicesPurge as unknown as (input: {
			step: {
				run: (name: string, callback: () => Promise<void>) => Promise<void>;
			};
		}) => Promise<void>;

		await handler({ step: { run: (_name, callback) => callback() } });

		expect(mocks.db.delete).toHaveBeenLastCalledWith(services);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
