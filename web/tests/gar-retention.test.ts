import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => {
	let selectRows: unknown[] = [];
	const selectQuery = {
		from: vi.fn(),
		innerJoin: vi.fn(),
		where: vi.fn(),
		limit: vi.fn(),
		// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
		then: (resolve: (rows: unknown[]) => unknown) =>
			Promise.resolve(selectRows).then(resolve),
	};
	selectQuery.from.mockReturnValue(selectQuery);
	selectQuery.innerJoin.mockReturnValue(selectQuery);
	selectQuery.where.mockReturnValue(selectQuery);
	selectQuery.limit.mockReturnValue(selectQuery);
	const updateQuery = { set: vi.fn(), where: vi.fn() };
	updateQuery.set.mockReturnValue(updateQuery);
	updateQuery.where.mockResolvedValue(undefined);
	return {
		transaction: vi.fn(),
		execute: vi.fn(),
		deleteGarProtectionTag: vi.fn(),
		ensureGarProtectionTag: vi.fn(),
		selectQuery,
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
	ensureGarProtectionTag: mocks.ensureGarProtectionTag,
}));
vi.mock("@/lib/service-revision-changes", () => ({
	parseServiceRevisionSpec: (value: unknown) => value,
}));

import {
	prepareGarArtifactCleanup,
	protectGarRevision,
	releaseGarServiceProtection,
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
		mocks.ensureGarProtectionTag.mockReset();
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

			await expect(prepareGarArtifactCleanup(tx, "service-1")).resolves.toBe(
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

	it("releases each historical GitHub image once, not user-supplied images", async () => {
		mocks.setSelectRows([
			githubRevision("managed/service:revision-1"),
			{ ...githubRevision("managed/service:revision-1"), id: "revision-2" },
			githubRevision("managed/service:revision-3"),
			{
				...githubRevision("external/app:latest"),
				specification: {
					image: "external/app:latest",
					source: { type: "image" },
				},
			},
		]);
		await releaseGarServiceProtection("service-1");
		expect(mocks.deleteGarProtectionTag.mock.calls).toEqual([
			["managed/service:revision-1"],
			["managed/service:revision-3"],
		]);
		expect(mocks.db.update).toHaveBeenCalledTimes(2);
	});

	it("marks only successful releases and retries the remaining image", async () => {
		const first = githubRevision("managed/service:revision-1");
		const second = githubRevision("managed/service:revision-2");
		mocks.setSelectRows([first, second]);
		mocks.deleteGarProtectionTag
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("GAR unavailable"));
		await expect(releaseGarServiceProtection("service-1")).rejects.toThrow(
			"GAR unavailable",
		);
		expect(mocks.db.update).toHaveBeenCalledOnce();
		mocks.setSelectRows([second]);
		await releaseGarServiceProtection("service-1");
		expect(mocks.deleteGarProtectionTag.mock.calls).toEqual([
			[first.specification.image],
			[second.specification.image],
			[second.specification.image],
		]);
		expect(mocks.db.update).toHaveBeenCalledTimes(2);
	});

	it("creates protection inside the service lock transaction", async () => {
		const image = "managed/service:revision-1";
		mocks.setSelectRows([githubRevision(image)]);
		let inTransaction = false;
		mocks.transaction.mockImplementation(async (callback) => {
			inTransaction = true;
			try {
				return await callback(mocks.db);
			} finally {
				inTransaction = false;
			}
		});
		mocks.ensureGarProtectionTag.mockImplementation(async () => {
			expect(inTransaction).toBe(true);
			const lock = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
			expect(lock.sql).toContain("pg_advisory_xact_lock");
			expect(lock.params).toEqual(["service-1"]);
		});
		await expect(
			protectGarRevision("service-1", "revision-1", image),
		).resolves.toBe(true);
		expect(mocks.ensureGarProtectionTag).toHaveBeenCalledWith(image);
	});

	it("does not recreate tags for deleted services or released revisions", async () => {
		mocks.transaction.mockImplementation((callback) => callback(mocks.db));
		await expect(
			protectGarRevision(
				"service-1",
				"revision-1",
				"managed/service:revision-1",
			),
		).resolves.toBe(false);
		const query = new PgDialect().sqlToQuery(
			mocks.selectQuery.where.mock.calls[0][0],
		);
		expect(query.sql).toContain('"services"."deleted_at" is null');
		expect(query.sql).toContain(
			'"service_revisions"."artifact_deleted_at" is null',
		);
		expect(query.params).toEqual(["revision-1", "service-1"]);
		expect(mocks.ensureGarProtectionTag).not.toHaveBeenCalled();
	});

	it("rejects a mismatched artifact before protecting it", async () => {
		mocks.transaction.mockImplementation((callback) => callback(mocks.db));
		mocks.setSelectRows([githubRevision("managed/service:revision-1")]);
		await expect(
			protectGarRevision(
				"service-1",
				"revision-1",
				"managed/service:revision-other",
			),
		).rejects.toThrow("does not match");
		expect(mocks.ensureGarProtectionTag).not.toHaveBeenCalled();
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
