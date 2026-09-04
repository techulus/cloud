import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	let selectRows: unknown[] = [];
	const selectQuery = {
		from: vi.fn(),
		where: vi.fn(),
		limit: vi.fn(),
		// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
		then: (resolve: (rows: unknown[]) => unknown) =>
			Promise.resolve(selectRows).then(resolve),
	};
	selectQuery.from.mockReturnValue(selectQuery);
	selectQuery.where.mockReturnValue(selectQuery);
	selectQuery.limit.mockReturnValue(selectQuery);
	const updateQuery = { set: vi.fn(), where: vi.fn() };
	updateQuery.set.mockReturnValue(updateQuery);
	updateQuery.where.mockResolvedValue(undefined);
	return {
		transaction: vi.fn(),
		execute: vi.fn(),
		deleteGarProtectionTag: vi.fn(),
		db: {
			select: vi.fn(() => selectQuery),
			update: vi.fn(() => updateQuery),
			execute: vi.fn((...args: unknown[]) => mocks.execute(...args)),
			transaction: vi.fn((...args: unknown[]) => mocks.transaction(...args)),
		},
		updateQuery,
		setSelectRows: (rows: unknown[]) => {
			selectRows = rows;
		},
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/google-artifact-registry", () => ({
	deleteGarProtectionTag: mocks.deleteGarProtectionTag,
}));
vi.mock("@/lib/service-revision-changes", () => ({
	parseServiceRevisionSpec: (value: unknown) => value,
}));

import {
	prepareGarPackageDeletion,
	releaseGarProtectionDaily,
	releaseGarRevisionProtection,
} from "@/lib/gar-retention";

const githubRevision = (image: string) => ({
	id: "revision-1",
	serviceId: "service-1",
	artifactDeletedAt: null,
	specification: { image, source: { type: "github" } },
});

describe("GAR retention", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.setSelectRows([]);
		mocks.execute.mockReset();
		mocks.transaction.mockReset();
		mocks.deleteGarProtectionTag.mockResolvedValue(undefined);
	});

	it.each([
		{ processingRows: [], ready: true },
		{ processingRows: [{ id: "manifest-1" }], ready: false },
	])(
		"fails pending manifest work and reports processing readiness as $ready",
		async ({ processingRows, ready }) => {
			const update = {
				set: vi.fn(),
				where: vi.fn().mockResolvedValue(undefined),
			};
			update.set.mockReturnValue(update);
			const select = {
				from: vi.fn(),
				where: vi.fn(),
				limit: vi.fn().mockResolvedValue(processingRows),
			};
			select.from.mockReturnValue(select);
			select.where.mockReturnValue(select);
			const tx = {
				update: vi.fn(() => update),
				select: vi.fn(() => select),
			} as never;

			await expect(prepareGarPackageDeletion(tx, "service-1")).resolves.toBe(
				ready,
			);
			expect(update.set).toHaveBeenCalledWith({ status: "failed" });
			expect(select.limit).toHaveBeenCalledWith(1);
		},
	);

	it("releases only the protection tag before marking every same-image revision", async () => {
		const image =
			"us-central1-docker.pkg.dev/google-project/repository/project/service:revision-1";
		await expect(
			releaseGarRevisionProtection(githubRevision(image)),
		).resolves.toBe(true);
		expect(mocks.deleteGarProtectionTag).toHaveBeenCalledWith(image);
		expect(mocks.db.update).toHaveBeenCalledOnce();
		expect(mocks.updateQuery.set).toHaveBeenCalledWith({
			artifactDeletedAt: expect.any(Date),
		});
	});

	it("does not mark a revision when GAR protection release fails", async () => {
		mocks.deleteGarProtectionTag.mockRejectedValue(
			new Error("GAR unavailable"),
		);
		await expect(
			releaseGarRevisionProtection(
				githubRevision(
					"us-central1-docker.pkg.dev/google-project/repository/project/service:revision-1",
				),
			),
		).rejects.toThrow("GAR unavailable");
		expect(mocks.db.update).not.toHaveBeenCalled();
	});

	it("keeps a candidate when the locked eligibility recheck rejects it", async () => {
		mocks.execute.mockResolvedValue({
			rows: [
				{
					...githubRevision("managed/project/service:revision-1"),
					image: "managed/project/service:revision-1",
				},
			],
		});
		mocks.transaction.mockImplementation(async (callback) =>
			callback({
				execute: vi
					.fn()
					.mockResolvedValueOnce({ rows: [] })
					.mockResolvedValueOnce({ rows: [] }),
			}),
		);

		await releaseGarProtectionDaily();

		expect(mocks.deleteGarProtectionTag).not.toHaveBeenCalled();
	});

	it("releases an eligible candidate while holding its service lock", async () => {
		const revision = githubRevision("managed/project/service:revision-1");
		mocks.execute.mockResolvedValue({
			rows: [{ ...revision, image: revision.specification.image }],
		});
		const transactionExecute = vi
			.fn()
			.mockResolvedValueOnce({ rows: [] })
			.mockResolvedValueOnce({ rows: [revision] })
			.mockResolvedValueOnce({ rows: [] });
		mocks.transaction.mockImplementation(async (callback) =>
			callback({ execute: transactionExecute }),
		);

		await releaseGarProtectionDaily();

		expect(mocks.deleteGarProtectionTag).toHaveBeenCalledWith(
			"managed/project/service:revision-1",
		);
		expect(transactionExecute).toHaveBeenCalledTimes(3);
	});
});
