import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { services } from "@/db/schema";

const mocks = vi.hoisted(() => {
	// The persisted state after a GitHub-built service disconnects its repository.
	const service = {
		id: "service-1",
		projectId: "project-1",
		sourceType: "image",
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
		deleteGarServicePackage: vi.fn(),
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
vi.mock("@/lib/gar-retention", () => ({
	prepareGarPackageDeletion: vi.fn(async () => true),
}));
vi.mock("@/lib/google-artifact-registry", () => ({
	deleteGarServicePackage: mocks.deleteGarServicePackage,
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

async function invoke(path: string) {
	if (path === "hard deletion") return deleteService("service-1");
	mocks.rows.push([mocks.service]);
	const handler = expiredDeletedServicesPurge as unknown as (input: {
		step: {
			run: (name: string, callback: () => Promise<void>) => Promise<void>;
		};
	}) => Promise<void>;
	return handler({ step: { run: (_name, callback) => callback() } });
}

describe.each(["hard deletion", "expiry purge"])(
	"GAR cleanup during %s",
	(path) => {
		beforeEach(() => {
			vi.clearAllMocks();
			mocks.rows.length = 0;
			vi.spyOn(console, "error").mockImplementation(() => {});
		});
		afterEach(() => vi.restoreAllMocks());

		it("awaits historical package deletion after GitHub is disconnected", async () => {
			let complete!: () => void;
			mocks.deleteGarServicePackage.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						complete = resolve;
					}),
			);
			const deletion = invoke(path);
			await vi.waitFor(() =>
				expect(mocks.deleteGarServicePackage).toHaveBeenCalledWith(
					"project-1",
					"service-1",
				),
			);
			expect(mocks.db.delete).not.toHaveBeenCalledWith(services);
			complete();
			await deletion;
			expect(mocks.db.delete).toHaveBeenLastCalledWith(services);
		});

		it("preserves the service for retry if GAR deletion fails", async () => {
			mocks.deleteGarServicePackage.mockRejectedValue(
				new Error("GAR package deletion operation failed"),
			);
			const deletion = invoke(path);
			if (path === "hard deletion")
				await expect(deletion).rejects.toThrow("operation failed");
			else await deletion; // The purge reports errors and retries retained rows next run.
			expect(mocks.deleteGarServicePackage).toHaveBeenCalledWith(
				"project-1",
				"service-1",
			);
			expect(mocks.db.delete).not.toHaveBeenCalledWith(services);
		});
	},
);
