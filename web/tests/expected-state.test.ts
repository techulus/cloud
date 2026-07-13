import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/acme-manager", () => ({
	getAllCertificatesForDomains: vi.fn(),
}));
vi.mock("@/lib/wireguard", () => ({ getWireGuardPeers: vi.fn() }));

import {
	buildExpectedContainersFromRows,
	buildRuntimeRoutePorts,
	buildServerlessRoutesFromRows,
	buildServerlessTraefikRouteSets,
	buildTraefikCertificateDomains,
	buildTraefikRoutes,
	selectRuntimeServiceRevisions,
} from "@/lib/agent/expected-state";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";

describe("expected-state pure builders", () => {
	function revision(
		serviceId: string,
		overrides: Partial<ServiceRevisionSpec> = {},
	) {
		return {
			id: `rev_${serviceId}`,
			name: serviceId,
			serviceId,
			schemaVersion: 1,
			revisionId: `rev_${serviceId}`,
			specification: {
				schemaVersion: 1,
				serviceId,
				image: "nginx",
				hostname: serviceId,
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
				...overrides,
			},
		} as any;
	}

	function runtimeRevision(
		serviceId: string,
		overrides: Partial<ServiceRevisionSpec> = {},
	) {
		const revisionRow = revision(serviceId, overrides);
		return {
			id: serviceId,
			name: serviceId,
			revisionId: revisionRow.id,
			specification: revisionRow.specification,
		};
	}

	it("groups container inputs by deployment and service deterministically", () => {
		const containers = buildExpectedContainersFromRows({
			deployments: [
				{
					id: "dep_bbbbbbbb",
					serviceId: "svc_1",
					serviceRevisionId: "rev_svc_1",
					ipAddress: "10.0.0.2",
					runtimeDesiredState: "stopped",
					trafficState: "active",
					observedPhase: "sleeping",
				},
				{
					id: "dep_aaaaaaaa",
					serviceId: "svc_1",
					serviceRevisionId: "rev_svc_1",
					ipAddress: "10.0.0.1",
					runtimeDesiredState: "running",
					trafficState: "active",
					observedPhase: "running",
				},
			] as any,
			revisions: [
				revision("svc_1", {
					startCommand: "npm start",
					healthCheck: {
						cmd: "curl -f /health",
						interval: 10,
						timeout: 5,
						retries: 3,
						startPeriod: 30,
					},
					resourceLimits: { cpuCores: 1, memoryMb: 512 },
					serverless: {
						enabled: true,
						sleepAfterSeconds: 300,
						wakeTimeoutSeconds: 300,
					},
					ports: [
						{
							containerPort: 80,
							isPublic: true,
							domain: "api.example.com",
							protocol: "http",
							externalPort: null,
							tlsPassthrough: false,
						},
						{
							containerPort: 3000,
							isPublic: false,
							domain: null,
							protocol: "http",
							externalPort: null,
							tlsPassthrough: false,
						},
					],
					secrets: [
						{ key: "ZED", encryptedValue: "last" },
						{ key: "ALPHA", encryptedValue: "first" },
					],
					volumes: [
						{ name: "cache", containerPath: "/var/cache" },
						{ name: "data", containerPath: "/data" },
					],
				}),
			],
			services: [
				{
					id: "svc_1",
					name: "api",
					image: "nginx",
					startCommand: "npm start",
					healthCheckCmd: "curl -f /health",
					healthCheckInterval: null,
					healthCheckTimeout: null,
					healthCheckRetries: null,
					healthCheckStartPeriod: null,
					resourceCpuLimit: 1,
					resourceMemoryLimitMb: 512,
					serverlessEnabled: true,
				},
			] as any,
			deploymentPorts: [
				{ deploymentId: "dep_aaaaaaaa", hostPort: 30001, containerPort: 3000 },
				{ deploymentId: "dep_aaaaaaaa", hostPort: 80, containerPort: 80 },
				{ deploymentId: "dep_bbbbbbbb", hostPort: 30002, containerPort: 3000 },
				{ deploymentId: "dep_bbbbbbbb", hostPort: 81, containerPort: 80 },
			] as any,
		});

		expect(containers.map((container) => container.deploymentId)).toEqual([
			"dep_aaaaaaaa",
			"dep_bbbbbbbb",
		]);
		expect(containers[0]).toMatchObject({
			name: "svc_1-dep_aaaa",
			desiredState: "running",
			image: "docker.io/library/nginx",
			ports: [
				{ containerPort: 80, hostPort: 80 },
				{ containerPort: 3000, hostPort: 30001 },
			],
			publishLocalPorts: true,
			env: { ALPHA: "first", ZED: "last" },
			volumes: [
				{ name: "data", containerPath: "/data" },
				{ name: "cache", containerPath: "/var/cache" },
			],
		});
		expect(containers[0].healthCheck).toEqual({
			cmd: "curl -f /health",
			interval: 10,
			timeout: 5,
			retries: 3,
			startPeriod: 30,
		});
		expect(containers[1]).toMatchObject({
			deploymentId: "dep_bbbbbbbb",
			desiredState: "stopped",
		});
	});

	it("keeps the spec hash stable for duplicate container ports", () => {
		const build = (hostPorts: number[]) =>
			buildExpectedContainersFromRows({
				deployments: [
					{
						id: "dep_dns",
						serviceId: "svc_dns",
						serviceRevisionId: "rev_svc_dns",
						runtimeDesiredState: "running",
					},
				] as any,
				services: [{ id: "svc_dns", name: "dns" }] as any,
				revisions: [
					revision("svc_dns", {
						ports: [
							{
								containerPort: 53,
								isPublic: true,
								domain: null,
								protocol: "tcp",
								externalPort: null,
								tlsPassthrough: false,
							},
							{
								containerPort: 53,
								isPublic: true,
								domain: null,
								protocol: "udp",
								externalPort: null,
								tlsPassthrough: false,
							},
						],
					}),
				],
				deploymentPorts: hostPorts.map((hostPort) => ({
					deploymentId: "dep_dns",
					containerPort: 53,
					hostPort,
				})) as any,
			})[0];

		const first = build([30002, 30001]);
		const second = build([30001, 30002]);

		expect(first.ports).toEqual([
			{ containerPort: 53, hostPort: 30001 },
			{ containerPort: 53, hostPort: 30002 },
		]);
		expect(first.containerSpecHash).toBe(second.containerSpecHash);
	});

	it("rejects partial expected state when a deployment revision is missing", () => {
		expect(() =>
			buildExpectedContainersFromRows({
				deployments: [
					{
						id: "dep_missing_revision",
						serviceId: "svc_1",
						serviceRevisionId: "rev_missing",
						runtimeDesiredState: "running",
					},
				] as any,
				services: [{ id: "svc_1", name: "api" }] as any,
				revisions: [],
				deploymentPorts: [],
			}),
		).toThrow("Deployment dep_missing_revision has no service revision");
	});

	it("omits deployments whose service was soft-deleted", () => {
		expect(
			buildExpectedContainersFromRows({
				deployments: [
					{
						id: "dep_deleted_service",
						serviceId: "svc_1",
						serviceRevisionId: "rev_svc_1",
						runtimeDesiredState: "running",
					},
				] as any,
				services: [],
				revisions: [revision("svc_1")],
				deploymentPorts: [],
			}),
		).toEqual([]);
	});

	it("rejects partial expected state when deployment ports are incomplete", () => {
		expect(() =>
			buildExpectedContainersFromRows({
				deployments: [
					{
						id: "dep_incomplete_ports",
						serviceId: "svc_1",
						serviceRevisionId: "rev_svc_1",
						runtimeDesiredState: "running",
					},
				] as any,
				services: [{ id: "svc_1", name: "api" }] as any,
				revisions: [
					revision("svc_1", {
						ports: [
							{
								containerPort: 3000,
								isPublic: false,
								domain: null,
								protocol: "http",
								externalPort: null,
								tlsPassthrough: false,
							},
						],
					}),
				],
				deploymentPorts: [],
			}),
		).toThrow("Deployment dep_incomplete_ports has incomplete port allocation");
	});

	it("contains multiple active revisions to the authoritative revision", () => {
		const specification = runtimeRevision("svc_1").specification;
		const result = selectRuntimeServiceRevisions([
			{
				deploymentId: "dep_old",
				serviceId: "svc_1",
				serviceName: "api",
				serviceActiveRevisionId: "rev_old",
				revisionId: "rev_old",
				revisionServiceId: "svc_1",
				revisionSchemaVersion: 1,
				specification,
			},
			{
				deploymentId: "dep_new",
				serviceId: "svc_1",
				serviceName: "api",
				serviceActiveRevisionId: "rev_old",
				revisionId: "rev_new",
				revisionServiceId: "svc_1",
				revisionSchemaVersion: 1,
				specification,
			},
		]);

		expect(result.services).toHaveLength(1);
		expect(result.services[0]?.revisionId).toBe("rev_old");
		expect(result.errors[0]).toContain("multiple active revisions");
	});

	it("excludes desired running state from the container creation hash", () => {
		const build = (runtimeDesiredState: "running" | "stopped") =>
			buildExpectedContainersFromRows({
				deployments: [
					{
						id: "dep_1",
						serviceId: "svc_1",
						serviceRevisionId: "rev_svc_1",
						ipAddress: "10.0.0.1",
						runtimeDesiredState,
					},
				] as any,
				services: [{ id: "svc_1", name: "api" }] as any,
				revisions: [revision("svc_1")],
				deploymentPorts: [],
			})[0];

		expect(build("running").containerSpecHash).toBe(
			build("stopped").containerSpecHash,
		);
	});

	it("keeps HTTP local upstreams before remote upstreams", () => {
		const routes = buildTraefikRoutes({
			serverId: "server_local",
			ports: [
				{
					id: "port_1",
					serviceId: "svc_1",
					port: 3000,
					isPublic: true,
					protocol: "http",
					domain: "app.example.com",
				},
			] as any,
			routableDeployments: [
				{
					serviceId: "svc_1",
					serverId: "server_remote",
					ipAddress: "10.0.0.2",
				},
				{ serviceId: "svc_1", serverId: "server_local", ipAddress: "10.0.0.3" },
				{ serviceId: "svc_1", serverId: "server_local", ipAddress: "10.0.0.1" },
			] as any,
		});

		expect(routes.httpRoutes).toEqual([
			{
				id: "app.example.com",
				domain: "app.example.com",
				serviceId: "svc_1",
				upstreams: [
					{ url: "10.0.0.1:3000", weight: 5 },
					{ url: "10.0.0.3:3000", weight: 5 },
					{ url: "10.0.0.2:3000", weight: 1 },
				],
			},
		]);
	});

	it("keeps non-public serverless deployments running in expected state", () => {
		const containers = buildExpectedContainersFromRows({
			deployments: [
				{
					id: "dep_sleeping",
					serviceId: "svc_private",
					serviceRevisionId: "rev_svc_private",
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "running",
					trafficState: "active",
					observedPhase: "running",
				},
			] as any,
			revisions: [
				revision("svc_private", {
					serverless: {
						enabled: true,
						sleepAfterSeconds: 300,
						wakeTimeoutSeconds: 300,
					},
				}),
			],
			services: [
				{
					id: "svc_private",
					name: "private-api",
					image: "nginx",
					serverlessEnabled: true,
				},
			] as any,
			deploymentPorts: [],
		});

		expect(containers[0]).toMatchObject({
			deploymentId: "dep_sleeping",
			desiredState: "running",
		});
	});

	it("projects stopped runtime intent without checking route eligibility", () => {
		const containers = buildExpectedContainersFromRows({
			deployments: [
				{
					id: "dep_stopped",
					serviceId: "svc_private",
					serviceRevisionId: "rev_svc_private",
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "stopped",
					trafficState: "active",
					observedPhase: "sleeping",
				},
			] as any,
			revisions: [revision("svc_private")],
			services: [
				{
					id: "svc_private",
					name: "private-api",
					image: "nginx",
					serverlessEnabled: false,
				},
			] as any,
			deploymentPorts: [],
		});

		expect(containers[0]).toMatchObject({
			deploymentId: "dep_stopped",
			desiredState: "stopped",
			publishLocalPorts: false,
		});
	});

	it("marks public serverless deployments stopped while sleeping", () => {
		const containers = buildExpectedContainersFromRows({
			deployments: [
				{
					id: "dep_sleeping",
					serviceId: "svc_public",
					serviceRevisionId: "rev_svc_public",
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "stopped",
					trafficState: "active",
					observedPhase: "sleeping",
				},
			] as any,
			revisions: [
				revision("svc_public", {
					serverless: {
						enabled: true,
						sleepAfterSeconds: 300,
						wakeTimeoutSeconds: 300,
					},
				}),
			],
			services: [
				{
					id: "svc_public",
					name: "public-api",
					image: "nginx",
					serverlessEnabled: true,
				},
			] as any,
			deploymentPorts: [],
		});

		expect(containers[0]).toMatchObject({
			deploymentId: "dep_sleeping",
			desiredState: "stopped",
			publishLocalPorts: true,
		});
	});

	it("keeps revision serverless behavior while draft settings are disabled", () => {
		const containers = buildExpectedContainersFromRows({
			deployments: [
				{
					id: "dep_sleeping",
					serviceId: "svc_public",
					serviceRevisionId: "rev_svc_public",
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "stopped",
					trafficState: "active",
					observedPhase: "sleeping",
				},
			] as any,
			revisions: [
				revision("svc_public", {
					serverless: {
						enabled: true,
						sleepAfterSeconds: 300,
						wakeTimeoutSeconds: 120,
					},
				}),
			],
			services: [
				{
					id: "svc_public",
					name: "public-api",
					image: "nginx",
					serverlessEnabled: false,
				},
			] as any,
			deploymentPorts: [],
		});

		expect(containers[0]).toMatchObject({
			deploymentId: "dep_sleeping",
			desiredState: "stopped",
			publishLocalPorts: true,
		});
	});

	it("keeps drained serverless deployments without containers stopped", () => {
		const containers = buildExpectedContainersFromRows({
			deployments: [
				{
					id: "dep_draining",
					serviceId: "svc_public",
					serviceRevisionId: "rev_svc_public",
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "stopped",
					trafficState: "draining",
					observedPhase: "sleeping",
					containerId: null,
				},
			] as any,
			revisions: [
				revision("svc_public", {
					serverless: {
						enabled: true,
						sleepAfterSeconds: 300,
						wakeTimeoutSeconds: 300,
					},
				}),
			],
			services: [
				{
					id: "svc_public",
					name: "public-api",
					image: "nginx",
					serverlessEnabled: true,
				},
			] as any,
			deploymentPorts: [],
		});

		expect(containers[0]).toMatchObject({
			deploymentId: "dep_draining",
			desiredState: "stopped",
		});
	});

	it("routes owner proxy serverless HTTP services through the local wake gateway", () => {
		const routes = buildTraefikRoutes({
			serverId: "server_local",
			ports: [
				{
					id: "port_1",
					serviceId: "svc_serverless",
					port: 3000,
					isPublic: true,
					protocol: "http",
					domain: "sleepy.example.com",
				},
			] as any,
			routableDeployments: [],
			serverlessServiceIds: new Set(["svc_serverless"]),
		});

		expect(routes.httpRoutes).toEqual([
			{
				id: "sleepy.example.com",
				domain: "sleepy.example.com",
				serviceId: "svc_serverless",
				upstreams: [{ url: "127.0.0.1:18080", weight: 1 }],
			},
		]);
	});

	it("classifies owner proxy serverless routes without capability metadata", () => {
		const services: Parameters<
			typeof buildServerlessTraefikRouteSets
		>[0]["services"] = [
			runtimeRevision("svc_serverless", {
				serverless: {
					enabled: true,
					sleepAfterSeconds: 300,
					wakeTimeoutSeconds: 300,
				},
			}),
		];
		const ports: Parameters<typeof buildTraefikRoutes>[0]["ports"] = [
			{
				id: "port_1",
				serviceId: "svc_serverless",
				port: 3000,
				isPublic: true,
				protocol: "http",
				domain: "sleepy.example.com",
			},
		] as Parameters<typeof buildTraefikRoutes>[0]["ports"];

		const { serverlessServiceIds, serverlessRouteSuppressedServiceIds } =
			buildServerlessTraefikRouteSets({
				serverId: "proxy_1",
				services,
				proxyHostedServerlessDeployments: [
					{ serviceId: "svc_serverless", serverId: "proxy_1" },
				],
			});

		expect(Array.from(serverlessServiceIds)).toEqual(["svc_serverless"]);
		expect(Array.from(serverlessRouteSuppressedServiceIds)).toEqual([]);

		const routes = buildTraefikRoutes({
			serverId: "proxy_1",
			ports,
			routableDeployments: [],
			serverlessServiceIds,
			serverlessRouteSuppressedServiceIds,
		});

		expect(routes.httpRoutes).toEqual([
			{
				id: "sleepy.example.com",
				domain: "sleepy.example.com",
				serviceId: "svc_serverless",
				upstreams: [{ url: "127.0.0.1:18080", weight: 1 }],
			},
		]);
	});

	it("omits serverless HTTP routes on non-owner proxies", () => {
		const routes = buildTraefikRoutes({
			serverId: "proxy_2",
			ports: [
				{
					id: "port_1",
					serviceId: "svc_serverless",
					port: 3000,
					isPublic: true,
					protocol: "http",
					domain: "sleepy.example.com",
				},
			] as any,
			routableDeployments: [],
			serverlessRouteSuppressedServiceIds: new Set(["svc_serverless"]),
		});

		expect(routes.httpRoutes).toEqual([]);
	});

	it("keeps suppressed serverless HTTP domains in certificate selection", () => {
		const ports: Parameters<typeof buildTraefikCertificateDomains>[0] = [
			{
				id: "port_1",
				serviceId: "svc_serverless",
				port: 3000,
				isPublic: true,
				protocol: "http",
				domain: "sleepy.example.com",
				externalPort: null,
				tlsPassthrough: false,
			},
		];

		const routes = buildTraefikRoutes({
			serverId: "proxy_2",
			ports,
			routableDeployments: [],
			serverlessRouteSuppressedServiceIds: new Set(["svc_serverless"]),
		});

		expect(routes.httpRoutes).toEqual([]);
		expect(buildTraefikCertificateDomains(ports)).toEqual([
			"sleepy.example.com",
		]);
	});

	it("keeps worker-only serverless services on direct routes", () => {
		const routes = buildTraefikRoutes({
			serverId: "proxy_1",
			ports: [
				{
					id: "port_1",
					serviceId: "svc_worker_only",
					port: 3000,
					isPublic: true,
					protocol: "http",
					domain: "worker-only.example.com",
				},
			] as any,
			routableDeployments: [
				{
					serviceId: "svc_worker_only",
					serverId: "worker_1",
					ipAddress: "10.0.0.20",
				},
			] as any,
		});

		expect(routes.httpRoutes).toEqual([
			{
				id: "worker-only.example.com",
				domain: "worker-only.example.com",
				serviceId: "svc_worker_only",
				upstreams: [{ url: "10.0.0.20:3000", weight: 1 }],
			},
		]);
	});

	it("routes mixed serverless services through the gateway on owner proxies", () => {
		const routes = buildTraefikRoutes({
			serverId: "proxy_1",
			ports: [
				{
					id: "port_1",
					serviceId: "svc_mixed",
					port: 3000,
					isPublic: true,
					protocol: "http",
					domain: "mixed.example.com",
				},
			] as any,
			routableDeployments: [
				{
					serviceId: "svc_mixed",
					serverId: "worker_1",
					ipAddress: "10.0.0.30",
				},
			] as any,
			serverlessServiceIds: new Set(["svc_mixed"]),
		});

		expect(routes.httpRoutes).toEqual([
			{
				id: "mixed.example.com",
				domain: "mixed.example.com",
				serviceId: "svc_mixed",
				upstreams: [{ url: "127.0.0.1:18080", weight: 1 }],
			},
		]);
	});

	it("does not emit worker-direct fallback routes for non-owner mixed serverless services", () => {
		const routes = buildTraefikRoutes({
			serverId: "proxy_2",
			ports: [
				{
					id: "port_1",
					serviceId: "svc_mixed",
					port: 3000,
					isPublic: true,
					protocol: "http",
					domain: "mixed.example.com",
				},
			] as any,
			routableDeployments: [
				{
					serviceId: "svc_mixed",
					serverId: "worker_1",
					ipAddress: "10.0.0.30",
				},
			] as any,
			serverlessRouteSuppressedServiceIds: new Set(["svc_mixed"]),
		});

		expect(routes.httpRoutes).toEqual([]);
	});

	it("builds proxy-local serverless metadata with always-on worker upstreams", () => {
		const routes = buildServerlessRoutesFromRows({
			serverId: "proxy_1",
			services: [
				runtimeRevision("svc_1", {
					serverless: {
						enabled: true,
						sleepAfterSeconds: 300,
						wakeTimeoutSeconds: 120,
					},
				}),
			],
			ports: [
				{
					id: "port_1",
					serviceId: "svc_1",
					port: 3000,
					isPublic: true,
					protocol: "http",
					domain: "app.example.com",
				},
			] as any,
			deployments: [
				{
					id: "dep_proxy",
					serviceId: "svc_1",
					serverId: "proxy_1",
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "stopped",
					trafficState: "active",
					observedPhase: "sleeping",
					serverIsProxy: true,
				},
				{
					id: "dep_worker",
					serviceId: "svc_1",
					serverId: "worker_1",
					ipAddress: "10.0.0.20",
					runtimeDesiredState: "running",
					trafficState: "active",
					observedPhase: "healthy",
					serverIsProxy: false,
				},
				{
					id: "dep_stopped_stale_ready",
					serviceId: "svc_1",
					serverId: "worker_2",
					ipAddress: "10.0.0.30",
					runtimeDesiredState: "stopped",
					trafficState: "active",
					observedPhase: "healthy",
					serverIsProxy: false,
				},
			] as any,
			containers: [
				{
					deploymentId: "dep_proxy",
					desiredState: "stopped",
				},
			] as any,
		});

		expect(routes).toEqual([
			{
				serviceId: "svc_1",
				domain: "app.example.com",
				port: 3000,
				sleepAfterSeconds: 300,
				wakeTimeoutSeconds: 120,
				localDeploymentIds: ["dep_proxy"],
				upstreams: [
					{
						deploymentId: "dep_worker",
						serverId: "worker_1",
						url: "10.0.0.20:3000",
						local: false,
						alwaysOn: true,
					},
				],
			},
		]);
	});

	it("builds proxy-local serverless metadata for stateful services", () => {
		const routes = buildServerlessRoutesFromRows({
			serverId: "proxy_1",
			services: [
				runtimeRevision("svc_stateful", {
					stateful: true,
					serverless: {
						enabled: true,
						sleepAfterSeconds: 300,
						wakeTimeoutSeconds: 120,
					},
				}),
			],
			ports: [
				{
					id: "port_1",
					serviceId: "svc_stateful",
					port: 3000,
					isPublic: true,
					protocol: "http",
					domain: "db.example.com",
				},
			] as any,
			deployments: [
				{
					id: "dep_stateful",
					serviceId: "svc_stateful",
					serverId: "proxy_1",
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "stopped",
					trafficState: "active",
					observedPhase: "sleeping",
					serverIsProxy: true,
				},
			] as any,
			containers: [
				{
					deploymentId: "dep_stateful",
					desiredState: "stopped",
				},
			] as any,
		});

		expect(routes).toEqual([
			{
				serviceId: "svc_stateful",
				domain: "db.example.com",
				port: 3000,
				sleepAfterSeconds: 300,
				wakeTimeoutSeconds: 120,
				localDeploymentIds: ["dep_stateful"],
				upstreams: [],
			},
		]);
	});

	it("does not include draining serverless deployments as wakeable local deployments", () => {
		const routes = buildServerlessRoutesFromRows({
			serverId: "proxy_1",
			services: [
				runtimeRevision("svc_1", {
					serverless: {
						enabled: true,
						sleepAfterSeconds: 300,
						wakeTimeoutSeconds: 120,
					},
				}),
			],
			ports: [
				{
					id: "port_1",
					serviceId: "svc_1",
					port: 3000,
					isPublic: true,
					protocol: "http",
					domain: "app.example.com",
				},
			] as any,
			deployments: [
				{
					id: "dep_old",
					serviceId: "svc_1",
					serverId: "proxy_1",
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "stopped",
					trafficState: "draining",
					observedPhase: "sleeping",
					serverIsProxy: true,
				},
				{
					id: "dep_new",
					serviceId: "svc_1",
					serverId: "proxy_1",
					ipAddress: "10.0.0.11",
					runtimeDesiredState: "running",
					trafficState: "active",
					observedPhase: "running",
					serverIsProxy: true,
				},
			] as any,
			containers: [
				{ deploymentId: "dep_old", desiredState: "stopped" },
				{ deploymentId: "dep_new", desiredState: "running" },
			] as any,
		});

		expect(routes[0]?.localDeploymentIds).toEqual(["dep_new"]);
		expect(
			routes[0]?.upstreams.map((upstream) => upstream.deploymentId),
		).toEqual(["dep_new"]);
	});

	it("keeps wake metadata and ports pinned to the active revision", () => {
		const service = runtimeRevision("svc_1", {
			serverless: {
				enabled: true,
				sleepAfterSeconds: 300,
				wakeTimeoutSeconds: 120,
			},
			ports: [
				{
					containerPort: 3000,
					isPublic: true,
					domain: "sleepy.example.com",
					protocol: "http",
					externalPort: null,
					tlsPassthrough: false,
				},
			],
		});
		const routes = buildServerlessRoutesFromRows({
			serverId: "proxy_1",
			services: [service],
			ports: buildRuntimeRoutePorts([service]),
			deployments: [
				{
					id: "dep_sleeping",
					serviceId: "svc_1",
					serverId: "proxy_1",
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "stopped",
					trafficState: "active",
					observedPhase: "sleeping",
					serverIsProxy: true,
				},
			] as any,
			containers: [
				{ deploymentId: "dep_sleeping", desiredState: "stopped" },
			] as any,
		});

		expect(routes).toEqual([
			{
				serviceId: "svc_1",
				domain: "sleepy.example.com",
				port: 3000,
				sleepAfterSeconds: 300,
				wakeTimeoutSeconds: 120,
				localDeploymentIds: ["dep_sleeping"],
				upstreams: [],
			},
		]);
	});

	it("keeps Traefik gateway routes pinned to revision ports", () => {
		const ports = buildRuntimeRoutePorts([
			runtimeRevision("svc_public", {
				serverless: {
					enabled: true,
					sleepAfterSeconds: 300,
					wakeTimeoutSeconds: 120,
				},
				ports: [
					{
						containerPort: 3000,
						isPublic: true,
						domain: "sleepy.example.com",
						protocol: "http",
						externalPort: null,
						tlsPassthrough: false,
					},
				],
			}),
		]);

		const routes = buildTraefikRoutes({
			serverId: "proxy_1",
			ports,
			routableDeployments: [],
			serverlessServiceIds: new Set(["svc_public"]),
		});

		expect(routes.httpRoutes).toEqual([
			{
				id: "sleepy.example.com",
				domain: "sleepy.example.com",
				serviceId: "svc_public",
				upstreams: [{ url: "127.0.0.1:18080", weight: 1 }],
			},
		]);
	});

	it("omits serverless metadata for worker-only services", () => {
		const routes = buildServerlessRoutesFromRows({
			serverId: "proxy_1",
			services: [
				{
					id: "svc_1",
					serverlessEnabled: true,
					stateful: false,
					serverlessSleepAfterSeconds: 300,
					serverlessWakeTimeoutSeconds: 120,
				},
			] as any,
			ports: [
				{
					id: "port_1",
					serviceId: "svc_1",
					port: 3000,
					isPublic: true,
					protocol: "http",
					domain: "app.example.com",
				},
			] as any,
			deployments: [
				{
					id: "dep_worker",
					serviceId: "svc_1",
					serverId: "worker_1",
					ipAddress: "10.0.0.20",
					runtimeDesiredState: "running",
					trafficState: "active",
					observedPhase: "healthy",
					serverIsProxy: false,
				},
			] as any,
			containers: [],
		});

		expect(routes).toEqual([]);
	});
});
