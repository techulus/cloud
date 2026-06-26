import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	// Results are consumed in the same order as db.select() calls in each test.
	const queryResults: unknown[][] = [];
	const queries: Array<{
		from: ReturnType<typeof vi.fn>;
		innerJoin: ReturnType<typeof vi.fn>;
		where: ReturnType<typeof vi.fn>;
	}> = [];

	function createQuery(result: unknown[]) {
		const query = {
			from: vi.fn(() => query),
			innerJoin: vi.fn(() => query),
			where: vi.fn(() => query),
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) =>
				Promise.resolve(result).then(resolve, reject),
		};

		queries.push(query);
		return query;
	}

	return {
		queryResults,
		queries,
		db: {
			select: vi.fn(() => createQuery(queryResults.shift() ?? [])),
		},
		getSetting: vi.fn(),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/db/queries", () => ({ getSetting: mocks.getSetting }));

import {
	getTargetPlatformsForService,
	selectBuildServerForPlatform,
} from "@/lib/build-assignment";

describe("build assignment", () => {
	beforeEach(() => {
		mocks.queryResults.length = 0;
		mocks.queries.length = 0;
		mocks.db.select.mockClear();
		mocks.getSetting.mockReset();
	});

	function sqlTokens(value: unknown): unknown[] {
		if (!value || typeof value !== "object") {
			return [value];
		}

		const record = value as {
			name?: string;
			queryChunks?: unknown[];
			value?: unknown;
		};

		if (Array.isArray(record.queryChunks)) {
			return record.queryChunks.flatMap(sqlTokens);
		}

		if (Array.isArray(record.value)) {
			return record.value.flatMap(sqlTokens);
		}

		if ("value" in record) {
			return [record.value];
		}

		if (record.name) {
			return [record.name];
		}

		return [];
	}

	function expectActiveReplicaPredicate(queryIndex: number) {
		const condition = mocks.queries[queryIndex]?.where.mock.calls[0]?.[0];
		const tokens = sqlTokens(condition);

		expect(tokens).toEqual(expect.arrayContaining(["service_id", "count", 0]));
		expect(tokens).toContain(" > ");
	}

	it("assigns stateful builds to the active replica server", async () => {
		mocks.queryResults.push(
			[{ id: "service_1", stateful: true }],
			[
				{
					id: "server_target",
					status: "online",
					meta: { arch: "arm64" },
				},
			],
		);

		await expect(
			selectBuildServerForPlatform("service_1", "linux/arm64"),
		).resolves.toBe("server_target");
		expectActiveReplicaPredicate(1);
	});

	it("rejects stateful builds without exactly one active replica server", async () => {
		mocks.queryResults.push([{ id: "service_1", stateful: true }], []);

		await expect(
			selectBuildServerForPlatform("service_1", "linux/arm64"),
		).rejects.toThrow(
			"Stateful services must have exactly one active replica server",
		);
	});

	it("rejects stateful builds with multiple active replica rows", async () => {
		mocks.queryResults.push(
			[{ id: "service_1", stateful: true }],
			[
				{ id: "server_1", status: "online", meta: { arch: "arm64" } },
				{ id: "server_2", status: "online", meta: { arch: "arm64" } },
			],
		);

		await expect(
			selectBuildServerForPlatform("service_1", "linux/arm64"),
		).rejects.toThrow(
			"Stateful services must have exactly one active replica server",
		);
	});

	it("rejects stateful builds when the active replica server is offline", async () => {
		mocks.queryResults.push(
			[{ id: "service_1", stateful: true }],
			[{ id: "server_target", status: "offline", meta: { arch: "arm64" } }],
		);

		await expect(
			selectBuildServerForPlatform("service_1", "linux/arm64"),
		).rejects.toThrow("Stateful service target server is offline");
	});

	it("rejects stateful builds when the active replica arch does not match the requested platform", async () => {
		mocks.queryResults.push(
			[{ id: "service_1", stateful: true }],
			[
				{
					id: "server_target",
					status: "online",
					meta: { arch: "arm64" },
				},
			],
		);

		await expect(
			selectBuildServerForPlatform("service_1", "linux/amd64"),
		).rejects.toThrow(
			"Stateful service target server architecture arm64 does not match platform linux/amd64",
		);
		expectActiveReplicaPredicate(1);
	});

	it("builds a stateful target platform from the active replica server architecture", async () => {
		mocks.queryResults.push(
			[{ id: "service_1", stateful: true }],
			[{ id: "server_target", status: "online", meta: { arch: "arm64" } }],
		);

		await expect(getTargetPlatformsForService("service_1")).resolves.toEqual([
			"linux/arm64",
		]);
		expectActiveReplicaPredicate(1);
	});

	it("rejects stateful target platform resolution when the active replica arch is unknown", async () => {
		mocks.queryResults.push(
			[{ id: "service_1", stateful: true }],
			[{ id: "server_target", status: "online", meta: null }],
		);

		await expect(getTargetPlatformsForService("service_1")).rejects.toThrow(
			"Stateful service target server architecture is unknown",
		);
	});

	it("keeps stateless builds assigned by matching architecture", async () => {
		mocks.getSetting.mockResolvedValue(null);
		mocks.queryResults.push(
			[{ id: "service_1", stateful: false }],
			[
				{ id: "server_amd", meta: { arch: "amd64" } },
				{ id: "server_arm", meta: { arch: "arm64" } },
			],
		);

		await expect(
			selectBuildServerForPlatform("service_1", "linux/arm64"),
		).resolves.toBe("server_arm");
	});

	it("limits stateless build assignment to allowed build servers", async () => {
		mocks.getSetting.mockResolvedValue(["server_arm"]);
		mocks.queryResults.push(
			[{ id: "service_1", stateful: false }],
			[{ id: "server_arm", meta: { arch: "arm64" } }],
		);

		await expect(
			selectBuildServerForPlatform("service_1", "linux/arm64"),
		).resolves.toBe("server_arm");

		const condition = mocks.queries[1]?.where.mock.calls[0]?.[0];
		expect(sqlTokens(condition)).toEqual(
			expect.arrayContaining(["status", "online", "id", " in "]),
		);
	});

	it("builds target platforms from active replica server architectures", async () => {
		mocks.queryResults.push(
			[{ id: "service_1" }],
			[{ meta: { arch: "arm64" } }, { meta: { arch: "arm64" } }],
		);

		await expect(getTargetPlatformsForService("service_1")).resolves.toEqual([
			"linux/arm64",
		]);
		expectActiveReplicaPredicate(1);
	});
});
