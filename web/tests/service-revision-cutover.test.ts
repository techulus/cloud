import { describe, expect, it } from "vitest";
import { buildCutoverServiceRevisionSpec } from "@/lib/service-revision-cutover";
import type { ServiceRevisionDraft } from "@/lib/service-revision-spec";

function liveDraft(): ServiceRevisionDraft {
	return {
		service: {
			id: "service-1",
			name: "API",
			image: "current:image",
			hostname: "current-host",
			stateful: false,
			serverlessEnabled: false,
			serverlessSleepAfterSeconds: 600,
			serverlessWakeTimeoutSeconds: 600,
			healthCheckCmd: "current-health",
			healthCheckInterval: 10,
			healthCheckTimeout: 5,
			healthCheckRetries: 3,
			healthCheckStartPeriod: 30,
			startCommand: "current-command",
			resourceCpuLimit: 2,
			resourceMemoryLimitMb: 1024,
		},
		placements: [{ serverId: "current-server", count: 2 }],
		ports: [
			{
				port: 8080,
				isPublic: true,
				domain: "current.example.com",
				protocol: "tcp",
				externalPort: 443,
				tlsPassthrough: true,
			},
		],
		secrets: [
			{
				key: "TOKEN",
				encryptedValue: "ciphertext",
				updatedAt: "2026-07-01T00:00:00.000Z",
			},
		],
		volumes: [{ name: "current", containerPath: "/current" }],
	};
}

describe("service revision cutover", () => {
	it("uses the legacy deployed snapshot while retaining runtime-only values", () => {
		const specification = buildCutoverServiceRevisionSpec({
			liveDraft: liveDraft(),
			deployedConfig: {
				source: { image: "deployed:image" },
				hostname: "deployed-host",
				stateful: true,
				replicas: [{ serverId: "deployed-server", count: 1 }],
				healthCheck: null,
				startCommand: null,
				resourceLimits: { cpuCores: 1, memoryMb: 512 },
				ports: [
					{
						port: 8080,
						isPublic: false,
						domain: null,
						protocol: "tcp",
						tlsPassthrough: false,
					},
				],
				serverless: {
					enabled: true,
					sleepAfterSeconds: 300,
					wakeTimeoutSeconds: 120,
				},
				secrets: [{ key: "TOKEN", updatedAt: "2026-07-01T00:00:00.000Z" }],
				volumes: [{ name: "deployed", containerPath: "/data" }],
			},
		});

		expect(specification).toMatchObject({
			image: "deployed:image",
			hostname: "deployed-host",
			stateful: true,
			placements: [{ serverId: "deployed-server", count: 1 }],
			healthCheck: null,
			startCommand: null,
			resourceLimits: { cpuCores: 1, memoryMb: 512 },
			serverless: { enabled: true },
			ports: [{ containerPort: 8080, externalPort: 443 }],
			secrets: [{ key: "TOKEN", encryptedValue: "ciphertext" }],
			volumes: [{ name: "deployed", containerPath: "/data" }],
		});
	});

	it("keeps deployed resource limits unset instead of using live draft limits", () => {
		const specification = buildCutoverServiceRevisionSpec({
			liveDraft: liveDraft(),
			deployedConfig: {
				secrets: [{ key: "TOKEN", updatedAt: "2026-07-01T00:00:00.000Z" }],
			},
		});

		expect(specification.resourceLimits).toEqual({
			cpuCores: null,
			memoryMb: null,
		});
	});

	it("rejects undeployed secret changes", () => {
		const draft = liveDraft();
		draft.secrets[0].updatedAt = "2026-07-02T00:00:00.000Z";

		expect(() =>
			buildCutoverServiceRevisionSpec({
				liveDraft: draft,
				deployedConfig: {
					secrets: [{ key: "TOKEN", updatedAt: "2026-07-01T00:00:00.000Z" }],
				},
			}),
		).toThrow("Secret TOKEN differs from the deployed snapshot");
	});

	it("uses live configuration for a service that has never been deployed", () => {
		const draft = liveDraft();
		const specification = buildCutoverServiceRevisionSpec({
			liveDraft: draft,
			deployedConfig: null,
		});

		expect(specification).toMatchObject({
			image: draft.service.image,
			hostname: draft.service.hostname,
			placements: draft.placements,
			healthCheck: { cmd: "current-health" },
			startCommand: "current-command",
			ports: [{ containerPort: 8080, externalPort: 443 }],
			volumes: draft.volumes,
		});
	});
});
