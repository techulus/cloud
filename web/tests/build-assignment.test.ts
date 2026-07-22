import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";

const mocks = vi.hoisted(() => {
	const queryResults: unknown[][] = [];
	const queries: Array<{ where: ReturnType<typeof vi.fn> }> = [];
	function createQuery(result: unknown[]) {
		const query = {
			from: vi.fn(() => query),
			where: vi.fn(() => query),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
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
	getTargetPlatformsForRevision,
	selectBuildServerForRevision,
} from "@/lib/build-assignment";

function specification(
	overrides: Partial<ServiceRevisionSpec> = {},
): ServiceRevisionSpec {
	return {
		schemaVersion: 3,
		placement: { mode: "manual" },
		image: "registry/app:revision-1",
		source: { type: "image", image: "registry/app:revision-1" },
		hostname: "app",
		stateful: false,
		serverless: {
			enabled: false,
			sleepAfterSeconds: 300,
			wakeTimeoutSeconds: 300,
		},
		healthCheck: null,
		startCommand: null,
		resourceLimits: { cpuCores: null, memoryMb: null },
		placements: [{ serverId: "server-target", count: 1 }],
		ports: [],
		secrets: [],
		volumes: [],
		...overrides,
	};
}

function sqlTokens(value: unknown): unknown[] {
	if (!value || typeof value !== "object") return [value];
	const record = value as {
		name?: string;
		queryChunks?: unknown[];
		value?: unknown;
	};
	if (Array.isArray(record.queryChunks)) {
		return record.queryChunks.flatMap(sqlTokens);
	}
	if (Array.isArray(record.value)) return record.value.flatMap(sqlTokens);
	if ("value" in record) return [record.value];
	return record.name ? [record.name] : [];
}

describe("revision-backed build assignment", () => {
	beforeEach(() => {
		mocks.queryResults.length = 0;
		mocks.queries.length = 0;
		mocks.db.select.mockClear();
		mocks.getSetting.mockReset();
	});

	it("assigns a stateful build to its snapshotted placement server", async () => {
		mocks.queryResults.push([
			{ id: "server-target", status: "online", meta: { arch: "arm64" } },
		]);

		await expect(
			selectBuildServerForRevision(
				specification({ stateful: true }),
				"linux/arm64",
			),
		).resolves.toBe("server-target");
	});

	it("rejects an invalid stateful placement without reading mutable service rows", async () => {
		await expect(
			selectBuildServerForRevision(
				specification({ stateful: true, placements: [] }),
				"linux/arm64",
			),
		).rejects.toThrow(
			"Stateful service revisions must have exactly one active replica server",
		);
		expect(mocks.db.select).not.toHaveBeenCalled();
	});

	it("rejects an offline stateful revision target", async () => {
		mocks.queryResults.push([
			{ id: "server-target", status: "offline", meta: { arch: "arm64" } },
		]);
		await expect(
			selectBuildServerForRevision(
				specification({ stateful: true }),
				"linux/arm64",
			),
		).rejects.toThrow("Stateful service target server is offline");
	});

	it("rejects a stateful platform that differs from the revision target", async () => {
		mocks.queryResults.push([
			{ id: "server-target", status: "online", meta: { arch: "arm64" } },
		]);
		await expect(
			selectBuildServerForRevision(
				specification({ stateful: true }),
				"linux/amd64",
			),
		).rejects.toThrow(
			"Stateful service target server architecture arm64 does not match platform linux/amd64",
		);
	});

	it("derives a stateful target platform from the revision placement", async () => {
		mocks.queryResults.push([
			{ id: "server-target", status: "online", meta: { arch: "arm64" } },
		]);
		await expect(
			getTargetPlatformsForRevision(specification({ stateful: true })),
		).resolves.toEqual(["linux/arm64"]);
	});

	it("assigns stateless builds to an online server with the requested architecture", async () => {
		mocks.getSetting.mockResolvedValue(null);
		mocks.queryResults.push([
			{ id: "server-amd", meta: { arch: "amd64" } },
			{ id: "server-arm", meta: { arch: "arm64" } },
		]);
		await expect(
			selectBuildServerForRevision(specification(), "linux/arm64"),
		).resolves.toBe("server-arm");
	});

	it("limits stateless build assignment to configured build servers", async () => {
		mocks.getSetting.mockResolvedValue(["server-arm"]);
		mocks.queryResults.push([{ id: "server-arm", meta: { arch: "arm64" } }]);
		await expect(
			selectBuildServerForRevision(specification(), "linux/arm64"),
		).resolves.toBe("server-arm");

		const condition = mocks.queries[0]?.where.mock.calls[0]?.[0];
		expect(sqlTokens(condition)).toEqual(
			expect.arrayContaining(["status", "online", "id", " in "]),
		);
	});

	it("derives stateless target platforms from snapshotted placements", async () => {
		mocks.queryResults.push([
			{ id: "server-a", meta: { arch: "arm64" } },
			{ id: "server-b", meta: { arch: "arm64" } },
		]);
		await expect(
			getTargetPlatformsForRevision(
				specification({
					placements: [
						{ serverId: "server-a", count: 1 },
						{ serverId: "server-b", count: 1 },
					],
				}),
			),
		).resolves.toEqual(["linux/arm64"]);
	});

	it("uses both default platforms for an unplaced build revision", async () => {
		await expect(
			getTargetPlatformsForRevision(specification({ placements: [] })),
		).resolves.toEqual(["linux/amd64", "linux/arm64"]);
		expect(mocks.db.select).not.toHaveBeenCalled();
	});
});
