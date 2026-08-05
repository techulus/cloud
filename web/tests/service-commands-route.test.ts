import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const queryResults: unknown[][] = [];

	function createQuery(result: unknown[]) {
		const query = {
			from: vi.fn(() => query),
			innerJoin: vi.fn(() => query),
			where: vi.fn(() => query),
			orderBy: vi.fn(() => query),
			limit: vi.fn(() => query),
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return query;
	}

	const insertValues = vi.fn().mockResolvedValue(undefined);
	const tx = {
		insert: vi.fn(() => ({ values: insertValues })),
	};

	return {
		queryResults,
		insertValues,
		tx,
		db: {
			select: vi.fn(() => createQuery(queryResults.shift() ?? [])),
			transaction: vi.fn(
				async (callback: (transaction: typeof tx) => Promise<unknown>) =>
					callback(tx),
			),
		},
		requireRequestDeveloperRole: vi.fn(),
		enqueueWork: vi.fn(),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/api-auth", () => ({
	requireRequestDeveloperRole: mocks.requireRequestDeveloperRole,
}));
vi.mock("@/lib/work-queue", () => ({ enqueueWork: mocks.enqueueWork }));

import { GET, POST } from "@/app/api/services/[id]/commands/route";

const routeParams = { params: Promise.resolve({ id: "service-1" }) };

function post(body: unknown) {
	return POST(
		new Request("http://localhost/api/services/service-1/commands", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		routeParams,
	);
}

describe("service commands route", () => {
	beforeEach(() => {
		mocks.queryResults.length = 0;
		mocks.db.select.mockClear();
		mocks.db.transaction.mockClear();
		mocks.tx.insert.mockClear();
		mocks.insertValues.mockClear();
		mocks.enqueueWork.mockReset();
		mocks.enqueueWork.mockResolvedValue(undefined);
		mocks.requireRequestDeveloperRole.mockReset();
		mocks.requireRequestDeveloperRole.mockResolvedValue({
			ok: true,
			session: { user: { id: "user-1", name: "Ada" } },
		});
	});

	it("requires a developer role before reading history", async () => {
		mocks.requireRequestDeveloperRole.mockResolvedValue({
			ok: false,
			response: Response.json({ error: "Forbidden" }, { status: 403 }),
		});

		const response = await GET(
			new Request("http://localhost/api/services/service-1/commands"),
			routeParams,
		);

		expect(response.status).toBe(403);
		expect(mocks.db.select).not.toHaveBeenCalled();
	});

	it("rejects invalid commands before querying a target", async () => {
		const response = await post({ deploymentId: "deployment-1", command: " " });

		expect(response.status).toBe(400);
		expect(mocks.db.select).not.toHaveBeenCalled();
		expect(mocks.enqueueWork).not.toHaveBeenCalled();
	});

	it("stores the actor and queues the validated target transactionally", async () => {
		mocks.queryResults.push(
			[{ id: "service-1" }],
			[
				{
					deploymentId: "deployment-1",
					serverId: "server-1",
					serverName: "Sydney",
					containerId: "container-1",
				},
			],
		);

		const response = await post({
			deploymentId: "deployment-1",
			command: "printf hello",
			serviceId: "attacker-controlled-service",
		});
		const body = (await response.json()) as { id: string; status: string };

		expect(response.status).toBe(202);
		expect(body.status).toBe("pending");
		expect(mocks.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				id: body.id,
				serviceId: "service-1",
				deploymentId: "deployment-1",
				containerId: "container-1",
				actor: { id: "user-1", name: "Ada" },
				command: "printf hello",
			}),
		);
		expect(mocks.enqueueWork).toHaveBeenCalledWith(
			"server-1",
			"command",
			{
				commandRunId: body.id,
				serviceId: "service-1",
				deploymentId: "deployment-1",
				containerId: "container-1",
				command: "printf hello",
			},
			{ id: body.id, tx: mocks.tx },
		);
	});

	it("returns paginated history without internal actor IDs", async () => {
		mocks.queryResults.push(
			Array.from({ length: 26 }, (_, index) => ({
				id: `command-${String(26 - index).padStart(2, "0")}`,
				command: "whoami",
				status: "succeeded",
				output: "root\n",
				exitCode: 0,
				outputTruncated: false,
				errorMessage: null,
				actor: { id: "private-user-id", name: "Ada" },
				serverName: "Sydney",
				containerId: "container-1",
				createdAt: new Date("2026-08-05T10:00:00Z"),
				cursorCreatedAt: "2026-08-05 10:00:00+00",
				startedAt: new Date("2026-08-05T10:00:01Z"),
				completedAt: new Date("2026-08-05T10:00:02Z"),
			})),
		);

		const response = await GET(
			new Request("http://localhost/api/services/service-1/commands"),
			routeParams,
		);
		const body = (await response.json()) as {
			commands: Array<{ actor: Record<string, unknown> }>;
			nextCursor: string | null;
		};

		expect(response.status).toBe(200);
		expect(body.commands).toHaveLength(25);
		expect(body.commands[0]?.actor).toEqual({ name: "Ada" });
		expect(body.nextCursor).toEqual(expect.any(String));
	});
});
