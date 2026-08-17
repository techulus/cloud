import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const selectResults: unknown[][] = [];
	const returningResults: unknown[][] = [];
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
				const result = {
					onConflictDoNothing: vi.fn(() => result),
					returning: vi.fn(() =>
						Promise.resolve(returningResults.shift() ?? []),
					),
					// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
					then: (
						resolve: (value: undefined) => unknown,
						reject?: (reason: unknown) => unknown,
					) => Promise.resolve(undefined).then(resolve, reject),
				};
				return result;
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
		returningResults,
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
	createPreviewClone,
	ensurePreviewEnvironment,
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
	previewOfService: null,
	stateful: false,
	replicas: 2,
	autoscalingEnabled: false,
	autoscalingMinReplicas: 1,
	autoscalingMaxReplicas: 4,
	placementMode: "manual",
	lockedServerId: "server-1",
	healthCheckCmd: "curl -f http://localhost/health",
	healthCheckInterval: 10,
	healthCheckTimeout: 5,
	healthCheckRetries: 3,
	healthCheckStartPeriod: 30,
	startCommand: "node server.js",
	resourceCpuLimit: 1,
	resourceMemoryLimitMb: 512,
	serverlessEnabled: true,
	serverlessSleepAfterSeconds: 300,
	serverlessWakeTimeoutSeconds: 60,
	deploymentSchedule: "0 9 * * *",
	backupEnabled: false,
	backupSchedule: null,
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

function queueFactoryReads(
	existing: unknown[] = [],
	service: typeof baseService = baseService,
) {
	mocks.selectResults.push(
		[service],
		existing,
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
		[{ id: "preview-environment", projectId: "project-1", name: "previews" }],
	);
}

describe("preview service cloning", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectResults.length = 0;
		mocks.returningResults.length = 0;
		mocks.insertedValues.length = 0;
		mocks.updatedValues.length = 0;
		mocks.getSetting.mockResolvedValue("apps.example.com");
		process.env.REGISTRY_HOST = "registry.example.com";
	});

	it("copies runtime configuration and secrets but not automation", async () => {
		queueFactoryReads();

		const result = await createPreviewClone({
			baseServiceId: baseService.id,
			previewGitRef: "refs/pull/42/merge",
		});

		expect(result).toMatchObject({
			created: true,
			primaryUrl: "https://web-api-pr-42-12345678.apps.example.com",
		});
		const [service, clonedPorts, placement, clonedSecrets, clonedRepo] =
			mocks.insertedValues as Array<Record<string, unknown>>;
		expect(service).toMatchObject({
			projectId: "project-1",
			environmentId: "preview-environment",
			replicas: 2,
			stateful: false,
			autoscalingEnabled: false,
			serverlessEnabled: true,
			lockedServerId: "server-1",
			deploymentSchedule: null,
			backupEnabled: false,
			previewDeploymentsEnabled: false,
			previewOfService: baseService.id,
			previewGitRef: "refs/pull/42/merge",
		});
		expect(clonedPorts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					serviceId: result.serviceId,
					port: 3000,
					isPublic: true,
					domain: "web-api-pr-42-12345678.apps.example.com",
				}),
				expect.objectContaining({
					serviceId: result.serviceId,
					port: 5432,
					isPublic: false,
					externalPort: null,
					tlsPassthrough: false,
				}),
			]),
		);
		expect(clonedPorts).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "port-http" }),
				expect.objectContaining({ id: "port-tcp" }),
			]),
		);
		expect(placement).toEqual([
			expect.objectContaining({ serverId: "server-1", count: 2 }),
		]);
		expect(clonedSecrets).toEqual([
			expect.objectContaining({ key: "TOKEN", encryptedValue: "ciphertext" }),
		]);
		expect(clonedRepo).toMatchObject({
			installationId: 101,
			repoId: 202,
			autoDeploy: false,
		});
	});

	it("preserves the same visible clone instead of refreshing its configuration", async () => {
		mocks.selectResults.push(
			[baseService],
			[
				{
					id: "preview-service-1",
					previewOfService: baseService.id,
					previewGitRef: "refs/pull/42/merge",
				},
			],
			[{ domain: "custom-preview.apps.example.com" }],
		);

		await expect(
			createPreviewClone({
				baseServiceId: baseService.id,
				previewGitRef: "refs/pull/42/merge",
			}),
		).resolves.toMatchObject({
			serviceId: "preview-service-1",
			created: false,
			primaryUrl: "https://custom-preview.apps.example.com",
		});
		expect(mocks.updatedValues).toHaveLength(0);
		expect(mocks.insertedValues).toHaveLength(0);
	});

	it("rejects stateful services", async () => {
		mocks.selectResults.push([{ ...baseService, stateful: true }]);
		await expect(
			createPreviewClone({
				baseServiceId: baseService.id,
				previewGitRef: "refs/pull/42/merge",
			}),
		).rejects.toThrow("require a stateless service");
		expect(mocks.tx.insert).not.toHaveBeenCalled();
	});

	it("creates the ordinary previews environment when it is missing", async () => {
		mocks.selectResults.push([]);
		mocks.returningResults.push([
			{ id: "preview-environment", projectId: "project-1", name: "previews" },
		]);

		await expect(ensurePreviewEnvironment("project-1")).resolves.toMatchObject({
			id: "preview-environment",
			name: "previews",
		});
		expect(mocks.insertedValues).toContainEqual(
			expect.objectContaining({ projectId: "project-1", name: "previews" }),
		);
	});

	it("keeps ports private when no automatic domain is configured", () => {
		expect(
			previewPortConfiguration({
				ports,
				serviceName: baseService.name,
				serviceId: baseService.id,
				pullRequestNumber: 42,
				domain: null,
			}),
		).toEqual(
			ports.map((port) => ({
				...port,
				isPublic: false,
				domain: null,
				externalPort: null,
				tlsPassthrough: false,
			})),
		);
	});

	it("disables copied serverless mode when no public preview URL exists", async () => {
		mocks.getSetting.mockResolvedValue(null);
		queueFactoryReads([], { ...baseService, serverlessEnabled: true });

		await createPreviewClone({
			baseServiceId: baseService.id,
			previewGitRef: "refs/pull/42/merge",
		});

		expect(mocks.insertedValues[0]).toMatchObject({
			serverlessEnabled: false,
		});
	});
});
