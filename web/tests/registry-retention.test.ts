import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	let buildRows: Array<{ imageUri: string | null }> = [];
	let serviceRows: unknown[] = [];
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
		db: {
			select: vi.fn((selection?: Record<string, unknown>) => {
				selectRows = selection
					? "imageUri" in selection
						? buildRows
						: [{ id: "revision-1" }]
					: serviceRows;
				return selectQuery;
			}),
			update: vi.fn(() => updateQuery),
			execute: vi.fn((...args: unknown[]) => mocks.execute(...args)),
			transaction: vi.fn((...args: unknown[]) => mocks.transaction(...args)),
		},
		updateQuery,
		setBuildRows: (rows: Array<{ imageUri: string | null }>) => {
			buildRows = rows;
		},
		setServiceRows: (rows: unknown[]) => {
			serviceRows = rows;
		},
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/service-revision-changes", () => ({
	parseServiceRevisionSpec: (value: unknown) => value,
}));

import {
	cleanupRegistryArtifactsDaily,
	cleanupRegistryArtifactsForService,
	cleanupRevisionArtifact,
	prepareRegistryArtifactCleanup,
} from "@/lib/registry-retention";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const githubRevision = (image: string) => ({
	id: "revision-1",
	serviceId: "service-1",
	artifactDeletedAt: null,
	specification: { image, source: { type: "github" } },
});
const response = (status: number) => new Response(null, { status });

describe("registry retention", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		mocks.setBuildRows([]);
		mocks.setServiceRows([]);
		mocks.db.select.mockClear();
		mocks.db.update.mockClear();
		mocks.execute.mockReset();
		mocks.transaction.mockReset();
		mocks.updateQuery.set.mockClear();
		mocks.updateQuery.where.mockClear();
		process.env.REGISTRY_URL = "http://registry:5000";
		process.env.REGISTRY_HOST = "https://Registry.Example.com:5443";
		process.env.REGISTRY_USERNAME = "retention";
		process.env.REGISTRY_PASSWORD = "secret";
	});

	it("routes a public registry reference through the internal API", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(response(202));

		await cleanupRevisionArtifact(
			githubRevision("registry.example.com:5443/team/a b:final"),
		);

		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"http://registry:5000/v2/team/a%20b/manifests/final",
			expect.objectContaining({
				method: "DELETE",
				headers: expect.objectContaining({
					Accept: expect.stringContaining(
						"application/vnd.oci.image.index.v1+json",
					),
					Authorization: `Basic ${Buffer.from("retention:secret").toString("base64")}`,
				}),
			}),
		);
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

			await expect(
				prepareRegistryArtifactCleanup(tx, "service-1"),
			).resolves.toBe(ready);
			expect(update.set).toHaveBeenCalledWith({ status: "failed" });
			expect(update.where).toHaveBeenCalledOnce();
			expect(select.limit).toHaveBeenCalledWith(1);
		},
	);

	it("does not delete an old revision artifact shared with a protected newer revision", async () => {
		mocks.execute.mockResolvedValue({
			rows: [
				{
					id: "revision-old",
					serviceId: "service-1",
					image: "registry.example.com:5443/team/app:shared",
					specification: {
						image: "registry.example.com:5443/team/app:shared",
						source: { type: "github" },
					},
					artifactDeletedAt: null,
				},
			],
		});
		mocks.transaction.mockImplementation(async (callback) =>
			callback({
				execute: vi
					.fn()
					.mockResolvedValueOnce({ rows: [] })
					// Full locked recheck returns no rows because the newer
					// same-image revision is in the protected completed set.
					.mockResolvedValueOnce({ rows: [] }),
			}),
		);
		const fetchMock = vi.spyOn(globalThis, "fetch");

		await cleanupRegistryArtifactsDaily();

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("deletes only the modern final tag and leaves digest build children for GC", async () => {
		mocks.setBuildRows([
			{ imageUri: `registry.example.com:5443/team/app@${digest("b")}` },
		]);
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(response(202));

		await cleanupRevisionArtifact(
			githubRevision("registry.example.com:5443/team/app:final"),
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
		expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/manifests\/final$/);
		expect(fetchMock.mock.calls.flat().join(" ")).not.toContain(digest("b"));
	});

	it("deletes the final tag then unique legacy architecture tags", async () => {
		mocks.setBuildRows([
			{ imageUri: "registry.example.com:5443/team/app:final" },
			{ imageUri: "registry.example.com:5443/team/app:amd64" },
			{ imageUri: "registry.example.com:5443/team/app:arm64" },
			{ imageUri: "registry.example.com:5443/team/app:amd64" },
		]);
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(response(202));

		await cleanupRevisionArtifact(
			githubRevision("registry.example.com:5443/team/app:final"),
		);

		expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
			"DELETE",
			"DELETE",
			"DELETE",
		]);
		expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
			"http://registry:5000/v2/team/app/manifests/final",
			"http://registry:5000/v2/team/app/manifests/amd64",
			"http://registry:5000/v2/team/app/manifests/arm64",
		]);
	});

	it("treats a missing tag as deleted and marks the revision", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response(404));

		await expect(
			cleanupRevisionArtifact(
				githubRevision("registry.example.com:5443/team/app:gone"),
			),
		).resolves.toBe(true);
		expect(mocks.db.update).toHaveBeenCalledOnce();
	});

	it.each([405, 500])(
		"does not mark when registry tag deletion returns %s",
		async (status) => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(response(status));
			await expect(
				cleanupRevisionArtifact(
					githubRevision("registry.example.com:5443/team/app:final"),
				),
			).rejects.toThrow("DELETE failed");
			expect(mocks.db.update).not.toHaveBeenCalled();
		},
	);

	it("rejects a digest-addressed final image without network access", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		await expect(
			cleanupRevisionArtifact(
				githubRevision(`registry.example.com:5443/team/app@${digest("a")}`),
			),
		).rejects.toThrow("must use a tag");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(mocks.db.update).not.toHaveBeenCalled();
	});

	it("rejects external images without network access", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		await expect(
			cleanupRevisionArtifact(githubRevision("evil.example/team/app:final")),
		).rejects.toThrow("unmanaged");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("ignores non-GitHub external image revisions", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		await expect(
			cleanupRevisionArtifact({
				...githubRevision("evil.example/team/app:final"),
				specification: {
					image: "evil.example/team/app:final",
					source: { type: "image", image: "evil.example/team/app:final" },
				},
			}),
		).resolves.toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(mocks.db.update).not.toHaveBeenCalled();
	});

	it("uses a GitHub representative when an external revision shares its image", async () => {
		const image = "registry.example.com:5443/team/app:shared";
		mocks.setServiceRows([
			{
				...githubRevision(image),
				id: "external-revision",
				specification: { image, source: { type: "image", image } },
			},
			{ ...githubRevision(image), id: "github-revision" },
		]);
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(response(202));

		await cleanupRegistryArtifactsForService("service-1");

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/manifests\/shared$/);
		expect(mocks.db.update).toHaveBeenCalledOnce();
	});
});
