import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const selectResults: unknown[][] = [];
	const insertedValues: unknown[] = [];
	const updatedValues: unknown[] = [];
	function query(result: unknown[]) {
		const value = {
			from: vi.fn(() => value),
			where: vi.fn(() => value),
			orderBy: vi.fn(() => value),
			innerJoin: vi.fn(() => value),
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
			then: (
				resolve: (rows: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return value;
	}
	const tx = {
		execute: vi.fn().mockResolvedValue(undefined),
		select: vi.fn(() => query(selectResults.shift() ?? [])),
		insert: vi.fn(() => ({
			values: vi.fn((values: unknown) => {
				insertedValues.push(values);
				return Promise.resolve();
			}),
		})),
		update: vi.fn(() => ({
			set: vi.fn((values: unknown) => {
				updatedValues.push(values);
				return { where: vi.fn().mockResolvedValue(undefined) };
			}),
		})),
		delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
	};
	return {
		selectResults,
		insertedValues,
		updatedValues,
		tx,
		getSetting: vi.fn(),
		db: {
			transaction: vi.fn((operation: (transaction: typeof tx) => unknown) =>
				operation(tx),
			),
			select: vi.fn(() => query([])),
		},
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/db/queries", () => ({ getSetting: mocks.getSetting }));

import {
	createOrRefreshPreviewClone,
	previewPortConfiguration,
} from "@/lib/preview-deployments";

const baseService = {
	id: "12345678-abcd-4321-abcd-1234567890ab",
	projectId: "project-1",
	environmentId: "environment-1",
	name: "Web API",
	sourceType: "github",
	githubRepoUrl: "https://github.com/acme/app",
	githubBranch: "main",
	githubRootDir: "apps/web",
	previewDeploymentsEnabled: true,
	previewOfServiceId: null,
	stateful: false,
	placementMode: "manual",
	healthCheckCmd: "curl -f http://localhost/health",
	healthCheckInterval: 10,
	healthCheckTimeout: 5,
	healthCheckRetries: 3,
	healthCheckStartPeriod: 30,
	startCommand: "node server.js",
	resourceCpuLimit: 1,
	resourceMemoryLimitMb: 512,
};

const repo = {
	installationId: 101,
	repoId: 202,
	repoFullName: "acme/app",
	defaultBranch: "main",
	deployBranch: "main",
};

const ports = [
	{
		id: "port-http",
		serviceId: baseService.id,
		port: 3000,
		isPublic: true,
		domain: "app.example.com",
		protocol: "http" as const,
		externalPort: null,
		tlsPassthrough: false,
		createdAt: new Date(),
	},
	{
		id: "port-tcp",
		serviceId: baseService.id,
		port: 5432,
		isPublic: true,
		domain: null,
		protocol: "tcp" as const,
		externalPort: 15432,
		tlsPassthrough: true,
		createdAt: new Date(),
	},
];

function queueFactoryReads(existing: unknown[] = []) {
	mocks.selectResults.push(
		[baseService],
		[repo],
		ports,
		[
			{
				id: "secret-1",
				serviceId: baseService.id,
				key: "TOKEN",
				encryptedValue: "ciphertext",
				createdAt: new Date(),
				updatedAt: new Date("2026-08-01T00:00:00Z"),
			},
		],
		[
			{
				serverId: "server-1",
				count: 2,
				status: "online",
				wireguardIp: "10.0.0.1",
			},
		],
		existing,
	);
}

describe("preview service cloning", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectResults.length = 0;
		mocks.insertedValues.length = 0;
		mocks.updatedValues.length = 0;
		mocks.getSetting.mockResolvedValue("apps.example.com");
		process.env.REGISTRY_HOST = "registry.example.com";
	});

	it("copies ordinary configuration and secrets while enforcing preview policy", async () => {
		queueFactoryReads();

		const result = await createOrRefreshPreviewClone({
			baseServiceId: baseService.id,
			pullRequestNumber: 42,
			now: new Date("2026-08-16T00:00:00Z"),
		});

		expect(result).toMatchObject({
			created: true,
			primaryUrl: "https://web-api-pr-42-12345678.apps.example.com",
		});
		const [service, clonedPorts, placement, clonedSecrets, clonedRepo] =
			mocks.insertedValues as Array<Record<string, unknown>>;
		expect(service).toMatchObject({
			projectId: "project-1",
			environmentId: "environment-1",
			replicas: 1,
			stateful: false,
			autoscalingEnabled: false,
			serverlessEnabled: false,
			previewDeploymentsEnabled: false,
			previewOfServiceId: baseService.id,
			previewPullRequestNumber: 42,
		});
		expect(clonedPorts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					port: 3000,
					isPublic: true,
					domain: "web-api-pr-42-12345678.apps.example.com",
				}),
				expect.objectContaining({
					port: 5432,
					isPublic: false,
					externalPort: null,
					tlsPassthrough: false,
				}),
			]),
		);
		expect(placement).toMatchObject({ serverId: "server-1", count: 1 });
		expect(clonedSecrets).toEqual([
			expect.objectContaining({ key: "TOKEN", encryptedValue: "ciphertext" }),
		]);
		expect(clonedRepo).toMatchObject({
			installationId: 101,
			repoId: 202,
			autoDeploy: false,
		});
	});

	it("refreshes the same clone instead of creating another service", async () => {
		queueFactoryReads([
			{
				id: "preview-service-1",
				previewOfServiceId: baseService.id,
				previewPullRequestNumber: 42,
			},
		]);

		await expect(
			createOrRefreshPreviewClone({
				baseServiceId: baseService.id,
				pullRequestNumber: 42,
			}),
		).resolves.toMatchObject({
			serviceId: "preview-service-1",
			created: false,
		});
		expect(mocks.updatedValues[0]).toMatchObject({
			previewOfServiceId: baseService.id,
			previewPullRequestNumber: 42,
		});
		expect(mocks.insertedValues).toHaveLength(4);
	});

	it("makes non-HTTP public ports private", () => {
		expect(
			previewPortConfiguration({
				ports,
				serviceName: baseService.name,
				serviceId: baseService.id,
				pullRequestNumber: 42,
				domain: "apps.example.com",
			})[1],
		).toMatchObject({
			isPublic: false,
			domain: null,
			externalPort: null,
			tlsPassthrough: false,
		});
	});

	it("rejects stateful services", async () => {
		mocks.selectResults.push([{ ...baseService, stateful: true }]);
		await expect(
			createOrRefreshPreviewClone({
				baseServiceId: baseService.id,
				pullRequestNumber: 42,
			}),
		).rejects.toThrow("require a stateless service");
		expect(mocks.tx.insert).not.toHaveBeenCalled();
	});
});
