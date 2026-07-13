import { describe, expect, it } from "vitest";
import {
	type DeployedConfig,
	diffConfigs,
	getCurrentServerlessConfig,
	MIN_SERVERLESS_SLEEP_AFTER_SECONDS,
	revisionSpecToDeployedConfig,
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
				schemaVersion: 1,
				image: "nginx",
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
});
