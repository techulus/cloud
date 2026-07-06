import { describe, expect, it } from "vitest";
import { blocksProjectDeletion } from "@/lib/project-deletion";

describe("project deletion guard", () => {
	it("blocks deletion for desired deployments regardless of lifecycle status", () => {
		expect(blocksProjectDeletion({ desired: true })).toBe(true);
		expect(blocksProjectDeletion({ desired: false })).toBe(false);
	});
});
