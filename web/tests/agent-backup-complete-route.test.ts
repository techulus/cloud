import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const updateResults: unknown[][] = [];
	function updateQuery(result: unknown[]) {
		const query = {
			set: vi.fn(() => query),
			where: vi.fn(() => query),
			returning: vi.fn(() => query),
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return query;
	}
	return {
		updateResults,
		db: {
			update: vi.fn(() => updateQuery(updateResults.shift() ?? [])),
		},
		verifyAgentRequest: vi.fn(),
		revalidatePath: vi.fn(),
		send: vi.fn(),
		createResourceStatusChanged: vi.fn((data, options) => ({
			name: "resource/status.changed",
			data,
			...options,
		})),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/agent-auth", () => ({
	verifyAgentRequest: mocks.verifyAgentRequest,
}));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		resourceStatusChanged: { create: mocks.createResourceStatusChanged },
	},
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { POST } from "@/app/api/v1/agent/backup/complete/route";

function request() {
	return new Request("http://localhost/api/v1/agent/backup/complete", {
		method: "POST",
		body: JSON.stringify({
			backupId: "backup-1",
			sizeBytes: 1024,
			checksum: "sha256:checksum",
		}),
	}) as NextRequest;
}

describe("agent backup completion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.updateResults.length = 0;
		mocks.verifyAgentRequest.mockResolvedValue({
			success: true,
			serverId: "server-1",
		});
		mocks.send.mockResolvedValue(undefined);
	});

	it("emits one deduplicated event after a real transition", async () => {
		mocks.updateResults.push([{ serviceId: "service-1" }]);

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/projects");
		expect(mocks.send).toHaveBeenCalledWith({
			name: "resource/status.changed",
			id: "backup-completed-backup-1",
			data: {
				type: "backup",
				id: "backup-1",
				parentType: "service",
				parentId: "service-1",
			},
		});
	});

	it("treats a replay as a successful no-op", async () => {
		mocks.updateResults.push([]);

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	});
});
