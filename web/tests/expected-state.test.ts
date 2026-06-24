import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/acme-manager", () => ({
	getAllCertificatesForDomains: vi.fn(),
}));
vi.mock("@/lib/wireguard", () => ({ getWireGuardPeers: vi.fn() }));

import {
	buildExpectedContainersFromRows,
	buildTraefikRoutes,
} from "@/lib/agent/expected-state";

describe("expected-state pure builders", () => {
	it("groups container inputs by deployment and service deterministically", () => {
		const containers = buildExpectedContainersFromRows({
			deployments: [
				{
					id: "dep_bbbbbbbb",
					serviceId: "svc_1",
					ipAddress: "10.0.0.2",
				},
				{
					id: "dep_aaaaaaaa",
					serviceId: "svc_1",
					ipAddress: "10.0.0.1",
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
				{ serviceId: "svc_1", serverId: "server_remote", ipAddress: "10.0.0.2" },
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
});
