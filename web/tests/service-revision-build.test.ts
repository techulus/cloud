import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";

const mocks = vi.hoisted(() => {
	const selectResults: unknown[][] = [];
	const insertedValues: unknown[] = [];
	const returningResults: unknown[][] = [];
	function selectQuery(result: unknown[]) {
		const query = {
			from: vi.fn(() => query),
			where: vi.fn(() => query),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return query;
	}
	function insertQuery() {
		const result = returningResults.shift() ?? [];
		const query = {
			values: vi.fn((value: unknown) => {
				insertedValues.push(value);
				return query;
			}),
			onConflictDoNothing: vi.fn(() => query),
			returning: vi.fn(() => query),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return query;
	}
	const tx = {
		select: vi.fn(() => selectQuery(selectResults.shift() ?? [])),
		insert: vi.fn(() => insertQuery()),
	};
	return {
		selectResults,
		insertedValues,
		returningResults,
		tx,
		db: {
			transaction: vi.fn((operation: (transaction: typeof tx) => unknown) =>
				operation(tx),
			),
		},
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/public-api", () => ({
	resolvePersistedSourceFromRows: vi.fn(),
}));

import {
	cloneGitHubBuildServiceRevision,
	createGitHubBuildServiceRevision,
	createRolloutWithServiceRevision,
} from "@/lib/service-revisions";

function sourceSpecification(): ServiceRevisionSpec {
	return {
		schemaVersion: 2,
		image: "registry.test/project-1/service-1:revision-original",
		source: {
			type: "github",
			repository: "https://github.com/acme/app",
			repositoryId: 101,
			branch: "main",
			commitSha: "0123456789abcdef0123456789abcdef01234567",
			rootDir: "apps/web",
			authentication: { type: "github_app", installationId: 123 },
		},
		hostname: "service-1",
		stateful: false,
		serverless: {
			enabled: false,
			sleepAfterSeconds: 300,
			wakeTimeoutSeconds: 300,
		},
		healthCheck: null,
		startCommand: "node server.js",
		resourceLimits: { cpuCores: 1, memoryMb: 512 },
		placements: [{ serverId: "server-1", count: 1 }],
		ports: [],
		secrets: [
			{
				key: "TOKEN",
				encryptedValue: "ciphertext",
				updatedAt: "2026-07-21T00:00:00.000Z",
			},
		],
		volumes: [],
	};
}

describe("GitHub build service revisions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectResults.length = 0;
		mocks.insertedValues.length = 0;
		mocks.returningResults.length = 0;
	});

	it("clones immutable source and config while reserving a new artifact", async () => {
		const original = sourceSpecification();
		mocks.selectResults.push(
			[
				{
					id: "revision-original",
					serviceId: "service-1",
					specification: original,
				},
			],
			[{ id: "service-1" }],
		);
		mocks.returningResults.push([{ id: "revision-retry" }]);

		await cloneGitHubBuildServiceRevision({
			serviceId: "service-1",
			sourceRevisionId: "revision-original",
			actor: { type: "system" },
		});

		const inserted = mocks.insertedValues[0] as {
			id: string;
			specification: ServiceRevisionSpec;
		};
		expect(inserted.id).not.toBe("revision-original");
		expect(inserted.specification.image).toBe(
			`registry.test/project-1/service-1:revision-${inserted.id}`,
		);
		expect(inserted.specification.source).toEqual(original.source);
		expect({
			...inserted.specification,
			image: original.image,
		}).toEqual(original);
	});

	it("rejects reuse of a deterministic revision id for another commit", async () => {
		mocks.selectResults.push([
			{
				id: "revision-deterministic",
				serviceId: "service-1",
				specification: sourceSpecification(),
			},
		]);

		await expect(
			createGitHubBuildServiceRevision({
				id: "revision-deterministic",
				serviceId: "service-1",
				image:
					"registry.test/project-1/service-1:revision-revision-deterministic",
				commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				expectedRepository: "https://github.com/acme/app",
				expectedBranch: "main",
				actor: { type: "system" },
			}),
		).rejects.toThrow("Service revision idempotency conflict");
		expect(mocks.tx.insert).not.toHaveBeenCalled();
	});

	it("combines current runtime config with a GitHub base artifact", async () => {
		const base = sourceSpecification();
		mocks.selectResults.push(
			[{ specification: base }],
			[],
			[
				{
					id: "service-1",
					name: "Current service",
					image: "registry.test/project-1/service-1:latest",
					hostname: "current-hostname",
					stateful: false,
					serverlessEnabled: false,
					serverlessSleepAfterSeconds: 300,
					serverlessWakeTimeoutSeconds: 300,
					healthCheckCmd: null,
					healthCheckInterval: null,
					healthCheckTimeout: null,
					healthCheckRetries: null,
					healthCheckStartPeriod: null,
					startCommand: "node current.js",
					resourceCpuLimit: 2,
					resourceMemoryLimitMb: 1024,
				},
			],
			[{ serverId: "server-target", count: 1 }],
			[],
			[],
			[],
		);
		mocks.returningResults.push([{ id: "revision-current-config" }], []);

		await createRolloutWithServiceRevision(
			"service-1",
			{ type: "system" },
			"revision-active",
		);

		const inserted = mocks.insertedValues[0] as {
			specification: ServiceRevisionSpec;
		};
		expect(inserted.specification).toMatchObject({
			image: base.image,
			source: base.source,
			hostname: "current-hostname",
			startCommand: "node current.js",
			resourceLimits: { cpuCores: 2, memoryMb: 1024 },
			placements: [{ serverId: "server-target", count: 1 }],
		});
		expect(inserted.specification.image).not.toContain(":latest");
	});
});
