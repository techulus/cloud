import { describe, expect, it } from "vitest";
import { diffServiceRevisionSpecs } from "@/lib/service-revision-changes";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";

function spec(): ServiceRevisionSpec {
	return {
		schemaVersion: 1,
		image: "app:v1",
		hostname: "app",
		stateful: false,
		serverless: {
			enabled: false,
			sleepAfterSeconds: 300,
			wakeTimeoutSeconds: 60,
		},
		healthCheck: {
			cmd: "curl /health",
			interval: 10,
			timeout: 5,
			retries: 3,
			startPeriod: 30,
		},
		startCommand: null,
		resourceLimits: { cpuCores: null, memoryMb: null },
		placements: [{ serverId: "server-a", count: 1 }],
		ports: [
			{
				containerPort: 80,
				protocol: "http",
				isPublic: false,
				domain: null,
				externalPort: null,
				tlsPassthrough: false,
			},
		],
		secrets: [
			{ key: "TOKEN", encryptedValue: "cipher-one", updatedAt: "2026-01-01" },
		],
		volumes: [{ name: "data", containerPath: "/data" }],
	};
}

describe("diffServiceRevisionSpecs", () => {
	it("reports representative scalar and health check changes", () => {
		const previous = spec();
		const current = structuredClone(previous);
		current.image = "app:v2";
		current.hostname = "new-app";
		current.stateful = true;
		current.serverless = {
			enabled: true,
			sleepAfterSeconds: 600,
			wakeTimeoutSeconds: 90,
		};
		current.healthCheck = {
			cmd: "wget /ready",
			interval: 20,
			timeout: 8,
			retries: 5,
			startPeriod: 40,
		};
		current.startCommand = "npm start";
		current.resourceLimits = { cpuCores: 2, memoryMb: 512 };

		expect(diffServiceRevisionSpecs(previous, current)).toEqual(
			expect.arrayContaining([
				{ field: "Image", from: "app:v1", to: "app:v2" },
				{ field: "Health check start period", from: "30s", to: "40s" },
				{ field: "Start command", from: "(default)", to: "npm start" },
				{ field: "CPU limit", from: "(no limit)", to: "2 cores" },
				{ field: "Memory limit", from: "(no limit)", to: "512 MB" },
			]),
		);
	});

	it("compares collections and includes every port property", () => {
		const previous = spec();
		const current = structuredClone(previous);
		current.placements[0].count = 2;
		current.volumes[0].containerPath = "/mnt/data";
		current.ports[0] = {
			containerPort: 80,
			protocol: "http",
			isPublic: true,
			domain: "app.test",
			externalPort: 443,
			tlsPassthrough: true,
		};
		current.ports.push({
			containerPort: 80,
			protocol: "tcp",
			isPublic: false,
			domain: null,
			externalPort: 8080,
			tlsPassthrough: false,
		});

		const changes = diffServiceRevisionSpecs(
			previous,
			current,
			new Map([["server-a", "Sydney"]]),
		);
		expect(changes).toContainEqual({
			field: "Sydney replicas",
			from: "1 replicas",
			to: "2 replicas",
		});
		expect(changes).toContainEqual({
			field: "Volume data",
			from: "/data",
			to: "/mnt/data",
		});
		expect(changes).toContainEqual({
			field: "Port 80/http",
			from: "container 80, protocol http, internal, domain (none), external (default), TLS passthrough disabled",
			to: "(removed)",
		});
		expect(changes).toContainEqual({
			field: "Port 80/http",
			from: "(none)",
			to: "container 80, protocol http, public, domain app.test, external 443, TLS passthrough enabled",
		});
		expect(changes).toContainEqual(
			expect.objectContaining({ field: "Port 80/tcp" }),
		);
	});

	it("identifies deleted placement servers without exposing full IDs", () => {
		const previous = spec();
		const current = structuredClone(previous);
		current.placements[0].count = 2;

		expect(diffServiceRevisionSpecs(previous, current)).toContainEqual({
			field: "Deleted server (server-a) replicas",
			from: "1 replicas",
			to: "2 replicas",
		});
	});

	it("never exposes secret ciphertext while detecting additions, updates, and removals", () => {
		const previous = spec();
		previous.secrets.push({
			key: "OLD",
			encryptedValue: "do-not-leak-old",
			updatedAt: "1",
		});
		const current = structuredClone(previous);
		current.secrets = [
			{
				key: "TOKEN",
				encryptedValue: "do-not-leak-new",
				updatedAt: "2026-01-01",
			},
			{ key: "NEW", encryptedValue: "do-not-leak-added", updatedAt: "1" },
		];

		const changes = diffServiceRevisionSpecs(previous, current);
		expect(changes).toEqual([
			{ field: "Secret", from: "(none)", to: "NEW (added)" },
			{ field: "Secret", from: "OLD", to: "(removed)" },
			{ field: "Secret", from: "TOKEN", to: "TOKEN (updated)" },
		]);
		expect(JSON.stringify(changes)).not.toContain("do-not-leak");
	});

	it("ignores canonical-equivalent array ordering and identical specs", () => {
		const previous = spec();
		previous.placements.push({ serverId: "server-b", count: 2 });
		previous.ports.push({
			containerPort: 53,
			protocol: "udp",
			isPublic: false,
			domain: null,
			externalPort: null,
			tlsPassthrough: false,
		});
		previous.secrets.push({
			key: "OTHER",
			encryptedValue: "cipher-two",
			updatedAt: "2",
		});
		previous.volumes.push({ name: "logs", containerPath: "/logs" });
		const reordered = structuredClone(previous);
		reordered.placements.reverse();
		reordered.ports.reverse();
		reordered.secrets.reverse();
		reordered.volumes.reverse();

		expect(diffServiceRevisionSpecs(previous, reordered)).toEqual([]);
		expect(diffServiceRevisionSpecs(previous, previous)).toEqual([]);
	});
});
