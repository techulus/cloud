import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	buildAgentExpectedState: vi.fn(),
	getServer: vi.fn(),
	verifyAgentRequest: vi.fn(),
}));

vi.mock("@/lib/agent/expected-state", () => ({
	buildAgentExpectedState: mocks.buildAgentExpectedState,
	getServer: mocks.getServer,
}));
vi.mock("@/lib/agent-auth", () => ({
	verifyAgentRequest: mocks.verifyAgentRequest,
}));

import { GET } from "@/app/api/v1/agent/expected-state/route";

describe("agent expected-state route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.EXPECTED_STATE_MAINTENANCE_MODE;
		mocks.verifyAgentRequest.mockResolvedValue({
			success: true,
			serverId: "server-1",
		});
		mocks.getServer.mockResolvedValue({
			id: "server-1",
			agentHealth: { version: "old", uptimeSecs: 60, capabilities: [] },
		});
	});

	it("returns a structured 426 for an incompatible agent", async () => {
		const response = await GET(
			new NextRequest("http://localhost/api/v1/agent/expected-state"),
		);

		expect(response.status).toBe(426);
		expect(await response.json()).toEqual({
			error: "Agent upgrade required",
			code: "AGENT_UPGRADE_REQUIRED",
			requiredCapabilities: ["service_revision_v1"],
		});
		expect(mocks.buildAgentExpectedState).not.toHaveBeenCalled();
	});

	it("pauses expected state during the maintenance window", async () => {
		process.env.EXPECTED_STATE_MAINTENANCE_MODE = "true";
		mocks.getServer.mockResolvedValue({
			id: "server-1",
			agentHealth: {
				version: "new",
				uptimeSecs: 60,
				capabilities: ["service_revision_v1"],
			},
		});

		const response = await GET(
			new NextRequest("http://localhost/api/v1/agent/expected-state"),
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("30");
		expect(await response.json()).toMatchObject({
			code: "EXPECTED_STATE_MAINTENANCE",
		});
	});

	it("returns a structured retryable error when state construction fails", async () => {
		mocks.getServer.mockResolvedValue({
			id: "server-1",
			agentHealth: {
				version: "new",
				uptimeSecs: 60,
				capabilities: ["service_revision_v1"],
			},
		});
		mocks.buildAgentExpectedState.mockRejectedValue(
			new Error("incomplete port allocation"),
		);

		const response = await GET(
			new NextRequest("http://localhost/api/v1/agent/expected-state"),
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("15");
		expect(await response.json()).toMatchObject({
			code: "EXPECTED_STATE_BUILD_FAILED",
		});
	});
});
