import { describe, expect, it } from "vitest";
import {
	getAgentCompatibilityStatus,
	SERVICE_REVISION_CAPABILITY,
} from "@/lib/agent-capabilities";

describe("agent compatibility", () => {
	it("requires an explicit service revision capability", () => {
		expect(getAgentCompatibilityStatus(null)).toBe("upgrade_required");
		expect(
			getAgentCompatibilityStatus({
				version: "1.0.0",
				uptimeSecs: 10,
				capabilities: ["serverless_gateway"],
			}),
		).toBe("upgrade_required");
	});

	it("accepts agents advertising the revision contract", () => {
		expect(
			getAgentCompatibilityStatus({
				version: "1.0.0",
				uptimeSecs: 10,
				capabilities: [SERVICE_REVISION_CAPABILITY],
			}),
		).toBe("compatible");
	});
});
