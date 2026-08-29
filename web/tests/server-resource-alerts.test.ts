import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	serverRows: [] as Array<{
		id: string;
		name: string;
		status: "online" | "offline";
		resourceAlerts: Record<string, unknown> | null;
	}>,
	updates: [] as unknown[],
	queryUsage: vi.fn(),
	transaction: vi.fn(),
	notify: vi.fn(),
}));

vi.mock("@/db", () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn(() => Promise.resolve(mocks.serverRows)),
		})),
		transaction: mocks.transaction,
	},
}));

vi.mock("@/lib/victoria-metrics", () => ({
	queryNodeResourceUsageAverages: mocks.queryUsage,
}));

vi.mock("@/lib/notifications", () => ({
	notify: mocks.notify,
}));

import { evaluateServerResourceAlerts } from "@/lib/server-resource-alerts";

describe("server resource alerts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.serverRows.length = 0;
		mocks.updates.length = 0;
		mocks.notify.mockResolvedValue(undefined);
		mocks.transaction.mockImplementation(async (operation) =>
			operation({
				update: vi.fn(() => ({
					set: vi.fn((value) => ({
						where: vi.fn(async () => {
							mocks.updates.push(value.resourceAlerts);
						}),
					})),
				})),
			}),
		);
	});

	it("activates each exceeded resource and ignores unavailable metrics", async () => {
		mocks.serverRows.push({
			id: "server-1",
			name: "Edge",
			status: "online",
			resourceAlerts: null,
		});
		mocks.queryUsage.mockResolvedValue(
			new Map([
				[
					"server-1",
					{
						cpuUsagePercent: 90,
						memoryUsagePercent: null,
						diskUsagePercent: 85,
					},
				],
			]),
		);

		const notifications = await evaluateServerResourceAlerts(
			new Date("2026-08-25T10:00:00.000Z"),
		);

		expect(notifications).toEqual([
			expect.objectContaining({
				kind: "server.resource_usage",
				occurrenceId: "server-resource-usage-server-1-cpu-1787652000000",
				resource: "cpu",
				usagePercent: 90,
				thresholdPercent: 90,
			}),
			expect.objectContaining({
				kind: "server.resource_usage",
				occurrenceId: "server-resource-usage-server-1-disk-1787652000000",
				resource: "disk",
				usagePercent: 85,
				thresholdPercent: 85,
			}),
		]);
		expect(mocks.updates).toEqual([
			expect.objectContaining({
				cpu: expect.objectContaining({
					detectedAt: "2026-08-25T10:00:00.000Z",
					notificationEnqueued: false,
				}),
				disk: expect.objectContaining({
					detectedAt: "2026-08-25T10:00:00.000Z",
					notificationEnqueued: false,
				}),
			}),
			expect.objectContaining({
				cpu: expect.objectContaining({
					notificationEnqueued: true,
				}),
				disk: expect.objectContaining({
					notificationEnqueued: true,
				}),
			}),
		]);
		expect(mocks.notify).toHaveBeenCalledTimes(2);
	});

	it("preserves an active alert when metrics are missing", async () => {
		const active = {
			usagePercent: 92,
			thresholdPercent: 90,
			detectedAt: "2026-08-25T09:00:00.000Z",
			notificationEnqueued: true,
		};
		mocks.serverRows.push({
			id: "server-1",
			name: "Edge",
			status: "online",
			resourceAlerts: { cpu: active },
		});
		mocks.queryUsage.mockResolvedValue(
			new Map([
				[
					"server-1",
					{
						cpuUsagePercent: null,
						memoryUsagePercent: 40,
						diskUsagePercent: 30,
					},
				],
			]),
		);

		await expect(evaluateServerResourceAlerts()).resolves.toEqual([]);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("does not repeat an alert while usage remains high", async () => {
		mocks.serverRows.push({
			id: "server-1",
			name: "Edge",
			status: "online",
			resourceAlerts: {
				cpu: {
					usagePercent: 92,
					thresholdPercent: 90,
					detectedAt: "2026-08-25T09:00:00.000Z",
					notificationEnqueued: true,
				},
			},
		});
		mocks.queryUsage.mockResolvedValue(
			new Map([
				[
					"server-1",
					{
						cpuUsagePercent: 95,
						memoryUsagePercent: 40,
						diskUsagePercent: 30,
					},
				],
			]),
		);

		await expect(evaluateServerResourceAlerts()).resolves.toEqual([]);
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("re-enqueues a committed pending alert with its stable occurrence ID", async () => {
		mocks.serverRows.push({
			id: "server-1",
			name: "Edge",
			status: "online",
			resourceAlerts: {
				cpu: {
					usagePercent: 92,
					thresholdPercent: 90,
					detectedAt: "2026-08-25T09:00:00.000Z",
					notificationEnqueued: false,
				},
			},
		});
		mocks.queryUsage.mockResolvedValue(new Map());

		const notifications = await evaluateServerResourceAlerts(
			new Date("2026-08-25T10:05:00.000Z"),
		);

		expect(notifications).toEqual([
			expect.objectContaining({
				occurrenceId: `server-resource-usage-server-1-cpu-${new Date(
					"2026-08-25T09:00:00.000Z",
				).getTime()}`,
				usagePercent: 92,
				detectedAt: "2026-08-25T09:00:00.000Z",
			}),
		]);
		expect(mocks.notify).toHaveBeenCalledWith(notifications[0]);
		expect(mocks.updates).toEqual([
			expect.objectContaining({
				cpu: expect.objectContaining({ notificationEnqueued: true }),
			}),
		]);
	});

	it("leaves a pending alert unmarked when enqueueing fails", async () => {
		mocks.serverRows.push({
			id: "server-1",
			name: "Edge",
			status: "online",
			resourceAlerts: {
				cpu: {
					usagePercent: 92,
					thresholdPercent: 90,
					detectedAt: "2026-08-25T09:00:00.000Z",
					notificationEnqueued: false,
				},
			},
		});
		mocks.queryUsage.mockResolvedValue(new Map());
		mocks.notify.mockRejectedValue(new Error("Inngest unavailable"));

		await expect(evaluateServerResourceAlerts()).rejects.toThrow(
			"Inngest unavailable",
		);
		expect(mocks.updates).toEqual([]);
	});

	it("clears at the recovery threshold and can activate again", async () => {
		mocks.serverRows.push({
			id: "server-1",
			name: "Edge",
			status: "online",
			resourceAlerts: {
				cpu: {
					usagePercent: 92,
					thresholdPercent: 90,
					detectedAt: "2026-08-25T09:00:00.000Z",
					notificationEnqueued: true,
				},
			},
		});
		mocks.queryUsage.mockResolvedValue(
			new Map([
				[
					"server-1",
					{
						cpuUsagePercent: 85,
						memoryUsagePercent: 40,
						diskUsagePercent: 30,
					},
				],
			]),
		);

		await expect(evaluateServerResourceAlerts()).resolves.toEqual([]);
		expect(mocks.updates).toEqual([null]);

		mocks.serverRows[0]!.resourceAlerts = null;
		mocks.updates.length = 0;
		mocks.queryUsage.mockResolvedValue(
			new Map([
				[
					"server-1",
					{
						cpuUsagePercent: 91,
						memoryUsagePercent: 40,
						diskUsagePercent: 30,
					},
				],
			]),
		);

		const notifications = await evaluateServerResourceAlerts(
			new Date("2026-08-25T10:05:00.000Z"),
		);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toMatchObject({ resource: "cpu" });
	});

	it("clears alerts when a server goes offline", async () => {
		mocks.serverRows.push({
			id: "server-1",
			name: "Edge",
			status: "offline",
			resourceAlerts: {
				disk: {
					usagePercent: 90,
					thresholdPercent: 85,
					detectedAt: "2026-08-25T09:00:00.000Z",
					notificationEnqueued: true,
				},
			},
		});
		mocks.queryUsage.mockResolvedValue(new Map());

		await expect(evaluateServerResourceAlerts()).resolves.toEqual([]);
		expect(mocks.queryUsage).toHaveBeenCalledWith([]);
		expect(mocks.updates).toEqual([null]);
	});
});
