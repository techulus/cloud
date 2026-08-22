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
		reportOperationFailure: vi.fn(),
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
vi.mock("@/lib/server-errors", () => ({
	reportOperationFailure: mocks.reportOperationFailure,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { POST } from "@/app/api/v1/agent/backup/failed/route";

function request() {
	return new Request("http://localhost/api/v1/agent/backup/failed", {
		method: "POST",
		body: JSON.stringify({
			backupId: "backup-1",
			error: "upload failed",
		}),
	}) as NextRequest;
}

describe("agent backup failure", () => {
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
		expect(mocks.reportOperationFailure).toHaveBeenCalledWith("backup.failed", {
			occurrenceId: "backup-1",
			reason: "agent_reported_failure",
			tags: {
				backupId: "backup-1",
				serviceId: "service-1",
				serverId: "server-1",
			},
		});
		expect(mocks.send).toHaveBeenCalledWith({
			name: "resource/status.changed",
			id: "backup-failed-backup-1",
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
		expect(mocks.reportOperationFailure).not.toHaveBeenCalled();
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	});
});
