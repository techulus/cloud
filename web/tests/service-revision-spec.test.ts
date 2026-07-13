import { describe, expect, it } from "vitest";
import {
	buildServiceRevisionSpec,
	type ServiceRevisionDraft,
} from "@/lib/service-revision-spec";

function draft(
	overrides: Partial<ServiceRevisionDraft> = {},
): ServiceRevisionDraft {
	return {
		service: {
			name: "API Service",
			image: "nginx:latest",
			hostname: "api.internal",
			stateful: false,
			serverlessEnabled: false,
			serverlessSleepAfterSeconds: 300,
			serverlessWakeTimeoutSeconds: 300,
			healthCheckCmd: "curl -f http://localhost/health",
			healthCheckInterval: 10,
			healthCheckTimeout: 5,
			healthCheckRetries: 3,
			healthCheckStartPeriod: 30,
			startCommand: null,
			resourceCpuLimit: null,
			resourceMemoryLimitMb: null,
		},
		placements: [
			{ serverId: "server-b", count: 1 },
			{ serverId: "server-a", count: 2 },
		],
		ports: [
			{
				port: 443,
				isPublic: true,
				domain: "api.example.com",
				protocol: "tcp",
				externalPort: 443,
				tlsPassthrough: true,
			},
			{
				port: 80,
				isPublic: false,
				domain: null,
				protocol: "http",
				externalPort: null,
				tlsPassthrough: false,
			},
		],
		secrets: [
			{
				key: "TOKEN",
				encryptedValue: "ciphertext-2",
				updatedAt: "2026-07-01T00:00:00.000Z",
			},
			{
				key: "API_KEY",
				encryptedValue: "ciphertext-1",
				updatedAt: "2026-07-01T00:00:00.000Z",
			},
		],
		volumes: [
			{ name: "logs", containerPath: "/logs" },
			{ name: "data", containerPath: "/data" },
		],
		...overrides,
	};
}

describe("service revision specification", () => {
	it("normalizes draft row ordering", () => {
		const first = buildServiceRevisionSpec(draft());
		const reorderedDraft = draft();
		reorderedDraft.placements.reverse();
		reorderedDraft.ports.reverse();
		reorderedDraft.secrets.reverse();
		reorderedDraft.volumes.reverse();
		const second = buildServiceRevisionSpec(reorderedDraft);

		expect(second).toEqual(first);
	});

	it("normalizes defaults once", () => {
		const input = draft();
		input.service.serverlessSleepAfterSeconds = 30;
		input.service.healthCheckInterval = null;
		input.ports[0].protocol = null;
		input.ports[0].tlsPassthrough = null;

		const spec = buildServiceRevisionSpec(input);

		expect(spec.serverless.sleepAfterSeconds).toBe(120);
		expect(spec.healthCheck?.interval).toBe(10);
		expect(spec.ports[1]).toMatchObject({
			protocol: "http",
			tlsPassthrough: false,
		});
	});

	it("rejects an invalid replica layout before it can be persisted", () => {
		const input = draft({ placements: [] });

		expect(() => buildServiceRevisionSpec(input)).toThrow(
			"At least one replica is required",
		);
	});
});
