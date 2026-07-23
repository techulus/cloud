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

	it("snapshots GitHub source provenance and the reserved runtime image", () => {
		const spec = buildServiceRevisionSpec(draft(), {
			image: "registry.test/project/service:revision-1",
			source: {
				type: "github",
				repository: "https://github.com/techulus/cloud",
				repositoryId: 123,
				branch: "main",
				commitSha: "0123456789abcdef0123456789abcdef01234567",
				rootDir: "web",
				authentication: { type: "github_app", installationId: 456 },
			},
		});

		expect(spec).toMatchObject({
			schemaVersion: 3,
			image: "registry.test/project/service:revision-1",
			source: {
				type: "github",
				repository: "https://github.com/techulus/cloud",
				branch: "main",
				commitSha: "0123456789abcdef0123456789abcdef01234567",
				rootDir: "web",
				authentication: { type: "github_app", installationId: 456 },
			},
		});
	});

	it("allows an unrolled build revision to snapshot zero placements", () => {
		expect(() =>
			buildServiceRevisionSpec(draft({ placements: [] }), {
				allowNoPlacements: true,
			}),
		).not.toThrow();
	});

	it("snapshots automatic placement intent without resolved placements", () => {
		const input = draft({ volumes: [] });
		input.service.placementMode = "automatic";
		input.service.replicas = 4;

		expect(buildServiceRevisionSpec(input)).toMatchObject({
			placement: { mode: "automatic", replicas: 4 },
			placements: [],
		});
	});

	it("rejects automatic placement for stateful, volume-backed, and serverless services", () => {
		const stateful = draft({ volumes: [] });
		stateful.service.stateful = true;
		stateful.service.placementMode = "automatic";
		stateful.service.replicas = 1;

		expect(() => buildServiceRevisionSpec(stateful)).toThrow(
			"Stateful services cannot use automatic placement",
		);

		const volumeBacked = draft();
		volumeBacked.service.placementMode = "automatic";
		volumeBacked.service.replicas = 1;

		expect(() => buildServiceRevisionSpec(volumeBacked)).toThrow(
			"Services with volumes cannot use automatic placement",
		);

		const serverless = draft({ volumes: [] });
		serverless.service.serverlessEnabled = true;
		serverless.service.placementMode = "automatic";
		serverless.service.replicas = 1;

		expect(() => buildServiceRevisionSpec(serverless)).toThrow(
			"Serverless services cannot use automatic placement",
		);
	});

	it("rejects serverless revisions without a public HTTP port and domain", () => {
		const input = draft({
			ports: [
				{
					port: 3000,
					isPublic: false,
					domain: null,
					protocol: "http",
					externalPort: null,
					tlsPassthrough: false,
				},
			],
		});
		input.service.serverlessEnabled = true;

		expect(() => buildServiceRevisionSpec(input)).toThrow(
			"Serverless services require a public HTTP port with a domain",
		);
	});

	it("accepts serverless revisions with at least one public HTTP port and domain", () => {
		const input = draft();
		input.service.serverlessEnabled = true;
		input.ports[0] = {
			port: 443,
			isPublic: true,
			domain: "api.example.com",
			protocol: "http",
			externalPort: null,
			tlsPassthrough: false,
		};

		expect(() => buildServiceRevisionSpec(input)).not.toThrow();
	});
});
