import { describe, expect, it } from "vitest";
import {
	buildCurrentConfig,
	type DeployedConfig,
	diffConfigs,
	getCurrentServerlessConfig,
	hasBuildAffectingChanges,
	MIN_SERVERLESS_SLEEP_AFTER_SECONDS,
	revisionSpecToDeployedConfig,
	TECHULUS_DOCKERFILE_PATH,
} from "@/lib/service-config";

function deployedConfig(
	overrides: Partial<DeployedConfig> = {},
): DeployedConfig {
	return {
		source: { type: "image", image: "nginx" },
		stateful: false,
		replicas: [],
		healthCheck: null,
		ports: [],
		serverless: {
			enabled: true,
			sleepAfterSeconds: 300,
			wakeTimeoutSeconds: 120,
		},
		...overrides,
	};
}

describe("service config", () => {
	it("enforces the minimum serverless sleep timeout", () => {
		expect(
			getCurrentServerlessConfig({
				serverlessEnabled: true,
				serverlessSleepAfterSeconds: 60,
				serverlessWakeTimeoutSeconds: 120,
			}),
		).toMatchObject({
			sleepAfterSeconds: MIN_SERVERLESS_SLEEP_AFTER_SECONDS,
		});
	});

	it("converts an immutable revision for pending-change comparisons", () => {
		const config = revisionSpecToDeployedConfig(
			{
				schemaVersion: 2,
				image: "nginx",
				source: { type: "image", image: "nginx" },
				hostname: "api",
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
			{ "server-1": "Sydney" },
		);

		expect(config.replicas).toEqual([
			{ serverId: "server-1", serverName: "Sydney", count: 1 },
		]);
	});

	it("does not report revision-scoped GitHub artifacts as pending image changes", () => {
		const currentSource = {
			type: "github" as const,
			repository: "https://github.com/acme/api",
			branch: "main",
			rootDir: "apps/api",
		};
		const current = buildCurrentConfig(
			{
				image: "registry.test/project/service:latest",
				hostname: "api",
				healthCheckCmd: null,
				healthCheckInterval: null,
				healthCheckTimeout: null,
				healthCheckRetries: null,
				healthCheckStartPeriod: null,
				startCommand: null,
				resourceCpuLimit: null,
				resourceMemoryLimitMb: null,
				replicas: 0,
				stateful: false,
				serverlessEnabled: false,
				serverlessSleepAfterSeconds: 300,
				serverlessWakeTimeoutSeconds: 300,
			},
			[],
			[],
			[],
			[],
			currentSource,
		);

		for (const [image, commitSha] of [
			[
				"registry.test/project/service:revision-first",
				"1111111111111111111111111111111111111111",
			],
			[
				"registry.test/project/service:revision-second",
				"2222222222222222222222222222222222222222",
			],
		] as const) {
			const active = revisionSpecToDeployedConfig(
				{
					schemaVersion: 2,
					image,
					source: {
						...currentSource,
						repositoryId: 101,
						commitSha,
						authentication: {
							type: "github_app",
							installationId: 202,
						},
					},
					hostname: "api",
					stateful: false,
					serverless: {
						enabled: false,
						sleepAfterSeconds: 300,
						wakeTimeoutSeconds: 300,
					},
					healthCheck: null,
					startCommand: null,
					resourceLimits: { cpuCores: null, memoryMb: null },
					placements: [],
					ports: [],
					secrets: [],
					volumes: [],
				},
				{},
			);

			expect(active.source).toEqual(currentSource);
			expect(diffConfigs(active, current)).toEqual([]);
		}
	});

	it("reports real GitHub source changes as build-affecting", () => {
		const changes = diffConfigs(
			deployedConfig({
				source: {
					type: "github",
					repository: "https://github.com/acme/api",
					branch: "main",
					rootDir: null,
				},
			}),
			deployedConfig({
				source: {
					type: "github",
					repository: "https://github.com/acme/platform",
					branch: "production",
					rootDir: "apps/api",
				},
			}),
		);

		expect(changes).toEqual([
			{
				field: "GitHub repository",
				from: "https://github.com/acme/api",
				to: "https://github.com/acme/platform",
				requiresBuild: true,
			},
			{
				field: "GitHub branch",
				from: "main",
				to: "production",
				requiresBuild: true,
			},
			{
				field: "GitHub root directory",
				from: "(repository root)",
				to: "apps/api",
				requiresBuild: true,
			},
		]);
		expect(hasBuildAffectingChanges(changes)).toBe(true);
	});

	it("continues to report configured image changes", () => {
		expect(
			diffConfigs(
				deployedConfig({
					source: { type: "image", image: "nginx:1.27" },
				}),
				deployedConfig({
					source: { type: "image", image: "nginx:1.28" },
				}),
			),
		).toContainEqual({
			field: "Image",
			from: "nginx:1.27",
			to: "nginx:1.28",
		});
	});

	it("does not report null and omitted resource limits as pending", () => {
		const deployed = deployedConfig({
			resourceLimits: { cpuCores: null, memoryMb: null },
		});
		const current = deployedConfig();

		expect(diffConfigs(deployed, current)).toEqual([]);
	});

	it("reports serverless changes as pending config", () => {
		const changes = diffConfigs(deployedConfig(), {
			source: { type: "image", image: "nginx" },
			stateful: false,
			replicas: [],
			healthCheck: null,
			ports: [],
			serverless: {
				enabled: false,
				sleepAfterSeconds: 300,
				wakeTimeoutSeconds: 120,
			},
		});

		expect(changes).toContainEqual({
			field: "Serverless",
			from: "Enabled",
			to: "Disabled",
		});
	});

	it("requires a build when the Dockerfile path is added, updated, or removed", () => {
		const dockerfileSecret = {
			key: TECHULUS_DOCKERFILE_PATH,
			updatedAt: "2026-07-20T00:00:00.000Z",
		};
		const withoutSecret = deployedConfig({ secrets: [] });
		const withSecret = deployedConfig({ secrets: [dockerfileSecret] });
		const updatedSecret = deployedConfig({
			secrets: [{ ...dockerfileSecret, updatedAt: "2026-07-20T01:00:00.000Z" }],
		});

		expect(
			hasBuildAffectingChanges(diffConfigs(withoutSecret, withSecret)),
		).toBe(true);
		expect(
			hasBuildAffectingChanges(diffConfigs(withSecret, updatedSecret)),
		).toBe(true);
		expect(
			hasBuildAffectingChanges(diffConfigs(withSecret, withoutSecret)),
		).toBe(true);
	});

	it("does not require a build for unrelated environment variables", () => {
		const changes = diffConfigs(
			deployedConfig({ secrets: [] }),
			deployedConfig({
				secrets: [{ key: "DATABASE_URL", updatedAt: "2026-07-20" }],
			}),
		);

		expect(hasBuildAffectingChanges(changes)).toBe(false);
	});
});
