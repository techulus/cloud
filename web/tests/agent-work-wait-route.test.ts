import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	verifyAgentRequest: vi.fn(),
	hasClaimableWork: vi.fn(),
	subscribeToWorkNotifications: vi.fn(),
	wait: vi.fn(),
	close: vi.fn(),
}));

vi.mock("@/lib/agent-auth", () => ({
	verifyAgentRequest: mocks.verifyAgentRequest,
}));
vi.mock("@/lib/work-queue", () => ({
	hasClaimableWork: mocks.hasClaimableWork,
}));
vi.mock("@/lib/work-queue-notifications", () => ({
	subscribeToWorkNotifications: mocks.subscribeToWorkNotifications,
}));

import { GET } from "@/app/api/v1/agent/work/wait/route";

describe("agent work wait route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.verifyAgentRequest.mockResolvedValue({
			success: true,
			serverId: "server-1",
			serverName: "Server 1",
		});
		mocks.subscribeToWorkNotifications.mockResolvedValue({
			wait: mocks.wait,
			close: mocks.close,
		});
		mocks.wait.mockResolvedValue("timeout");
	});

	it("returns authentication failures without subscribing", async () => {
		mocks.verifyAgentRequest.mockResolvedValue({
			success: false,
			error: "Invalid signature",
			status: 401,
		});

		const response = await GET(request());

		expect(response.status).toBe(401);
		expect(mocks.subscribeToWorkNotifications).not.toHaveBeenCalled();
	});

	it("returns immediately when durable work is already claimable", async () => {
		mocks.hasClaimableWork.mockResolvedValue(true);

		const response = await GET(request());

		await expect(response.json()).resolves.toEqual({ workAvailable: true });
		expect(mocks.wait).not.toHaveBeenCalled();
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("rechecks durable work after a notification", async () => {
		mocks.hasClaimableWork
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		mocks.wait.mockResolvedValue("notified");

		const response = await GET(request());

		await expect(response.json()).resolves.toEqual({ workAvailable: true });
		expect(mocks.hasClaimableWork).toHaveBeenCalledTimes(2);
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("returns false after an empty wait", async () => {
		mocks.hasClaimableWork.mockResolvedValue(false);

		const response = await GET(request());

		await expect(response.json()).resolves.toEqual({ workAvailable: false });
		expect(mocks.hasClaimableWork).toHaveBeenCalledTimes(2);
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("signals notification listener failure separately from an empty wait", async () => {
		mocks.hasClaimableWork.mockResolvedValue(false);
		mocks.wait.mockResolvedValue("unavailable");

		const response = await GET(request());

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("1");
		await expect(response.json()).resolves.toEqual({
			error: "Work queue notifications unavailable",
		});
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("signals listener setup failure while preserving queued work", async () => {
		mocks.subscribeToWorkNotifications.mockRejectedValue(
			new Error("listener unavailable"),
		);
		mocks.hasClaimableWork.mockResolvedValueOnce(false);

		const unavailableResponse = await GET(request());
		expect(unavailableResponse.status).toBe(503);

		mocks.hasClaimableWork.mockResolvedValueOnce(true);
		const availableResponse = await GET(request());
		await expect(availableResponse.json()).resolves.toEqual({
			workAvailable: true,
		});
	});

	it("cleans up when the request is aborted", async () => {
		mocks.hasClaimableWork.mockResolvedValue(false);
		mocks.wait.mockImplementation(
			(_timeoutMs: number, signal: AbortSignal) =>
				new Promise<string>((resolve) => {
					signal.addEventListener("abort", () => resolve("aborted"), {
						once: true,
					});
				}),
		);
		const controller = new AbortController();
		const responsePromise = GET(request(controller.signal));
		await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledOnce());

		controller.abort();
		const response = await responsePromise;

		expect(response.status).toBe(499);
		expect(mocks.close).toHaveBeenCalledOnce();
	});
});

function request(signal?: AbortSignal) {
	return new NextRequest("http://localhost/api/v1/agent/work/wait", { signal });
}
