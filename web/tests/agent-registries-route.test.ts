import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	verifyAgentRequest: vi.fn(),
	getRegistryBundle: vi.fn(),
}));

vi.mock("@/lib/agent-auth", () => ({
	verifyAgentRequest: mocks.verifyAgentRequest,
}));
vi.mock("@/lib/registry-credentials", () => ({
	getRegistryBundle: mocks.getRegistryBundle,
}));

import { GET } from "@/app/api/v1/agent/registries/route";

function request() {
	return new Request("http://localhost/api/v1/agent/registries") as NextRequest;
}

describe("agent registry bundle endpoint", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("requires a signed agent request and never reads credentials on failure", async () => {
		mocks.verifyAgentRequest.mockResolvedValue({
			success: false,
			status: 401,
			error: "Invalid signature",
		});

		const response = await GET(request());

		expect(response.status).toBe(401);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("pragma")).toBe("no-cache");
		expect(mocks.getRegistryBundle).not.toHaveBeenCalled();
	});

	it("returns the complete encrypted desired state without caching", async () => {
		mocks.verifyAgentRequest.mockResolvedValue({
			success: true,
			serverId: "server-1",
		});
		mocks.getRegistryBundle.mockResolvedValue({
			version: "opaque-version",
			registries: [
				{
					id: "credential-1",
					host: "registry.example.com",
					authKey: "registry.example.com",
					username: "robot",
					encryptedPassword: "ciphertext",
					tlsVerify: true,
					system: false,
				},
			],
		});

		const response = await GET(request());

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("pragma")).toBe("no-cache");
		expect(await response.json()).toEqual({
			version: "opaque-version",
			registries: [
				{
					id: "credential-1",
					host: "registry.example.com",
					authKey: "registry.example.com",
					username: "robot",
					encryptedPassword: "ciphertext",
					tlsVerify: true,
					system: false,
				},
			],
		});
	});
});
