import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const rows: unknown[][] = [];
	const select = vi.fn(() => {
		const result = rows.shift() ?? [];
		const query = {
			from: vi.fn(() => query),
			innerJoin: vi.fn(() => query),
			where: vi.fn(() => query),
			orderBy: vi.fn(() => query),
			limit: vi.fn(() => query),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (resolve: (value: unknown[]) => unknown) =>
				Promise.resolve(result).then(resolve),
		};
		return query;
	});
	return { rows, select };
});

vi.mock("@/db", () => ({ db: { select: mocks.select } }));

import { safeConfiguration } from "@/lib/public-api";

describe("public API configuration state", () => {
	beforeEach(() => {
		mocks.rows.length = 0;
		mocks.select.mockClear();
	});

	it("does not report a derived default hostname as a pending change", async () => {
		mocks.rows.push(
			[],
			[],
			[],
			[{ serverId: "server-1", serverName: "Sydney", count: 1 }],
			[{ id: "deployment-1", revisionId: "revision-1" }],
			[
				{
					specification: {
						schemaVersion: 2,
						image: "nginx:1.27",
						source: { type: "image", image: "nginx:1.27" },
						hostname: "hello-service",
						stateful: false,
						serverless: {
							enabled: false,
							sleepAfterSeconds: 300,
							wakeTimeoutSeconds: 300,
						},
						healthCheck: null,
						startCommand: null,
						resourceLimits: { cpuCores: null, memoryMb: null },
						placements: [{ serverId: "server-1", count: 1 }],
						ports: [],
						secrets: [],
						volumes: [],
					},
				},
			],
		);

		const configuration = await safeConfiguration({
			id: "service-1",
			name: "Hello Service",
			sourceType: "image",
			image: "nginx:1.27",
			hostname: null,
			stateful: false,
			healthCheckCmd: null,
			healthCheckInterval: 10,
			healthCheckTimeout: 5,
			healthCheckRetries: 3,
			healthCheckStartPeriod: 30,
			startCommand: null,
			resourceCpuLimit: null,
			resourceMemoryLimitMb: null,
			serverlessEnabled: false,
			serverlessSleepAfterSeconds: 300,
			serverlessWakeTimeoutSeconds: 300,
			deploymentSchedule: null,
			backupEnabled: false,
			backupSchedule: null,
		} as never);

		expect(configuration.current.hostname).toBeNull();
		expect(configuration.active?.hostname).toBe("hello-service");
		expect(configuration.hasPendingChanges).toBe(false);
		expect(configuration.changes).toEqual([]);
	});

	it("serializes automatic placement from desired service replicas", async () => {
		mocks.rows.push([], [], [], [], []);
		const configuration = await safeConfiguration({
			id: "service-1",
			name: "Automatic",
			sourceType: "image",
			image: "nginx",
			hostname: null,
			stateful: false,
			placementMode: "automatic",
			replicas: 4,
			healthCheckCmd: null,
			startCommand: null,
			resourceCpuLimit: null,
			resourceMemoryLimitMb: null,
			serverlessEnabled: false,
			serverlessSleepAfterSeconds: 300,
			serverlessWakeTimeoutSeconds: 300,
			deploymentSchedule: null,
			backupEnabled: false,
			backupSchedule: null,
		} as never);

		expect(configuration.current.placement).toEqual({
			mode: "automatic",
			replicas: 4,
		});
		expect(configuration.current.replicas).toBe(4);
		expect(configuration.current.placements).toEqual([]);
	});
});
