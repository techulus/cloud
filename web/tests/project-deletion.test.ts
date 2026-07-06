import { describe, expect, it } from "vitest";
import { blocksProjectDeletion } from "@/lib/project-deletion";

describe("project deletion guard", () => {
	it("blocks deletion for deployments that still have runtime intent", () => {
		expect(blocksProjectDeletion({ runtimeDesiredState: "running" })).toBe(true);
		expect(blocksProjectDeletion({ runtimeDesiredState: "stopped" })).toBe(true);
		expect(blocksProjectDeletion({ runtimeDesiredState: "removed" })).toBe(
			false,
		);
	});
});
