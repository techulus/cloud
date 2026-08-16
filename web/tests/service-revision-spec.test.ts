import { describe, expect, it } from "vitest";
import {
	buildServiceRevisionSpec,
	isSupportedGitRef,
	type ServiceRevisionDraft,
} from "@/lib/service-revision-spec";

function draft(
	overrides: Partial<ServiceRevisionDraft> = {},
): ServiceRevisionDraft {
	return {
		service: {
			id: "service-1",
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
				domain: null,
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
	it("derives the legacy null-hostname fallback from the current service name", () => {
		const original = draft();
		original.service.hostname = null;
		const renamed = draft();
		renamed.service.hostname = null;
		renamed.service.name = "Renamed API Service";

		expect(buildServiceRevisionSpec(original).hostname).toBe("api-service");
		expect(buildServiceRevisionSpec(renamed).hostname).toBe(
			"renamed-api-service",
		);
	});

	it("produces a valid DNS label for long and non-ASCII legacy names", () => {
		const long = draft();
		long.service.hostname = null;
		long.service.name = "a".repeat(100);
		const nonAscii = draft();
		nonAscii.service.hostname = null;
		nonAscii.service.name = "こんにちは";

		expect(buildServiceRevisionSpec(long).hostname).toHaveLength(63);
		expect(buildServiceRevisionSpec(nonAscii).hostname).toBe(
			"service-service-1",
		);
	});

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
		input.ports[0].domain = "api.example.com";
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

	it("allows distinct public HTTP domains to share a container port", () => {
		const input = draft({
			ports: [
				{
					port: 3000,
					isPublic: true,
					domain: "app.example.com",
					protocol: "http",
					externalPort: null,
					tlsPassthrough: false,
				},
				{
					port: 3000,
					isPublic: true,
					domain: "www.example.com",
					protocol: "http",
					externalPort: null,
					tlsPassthrough: false,
				},
			],
		});

		expect(buildServiceRevisionSpec(input).ports).toHaveLength(2);
	});

	it("allows different protocols to share a numeric container port", () => {
		const input = draft({
			ports: [
				{
					port: 3000,
					isPublic: true,
					domain: "app.example.com",
					protocol: "http",
					externalPort: null,
					tlsPassthrough: false,
				},
				{
					port: 3000,
					isPublic: true,
					domain: null,
					protocol: "tcp",
					externalPort: 10000,
					tlsPassthrough: false,
				},
			],
		});

		expect(buildServiceRevisionSpec(input).ports).toHaveLength(2);
	});

	it("rejects repeated container ports that are not HTTP aliases", () => {
		const input = draft({
			ports: [
				{
					port: 3000,
					isPublic: true,
					domain: "app.example.com",
					protocol: "http",
					externalPort: null,
					tlsPassthrough: false,
				},
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

		expect(() => buildServiceRevisionSpec(input)).toThrow(
			"can only be repeated for public HTTP domains",
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
				gitRef: "refs/heads/main",
				commitSha: "0123456789abcdef0123456789abcdef01234567",
				rootDir: "web",
				authentication: { type: "github_app", installationId: 456 },
			},
		});

		expect(spec).toMatchObject({
			schemaVersion: 4,
			image: "registry.test/project/service:revision-1",
			source: {
				type: "github",
				repository: "https://github.com/techulus/cloud",
				branch: "main",
				gitRef: "refs/heads/main",
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
		input.service.replicas = 32;

		expect(buildServiceRevisionSpec(input)).toMatchObject({
			placement: { mode: "automatic", replicas: 32 },
			placements: [],
		});
	});

	it("snapshots an eligible autoscaling policy and clamps its concrete target", () => {
		const input = draft({ volumes: [] });
		Object.assign(input.service, {
			placementMode: "automatic",
			replicas: 20,
			autoscalingEnabled: true,
			autoscalingMinReplicas: 2,
			autoscalingMaxReplicas: 8,
			resourceCpuLimit: 1,
			resourceMemoryLimitMb: 512,
		});

		expect(buildServiceRevisionSpec(input)).toMatchObject({
			placement: { mode: "automatic", replicas: 8 },
			autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 8 },
		});
	});

	it("rejects ineligible autoscaling policies", () => {
		const input = draft({ volumes: [] });
		Object.assign(input.service, {
			placementMode: "automatic",
			replicas: 2,
			autoscalingEnabled: true,
			autoscalingMinReplicas: 2,
			autoscalingMaxReplicas: 8,
		});
		expect(() => buildServiceRevisionSpec(input)).toThrow(
			"Autoscaling requires both CPU and memory limits",
		);
	});

	it("rejects more than 32 automatic replicas", () => {
		const input = draft({ volumes: [] });
		input.service.placementMode = "automatic";
		input.service.replicas = 33;

		expect(() => buildServiceRevisionSpec(input)).toThrow(
			"Maximum 32 replicas allowed",
		);
	});

	it("rejects automatic placement for stateful and volume-backed services", () => {
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
	});

	it("allows automatic placement for stateless serverless services", () => {
		const serverless = draft({
			volumes: [],
			ports: [
				{
					port: 3000,
					isPublic: true,
					domain: "api.example.com",
					protocol: "http",
					externalPort: null,
					tlsPassthrough: false,
				},
			],
		});
		serverless.service.serverlessEnabled = true;
		serverless.service.placementMode = "automatic";
		serverless.service.replicas = 3;

		expect(buildServiceRevisionSpec(serverless)).toMatchObject({
			stateful: false,
			serverless: { enabled: true },
			placement: { mode: "automatic", replicas: 3 },
			placements: [],
			volumes: [],
		});
	});

	it("rejects serverless revisions without a public HTTP port and domain", () => {
		const input = draft({
			volumes: [],
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

	it("accepts manually placed stateful serverless revisions", () => {
		const input = draft({
			placements: [{ serverId: "proxy-server", count: 1 }],
			volumes: [{ name: "data", containerPath: "/data" }],
		});
		input.service.stateful = true;
		input.service.serverlessEnabled = true;
		input.ports[0] = {
			port: 443,
			isPublic: true,
			domain: "api.example.com",
			protocol: "http",
			externalPort: null,
			tlsPassthrough: false,
		};

		expect(buildServiceRevisionSpec(input)).toMatchObject({
			stateful: true,
			serverless: { enabled: true },
			placement: { mode: "manual" },
			placements: [{ serverId: "proxy-server", count: 1 }],
			volumes: [{ name: "data", containerPath: "/data" }],
		});
	});

	it("accepts only branch and pull-request merge refs that Git can fetch safely", () => {
		expect(isSupportedGitRef("refs/heads/main")).toBe(true);
		expect(isSupportedGitRef("refs/heads/feature/preview-deployments")).toBe(
			true,
		);
		expect(isSupportedGitRef("refs/pull/42/merge")).toBe(true);

		for (const ref of [
			"main",
			"refs/heads//main",
			"refs/heads/feature/.hidden",
			"refs/heads/@",
			"refs/heads/feature.lock",
			"refs/pull/0/merge",
			"refs/pull/42/head",
		]) {
			expect(isSupportedGitRef(ref)).toBe(false);
		}
	});
});
