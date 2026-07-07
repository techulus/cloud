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
	buildTraefikCertificateDomains,
	buildTraefikRoutes,
} from "@/lib/agent/expected-state";

describe("expected-state pure builders", () => {
	const deployedServerlessConfig = JSON.stringify({
		source: { type: "image", image: "nginx" },
		stateful: false,
		replicas: [],
		healthCheck: null,
		ports: [
			{
				port: 3000,
				isPublic: true,
				domain: "sleepy.example.com",
				protocol: "http",
			},
		],
		serverless: {
			enabled: true,
			sleepAfterSeconds: 300,
			wakeTimeoutSeconds: 120,
		},
	});

	it("groups container inputs by deployment and service deterministically", () => {
		const containers = buildExpectedContainersFromRows({
			deployments: [
				{
					id: "dep_bbbbbbbb",
					serviceId: "svc_1",
					ipAddress: "10.0.0.2",
					runtimeDesiredState: "stopped",
					trafficState: "active",
					observedPhase: "sleeping",
				},
				{
					id: "dep_aaaaaaaa",
					serviceId: "svc_1",
					ipAddress: "10.0.0.1",
					runtimeDesiredState: "running",
					trafficState: "active",
					observedPhase: "running",
				},
			] as any,
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
			] as any,
			secrets: [
				{ serviceId: "svc_1", key: "ZED", encryptedValue: "last" },
				{ serviceId: "svc_1", key: "ALPHA", encryptedValue: "first" },
			] as any,
			volumes: [
				{ serviceId: "svc_1", name: "cache", containerPath: "/var/cache" },
				{ serviceId: "svc_1", name: "data", containerPath: "/data" },
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
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "running",
					trafficState: "active",
					observedPhase: "running",
				},
			] as any,
			services: [
				{
					id: "svc_private",
					name: "private-api",
					image: "nginx",
					serverlessEnabled: true,
				},
			] as any,
			deploymentPorts: [],
			secrets: [],
			volumes: [],
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
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "stopped",
					trafficState: "active",
					observedPhase: "sleeping",
				},
			] as any,
			services: [
				{
					id: "svc_private",
					name: "private-api",
					image: "nginx",
					serverlessEnabled: false,
				},
			] as any,
			deploymentPorts: [],
			secrets: [],
			volumes: [],
		});

		expect(containers[0]).toMatchObject({
			deploymentId: "dep_stopped",
			desiredState: "stopped",
		});
	});

	it("marks public serverless deployments stopped while sleeping", () => {
		const containers = buildExpectedContainersFromRows({
			deployments: [
				{
					id: "dep_sleeping",
					serviceId: "svc_public",
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "stopped",
					trafficState: "active",
					observedPhase: "sleeping",
				},
			] as any,
			services: [
				{
					id: "svc_public",
					name: "public-api",
					image: "nginx",
					serverlessEnabled: true,
				},
			] as any,
			deploymentPorts: [],
			secrets: [],
			volumes: [],
		});

		expect(containers[0]).toMatchObject({
			deploymentId: "dep_sleeping",
			desiredState: "stopped",
		});
	});

	it("keeps deployed serverless sleeping while live serverless settings are disabled", () => {
		const containers = buildExpectedContainersFromRows({
			deployments: [
				{
					id: "dep_sleeping",
					serviceId: "svc_public",
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "stopped",
					trafficState: "active",
					observedPhase: "sleeping",
				},
			] as any,
			services: [
				{
					id: "svc_public",
					name: "public-api",
					image: "nginx",
					serverlessEnabled: false,
					deployedConfig: deployedServerlessConfig,
				},
			] as any,
			deploymentPorts: [],
			secrets: [],
			volumes: [],
		});

		expect(containers[0]).toMatchObject({
			deploymentId: "dep_sleeping",
			desiredState: "stopped",
		});
	});

	it("keeps drained serverless deployments without containers stopped", () => {
		const containers = buildExpectedContainersFromRows({
			deployments: [
				{
					id: "dep_draining",
					serviceId: "svc_public",
					ipAddress: "10.0.0.10",
					runtimeDesiredState: "stopped",
					trafficState: "draining",
					observedPhase: "sleeping",
					containerId: null,
				},
			] as any,
			services: [
				{
					id: "svc_public",
					name: "public-api",
					image: "nginx",
					serverlessEnabled: true,
				},
			] as any,
			deploymentPorts: [],
			secrets: [],
			volumes: [],
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
				{
					id: "svc_stateful",
					serverlessEnabled: true,
					stateful: true,
					serverlessSleepAfterSeconds: 300,
					serverlessWakeTimeoutSeconds: 120,
				},
			] as any,
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

	it("keeps wake metadata from deployed serverless config while live settings are disabled", () => {
		const routes = buildServerlessRoutesFromRows({
			serverId: "proxy_1",
			services: [
				{
					id: "svc_1",
					serverlessEnabled: false,
					stateful: false,
					serverlessSleepAfterSeconds: 60,
					serverlessWakeTimeoutSeconds: 60,
					deployedConfig: deployedServerlessConfig,
				},
			] as any,
			ports: [],
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

	it("keeps Traefik gateway route from deployed serverless ports while live ports are removed", () => {
		const ports = buildRuntimeRoutePorts(
			[
				{
					id: "svc_public",
					serverlessEnabled: false,
					stateful: false,
					deployedConfig: deployedServerlessConfig,
				},
			] as any,
			[],
		);

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
