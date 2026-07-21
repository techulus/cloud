import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";

const mocks = vi.hoisted(() => {
	const queryResults: unknown[][] = [];

	function createQuery(result: unknown[]) {
		const query = {
			from: vi.fn(() => query),
			where: vi.fn(() => query),
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

	return {
		queryResults,
		db: {
			select: vi.fn(() => createQuery(queryResults.shift() ?? [])),
		},
		requireRequestSession: vi.fn(),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/api-auth", () => ({
	requireRequestSession: mocks.requireRequestSession,
}));

import { GET } from "@/app/api/services/[id]/revisions/route";

function revisionSpec(
	image = "app:v1",
	encryptedValue = "cipher",
): ServiceRevisionSpec {
	return {
		schemaVersion: 2,
		image,
		source: { type: "image", image },
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
		placements: [{ serverId: "server-1", count: 1 }],
		ports: [],
		secrets: [{ key: "TOKEN", encryptedValue, updatedAt: "2026-01-01" }],
		volumes: [],
	};
}

function request(cursor?: string) {
	const url = new URL("http://localhost/api/services/service-1/revisions");
	if (cursor) url.searchParams.set("cursor", cursor);
	return GET(new Request(url), {
		params: Promise.resolve({ id: "service-1" }),
	});
}

describe("service revisions route", () => {
	beforeEach(() => {
		mocks.queryResults.length = 0;
		mocks.db.select.mockClear();
		mocks.requireRequestSession.mockReset();
		mocks.requireRequestSession.mockResolvedValue({
			ok: true,
			session: { user: { id: "user-1" } },
		});
	});

	it("requires authentication", async () => {
		mocks.requireRequestSession.mockResolvedValue({
			ok: false,
			response: Response.json({ message: "Unauthorized" }, { status: 401 }),
		});

		const response = await request();

		expect(response.status).toBe(401);
		expect(mocks.db.select).not.toHaveBeenCalled();
	});

	it("rejects malformed cursors before querying the service", async () => {
		const response = await request("not-a-cursor");

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			message: "Invalid revision cursor",
		});
		expect(mocks.db.select).not.toHaveBeenCalled();
	});

	it("rejects parseable timestamps that PostgreSQL may not accept", async () => {
		const cursor = Buffer.from(
			JSON.stringify({
				createdAt: "Mon Jul 13 2026 02:00:00 GMT+0000",
				id: "revision-1",
			}),
		).toString("base64url");

		const response = await request(cursor);

		expect(response.status).toBe(400);
		expect(mocks.db.select).not.toHaveBeenCalled();
	});

	it("returns safe changes and rollout metadata", async () => {
		mocks.queryResults.push(
			[{ id: "service-1" }],
			[
				{
					id: "revision-2",
					createdAt: new Date("2026-07-13T02:00:00Z"),
					cursorCreatedAt: "2026-07-13 02:00:00+00",
					specification: revisionSpec("app:v2", "secret-new"),
					actor: {
						type: "user",
						userId: "private-user-id",
						name: "Ada Lovelace",
					},
				},
				{
					id: "revision-1",
					createdAt: new Date("2026-07-13T01:00:00Z"),
					cursorCreatedAt: "2026-07-13 01:00:00+00",
					specification: revisionSpec("app:v1", "secret-old"),
					actor: { type: "user", name: "Missing internal ID" },
				},
			],
			[{ id: "server-1", name: "Sydney" }],
			[
				{
					id: "rollout-2",
					serviceRevisionId: "revision-2",
					status: "completed",
					createdAt: new Date("2026-07-13T02:00:00Z"),
				},
			],
		);

		const response = await request();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.revisions[0]).toMatchObject({
			id: "revision-2",
			actor: { type: "user", name: "Ada Lovelace" },
			rollout: { id: "rollout-2", status: "completed" },
			comparison: {
				kind: "changes",
				changes: expect.arrayContaining([
					{ field: "Image", from: "app:v1", to: "app:v2" },
					{ field: "Secret", from: "TOKEN", to: "TOKEN (updated)" },
				]),
			},
		});
		expect(body.revisions[1].comparison).toEqual({ kind: "initial" });
		expect(body.revisions[1].actor).toBeNull();
		expect(JSON.stringify(body)).not.toContain("private-user-id");
		expect(JSON.stringify(body)).not.toContain("secret-new");
		expect(JSON.stringify(body)).not.toContain("secret-old");
		expect(JSON.stringify(body)).not.toContain("specification");
	});

	it("uses the extra revision as the page boundary comparison", async () => {
		const revisions = Array.from({ length: 26 }, (_, index) => ({
			id: `revision-${String(26 - index).padStart(2, "0")}`,
			createdAt: new Date(Date.UTC(2026, 6, 13, 2, 0, 26 - index)),
			cursorCreatedAt: `2026-07-13 02:00:${String(26 - index).padStart(2, "0")}.123456+00`,
			specification: revisionSpec(`app:v${26 - index}`),
		}));
		mocks.queryResults.push([{ id: "service-1" }], revisions, [], []);

		const response = await request();
		const body = await response.json();

		expect(body.revisions).toHaveLength(25);
		expect(body.nextCursor).toEqual(expect.any(String));
		expect(
			JSON.parse(Buffer.from(body.nextCursor, "base64url").toString("utf8")),
		).toMatchObject({ createdAt: expect.stringContaining(".123456") });
		expect(body.revisions[24].comparison).toMatchObject({
			kind: "changes",
			changes: [{ field: "Image", from: "app:v1", to: "app:v2" }],
		});
	});

	it("rejects malformed v1 specifications without exposing their values", async () => {
		mocks.queryResults.push(
			[{ id: "service-1" }],
			[
				{
					id: "revision-2",
					createdAt: new Date("2026-07-13T02:00:00Z"),
					cursorCreatedAt: "2026-07-13 02:00:00+00",
					specification: {
						...revisionSpec(),
						image: { encryptedValue: "must-not-leak" },
					},
				},
				{
					id: "revision-1",
					createdAt: new Date("2026-07-13T01:00:00Z"),
					cursorCreatedAt: "2026-07-13 01:00:00+00",
					specification: revisionSpec(),
				},
			],
			[],
			[],
		);

		const response = await request();
		const body = await response.json();

		expect(body.revisions[0].comparison).toEqual({ kind: "unavailable" });
		expect(JSON.stringify(body)).not.toContain("must-not-leak");
	});
});
