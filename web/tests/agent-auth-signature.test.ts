import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	verifyEd25519Signature: vi.fn(),
}));

vi.mock("@/db", () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn().mockResolvedValue([
					{
						id: "server-1",
						name: "Worker 1",
						signingPublicKey: "public-key",
					},
				]),
			})),
		})),
	},
}));
vi.mock("@/lib/crypto", () => ({
	verifyEd25519Signature: mocks.verifyEd25519Signature,
}));

import { verifyAgentRequest } from "@/lib/agent-auth";

describe("agent request signatures", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.verifyEd25519Signature.mockReturnValue(true);
	});

	it("binds the signature to the method, path, query, and body", async () => {
		const timestamp = String(Date.now());
		const request = new NextRequest(
			"https://control.example/api/v1/agent/status?mode=full",
			{
				method: "POST",
				headers: {
					"x-server-id": "server-1",
					"x-timestamp": timestamp,
					"x-signature": "signature",
				},
			},
		);

		await expect(
			verifyAgentRequest(request, '{"ready":true}'),
		).resolves.toMatchObject({ success: true, serverId: "server-1" });
		expect(mocks.verifyEd25519Signature).toHaveBeenCalledWith(
			"public-key",
			`agent-request:v2\0${timestamp}\0POST\0/api/v1/agent/status?mode=full\0{"ready":true}`,
			"signature",
		);
	});
});
