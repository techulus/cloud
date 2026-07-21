import { describe, expect, it } from "vitest";
import {
	decodeTimestampCursor,
	namedPage,
	nextNamedCursor,
	nextTimestampCursor,
	timestampPage,
} from "@/lib/public-api-pagination";

function pageUrl(parameters = "") {
	return new URL(`https://cloud.example/api/v1/projects${parameters}`);
}

describe("public API named keyset pagination", () => {
	it("round-trips the final visible name and id, including equal-name ties", () => {
		const items = [
			{ name: "alpha", id: "project-1" },
			{ name: "same", id: "project-2" },
			{ name: "same", id: "project-3" },
		];
		const cursor = nextNamedCursor(items, 2);

		expect(cursor).toEqual(expect.any(String));
		expect(namedPage(pageUrl(`?limit=2&cursor=${cursor}`))).toEqual({
			limit: 2,
			cursor: { name: "same", id: "project-2" },
		});
	});

	it("only emits a cursor when an extra row proves another page exists", () => {
		expect(nextNamedCursor([{ name: "alpha", id: "1" }], 1)).toBeNull();
		expect(
			nextNamedCursor(
				[
					{ name: "alpha", id: "1" },
					{ name: "beta", id: "2" },
				],
				1,
			),
		).toEqual(expect.any(String));
	});

	it.each([
		"0",
		"101",
		"1.5",
		"NaN",
		"",
	])("rejects an invalid limit of %j", (limit) => {
		expect(() => namedPage(pageUrl(`?limit=${limit}`))).toThrow(
			"limit must be an integer from 1 to 100",
		);
	});

	it("accepts limit boundaries and defaults to 100", () => {
		expect(namedPage(pageUrl()).limit).toBe(100);
		expect(namedPage(pageUrl("?limit=1")).limit).toBe(1);
		expect(namedPage(pageUrl("?limit=100")).limit).toBe(100);
	});

	it.each([
		"not+base64url",
		Buffer.from("not json").toString("base64url"),
		Buffer.from(JSON.stringify({ name: "alpha" })).toString("base64url"),
		Buffer.from(JSON.stringify({ name: "alpha", id: "" })).toString(
			"base64url",
		),
		"a".repeat(2049),
	])("rejects malformed cursors", (cursor) => {
		expect(() => namedPage(pageUrl(`?cursor=${cursor}`))).toThrow(
			"Invalid cursor",
		);
	});
});

describe("public API timestamp keyset pagination", () => {
	it("preserves the database timestamp precision in emitted cursors", () => {
		const cursor = nextTimestampCursor(
			[
				{
					id: "build-1",
					cursorCreatedAt: "2026-07-20 12:00:00.123456+00",
				},
				{
					id: "build-2",
					cursorCreatedAt: "2026-07-20 12:00:00.123400+00",
				},
			],
			1,
		);

		expect(decodeTimestampCursor(cursor)).toEqual({
			id: "build-1",
			createdAt: "2026-07-20 12:00:00.123456+00",
		});
	});

	it("round-trips valid PostgreSQL and RFC 3339 timestamp forms", () => {
		for (const createdAt of [
			"2026-07-20 12:00:00.123456+00",
			"2026-07-20T12:00:00.123456Z",
			"2026-07-20T12:00:00-04:30",
		]) {
			const cursor = Buffer.from(
				JSON.stringify({ id: "rollout-1", createdAt }),
			).toString("base64url");
			expect(
				timestampPage(pageUrl(`?limit=1&cursor=${cursor}`)).cursor,
			).toEqual({ id: "rollout-1", createdAt });
		}
	});

	it.each([
		"2026-02-29T00:00:00Z",
		"2026-02-31T00:00:00Z",
		"0000-01-01T00:00:00Z",
		"2026-01-01T24:00:00Z",
		"2026-01-01T00:00:60Z",
		"2026-01-01T00:00:00+14:01",
	])("rejects an invalid timestamp without sending it to PostgreSQL: %s", (createdAt) => {
		const cursor = Buffer.from(
			JSON.stringify({ id: "rollout-1", createdAt }),
		).toString("base64url");
		expect(() => timestampPage(pageUrl(`?cursor=${cursor}`))).toThrow(
			"Invalid cursor",
		);
	});

	it.each([
		"not+base64url",
		Buffer.from("not json").toString("base64url"),
		"a".repeat(2049),
	])("rejects a malformed timestamp cursor", (cursor) => {
		expect(() => timestampPage(pageUrl(`?cursor=${cursor}`))).toThrow(
			"Invalid cursor",
		);
	});
});
