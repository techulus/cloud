import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	verifyAgentRequest: vi.fn(),
	waitForAgentGeneration: vi.fn(),
}));

vi.mock("@/lib/agent-auth", () => ({
	verifyAgentRequest: mocks.verifyAgentRequest,
}));
vi.mock("@/lib/agent-wake", () => ({
	waitForAgentGeneration: mocks.waitForAgentGeneration,
}));

import { GET } from "@/app/api/v1/agent/wake/route";

describe("agent wake route", () => {
	beforeEach(() => {
		mocks.verifyAgentRequest.mockReset();
		mocks.waitForAgentGeneration.mockReset();
		mocks.verifyAgentRequest.mockResolvedValue({
			success: true,
			serverId: "server-1",
			serverName: "Server 1",
		});
	});

	it("rejects a malformed generation cursor", async () => {
		const response = await GET(
			new NextRequest("http://localhost/api/v1/agent/wake?generation=1.5"),
		);

		expect(response.status).toBe(400);
		expect(mocks.waitForAgentGeneration).not.toHaveBeenCalled();
	});

	it("returns the advanced generation", async () => {
		mocks.waitForAgentGeneration.mockResolvedValue({
			kind: "advanced",
			generation: 12,
		});
		const response = await GET(
			new NextRequest("http://localhost/api/v1/agent/wake?generation=11"),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ generation: 12 });
	});
});
