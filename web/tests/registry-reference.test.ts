import { describe, expect, it } from "vitest";
import {
	canonicalizeRegistryHost,
	normalizeImageReference,
	parseRegistryEndpoint,
	registryAuthKey,
	resolveRegistryImageHost,
} from "@/lib/registry-reference";

describe("registry references", () => {
	it.each([
		["Example.COM:5000", "example.com:5000"],
		["index.docker.io", "docker.io"],
		["registry-1.docker.io", "docker.io"],
		["docker.io", "docker.io"],
	])("canonicalizes %s", (input, expected) =>
		expect(canonicalizeRegistryHost(input)).toBe(expected),
	);
	it.each([
		"https://example.com/path",
		"user@example.com",
		"example.com?x=1",
		"http://example.com/#x",
		"a..b",
		"a.-b.example",
		"a.b-.example",
		`${"a".repeat(64)}.example`,
	])("rejects endpoint decorations in %s", (input) =>
		expect(() => parseRegistryEndpoint(input)).toThrow(),
	);
	it("accepts an optional built-in endpoint scheme", () =>
		expect(parseRegistryEndpoint("https://REGISTRY.example:5443")).toBe(
			"registry.example:5443",
		));
	it("canonicalizes the configured public image host", () =>
		expect(
			resolveRegistryImageHost({
				REGISTRY_HOST: "https://REGISTRY.example:5443",
			}),
		).toBe("registry.example:5443"));
	it("uses Docker's special auth key", () =>
		expect(registryAuthKey("docker.io")).toBe("https://index.docker.io/v1/"));
	it.each([
		["alpine", "docker.io/library/alpine"],
		["index.docker.io/acme/api:v1", "docker.io/acme/api:v1"],
		["ghcr.io/acme/api", "ghcr.io/acme/api"],
	])("normalizes image %s", (input, expected) =>
		expect(normalizeImageReference(input)).toBe(expected),
	);
});
