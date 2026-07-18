import { describe, expect, it } from "vitest";
import { isFullCommitSha } from "@/lib/github";

describe("GitHub commit SHA validation", () => {
	it("accepts only full hexadecimal commit SHAs", () => {
		expect(isFullCommitSha("0123456789abcdef0123456789abcdef01234567")).toBe(
			true,
		);
		expect(isFullCommitSha("0123456789ABCDEF0123456789ABCDEF01234567")).toBe(
			true,
		);
		expect(isFullCommitSha("0123456")).toBe(false);
		expect(isFullCommitSha("--upload-pack=/tmp/exploit")).toBe(false);
		expect(isFullCommitSha("g123456789abcdef0123456789abcdef01234567")).toBe(
			false,
		);
	});
});
