import { describe, expect, it } from "vitest";
import {
	diffConfigs,
	getDeployedServerlessConfig,
	isDeployedServerlessService,
	type DeployedConfig,
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
			minReadyReplicas: 1,
		},
		...overrides,
	};
}

describe("service config", () => {
	it("uses deployed serverless settings as the runtime mode", () => {
		const service = {
			serverlessEnabled: false,
			serverlessSleepAfterSeconds: 60,
			serverlessWakeTimeoutSeconds: 60,
			serverlessMinReadyReplicas: 1,
			stateful: true,
			deployedConfig: JSON.stringify(deployedConfig()),
		};

		expect(getDeployedServerlessConfig(service)).toMatchObject({
			enabled: true,
			sleepAfterSeconds: 300,
			wakeTimeoutSeconds: 120,
		});
		expect(isDeployedServerlessService(service)).toBe(true);
	});

	it("allows deployed stateful services to be serverless", () => {
		const service = {
			serverlessEnabled: true,
			stateful: true,
			serverlessSleepAfterSeconds: 300,
			serverlessWakeTimeoutSeconds: 120,
			serverlessMinReadyReplicas: 1,
			deployedConfig: JSON.stringify(deployedConfig({ stateful: true })),
		};

		expect(isDeployedServerlessService(service)).toBe(true);
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
				minReadyReplicas: 1,
			},
		});

		expect(changes).toContainEqual({
			field: "Serverless",
			from: "Enabled",
			to: "Disabled",
		});
	});
});
