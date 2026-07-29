import { describe, expect, it } from "vitest";
import { canonicalDesired, planCanonicalConfiguration } from "@/lib/public-api";
import { parseConfigurationIfMatch } from "@/lib/public-api-routes";

const version = `sha256:${"a".repeat(64)}`;

describe("configuration plan protocol", () => {
	it.each([
		[null, null],
		[version, null],
		[`W/"${version}"`, null],
		[`"${version}", "${version}"`, null],
		[`"sha256:${"A".repeat(64)}"`, null],
		[`"${version}"`, version],
	])("parses If-Match %j", (input, expected) => {
		expect(parseConfigurationIfMatch(input)).toBe(expected);
	});

	it("normalizes an omitted private port domain to the apply representation", () => {
		const desired = canonicalDesired({
			name: "web",
			source: { type: "image", image: "nginx:1.27" },
			hostname: "web",
			ports: [{ containerPort: 8080, public: false }],
			placement: { mode: "automatic", replicas: 1 },
			healthCheck: null,
			startCommand: null,
			resources: null,
		});
		expect(desired.ports).toEqual([
			{ containerPort: 8080, public: false, domain: null },
		]);
	});

	it("treats GitHub repository casing as the same repository identity", () => {
		const current = {
			name: "web",
			source: {
				type: "github" as const,
				repository: "https://github.com/Techulus/Cloud",
				branch: "main",
				rootDir: null,
			},
			hostname: "web",
			ports: [],
			placement: { mode: "automatic" as const, replicas: 1 },
			healthCheck: null,
			startCommand: null,
			resources: null,
		};
		const result = planCanonicalConfiguration(current, {
			...current,
			source: {
				...current.source,
				repository: "https://github.com/techulus/cloud",
			},
		});

		expect(result.action).toBe("noop");
		expect(result.changes).toEqual([]);
	});

	it("sorts ports and manual placements deterministically", () => {
		const desired = canonicalDesired({
			name: "web",
			source: { type: "image", image: "nginx" },
			hostname: "web",
			ports: [
				{ containerPort: 9000, public: false },
				{ containerPort: 8000, public: false },
			],
			placement: {
				mode: "manual",
				placements: [
					{ serverId: "z", count: 1 },
					{ serverId: "a", count: 1 },
				],
			},
			healthCheck: null,
			startCommand: null,
			resources: null,
		});
		expect(desired.ports.map((port) => port.containerPort)).toEqual([
			8000, 9000,
		]);
		expect(
			desired.placement.mode === "manual" &&
				desired.placement.placements.map((placement) => placement.serverId),
		).toEqual(["a", "z"]);
	});

	it("reports every managed field change, including removals and null clears", () => {
		const current = {
			name: "old-web",
			source: {
				type: "github" as const,
				repository: "https://github.com/acme/web",
				branch: "develop",
				rootDir: "apps/web",
			},
			hostname: "web",
			ports: [{ containerPort: 8080, public: true, domain: "old.example.com" }],
			placement: {
				mode: "manual" as const,
				placements: [{ serverId: "server-a", count: 1 }],
			},
			healthCheck: {
				cmd: "curl localhost:8080",
				interval: 10,
				timeout: 5,
				retries: 3,
				startPeriod: 30,
			},
			startCommand: "npm start",
			resources: { cpuCores: 2, memoryMb: 512 },
		};
		const result = planCanonicalConfiguration(current, {
			name: "web",
			source: {
				type: "github",
				repository: "https://github.com/acme/web",
				branch: "main",
				rootDir: null,
			},
			hostname: "web-internal",
			ports: [{ containerPort: 3000, public: false }],
			placement: { mode: "automatic", replicas: 3 },
			healthCheck: null,
			startCommand: null,
			resources: null,
		});

		expect(result.action).toBe("updated");
		expect(result.currentVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(result.desiredVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(result.changes.map((change) => change.field)).toEqual([
			"name",
			"source.branch",
			"source.rootDir",
			"hostname",
			"ports",
			"placement.mode",
			"placement.placements",
			"placement.replicas",
			"healthCheck",
			"startCommand",
			"resources",
		]);
		expect(
			result.changes.find((change) => change.field === "source.rootDir"),
		).toEqual({ field: "source.rootDir", from: "apps/web", to: null });
		for (const change of JSON.parse(JSON.stringify(result.changes))) {
			expect(Object.hasOwn(change, "from")).toBe(true);
			expect(Object.hasOwn(change, "to")).toBe(true);
		}
	});

	it("produces a no-op and stable desired fingerprint for equivalent ordering", () => {
		const current = {
			name: "web",
			source: { type: "image" as const, image: "nginx" },
			hostname: "web",
			ports: [
				{ containerPort: 8000, public: false, domain: null },
				{ containerPort: 9000, public: false, domain: null },
			],
			placement: {
				mode: "manual" as const,
				placements: [
					{ serverId: "a", count: 1 },
					{ serverId: "z", count: 1 },
				],
			},
			healthCheck: null,
			startCommand: null,
			resources: null,
		};
		const desired = {
			name: "web",
			source: { type: "image" as const, image: "nginx" },
			hostname: "web",
			ports: [
				{ containerPort: 9000, public: false },
				{ containerPort: 8000, public: false },
			],
			placement: {
				mode: "manual" as const,
				placements: [
					{ serverId: "z", count: 1 },
					{ serverId: "a", count: 1 },
				],
			},
			healthCheck: null,
			startCommand: null,
			resources: null,
		};
		const first = planCanonicalConfiguration(current, desired);
		const second = planCanonicalConfiguration(current, {
			...desired,
			ports: desired.ports.toReversed(),
			placement: {
				...desired.placement,
				placements: desired.placement.placements.toReversed(),
			},
		});

		expect(first.action).toBe("noop");
		expect(first.changes).toEqual([]);
		expect(second.desiredVersion).toBe(first.desiredVersion);
	});
});
