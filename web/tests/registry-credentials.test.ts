import { afterEach, describe, expect, it } from "vitest";
import { resetEncryptionKeyCacheForTests } from "@/lib/kms";
import {
	calculateRegistryBundleVersion,
	resolveSystemRegistryCredentials,
} from "@/lib/registry-credentials";

describe("registry credential bundles", () => {
	afterEach(() => {
		delete process.env.ENCRYPTION_KEY;
		resetEncryptionKeyCacheForTests();
	});

	it("deduplicates built-in endpoint aliases and canonicalizes Docker Hub", () => {
		const credentials = resolveSystemRegistryCredentials({
			REGISTRY_HOST: "docker.io",
			REGISTRY_URL: "https://index.docker.io",
			REGISTRY_USERNAME: "robot",
			REGISTRY_PASSWORD: "token",
			REGISTRY_INSECURE: "false",
		});
		expect(credentials).toHaveLength(1);
		expect(credentials[0]).toMatchObject({
			host: "docker.io",
			tlsVerify: true,
		});
	});

	it("rejects partial built-in configuration", () => {
		expect(() =>
			resolveSystemRegistryCredentials({
				REGISTRY_URL: "registry.example.com",
			}),
		).toThrow("incomplete");
	});

	it("produces a deterministic opaque version independent of row ordering", async () => {
		process.env.ENCRYPTION_KEY = "ab".repeat(32);
		resetEncryptionKeyCacheForTests();
		const rows = [
			{
				id: "2",
				host: "z.example",
				username: "z",
				encryptedPassword: "cipher-z",
				tlsVerify: true,
			},
			{
				id: "1",
				host: "a.example",
				username: "a",
				encryptedPassword: "cipher-a",
				tlsVerify: false,
			},
		];
		const first = await calculateRegistryBundleVersion(rows, []);
		const second = await calculateRegistryBundleVersion(
			[...rows].reverse(),
			[],
		);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(second).toBe(first);
	});
});
