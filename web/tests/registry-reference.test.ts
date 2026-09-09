import { describe, expect, it } from "vitest";
import {
	canonicalizeRegistryHost,
	normalizeImageReference,
	parseRegistryEndpoint,
	registryAuthKey,
	resolveGarConfiguration,
} from "@/lib/registry-reference";

function serviceAccount(projectId: string) {
	return Buffer.from(
		JSON.stringify({
			type: "service_account",
			project_id: projectId,
			private_key:
				"-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
			client_email: `techulus@${projectId}.iam.gserviceaccount.com`,
			token_uri: "https://oauth2.googleapis.com/token",
		}),
	).toString("base64");
}

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
	it("parses a complete GAR configuration", () => {
		const key = serviceAccount("google-project");
		expect(
			resolveGarConfiguration({
				GAR_REPOSITORY:
					"us-central1-docker.pkg.dev/google-project/techulus-images",
				GAR_AGENT_KEY_BASE64: key,
			}),
		).toMatchObject({
			host: "us-central1-docker.pkg.dev",
			imageBase: "us-central1-docker.pkg.dev/google-project/techulus-images",
			agentKeyBase64: key,
		});
	});
	it.each([
		"https://us-central1-docker.pkg.dev/google-project/techulus",
		"us-central1-docker.pkg.dev/google-project",
		"us-central1-docker.pkg.dev/google-project/techulus/extra",
		"registry.example.com/google-project/techulus",
		"us-central1-docker.pkg.dev/Google-Project/techulus",
	])("rejects invalid GAR repository %s", (repository) => {
		const key = serviceAccount("google-project");
		expect(() =>
			resolveGarConfiguration({
				GAR_REPOSITORY: repository,
				GAR_AGENT_KEY_BASE64: key,
			}),
		).toThrow("GAR_REPOSITORY");
	});
	it("rejects malformed or non-service-account keys without exposing content", () => {
		const malformed = Buffer.from('{"type":"authorized_user"}').toString(
			"base64",
		);
		expect(() =>
			resolveGarConfiguration({
				GAR_REPOSITORY: "us-central1-docker.pkg.dev/google-project/techulus",
				GAR_AGENT_KEY_BASE64: malformed,
			}),
		).toThrow(
			"GAR_AGENT_KEY_BASE64 must be a base64-encoded service-account JSON key",
		);
	});
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
