import { afterEach, describe, expect, it } from "vitest";
import { resetEncryptionKeyCacheForTests } from "@/lib/kms";
import {
	calculateRegistryBundleVersion,
	resolveSystemRegistryCredentials,
} from "@/lib/registry-credentials";

const SERVICE_ACCOUNT_KEY = Buffer.from(
	JSON.stringify({
		type: "service_account",
		project_id: "google-project",
		private_key:
			"-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
		client_email: "techulus@google-project.iam.gserviceaccount.com",
		token_uri: "https://oauth2.googleapis.com/token",
	}),
).toString("base64");

describe("registry credential bundles", () => {
	afterEach(() => {
		delete process.env.ENCRYPTION_KEY;
		resetEncryptionKeyCacheForTests();
	});

	it("creates one TLS-only GAR writer credential", () => {
		const credentials = resolveSystemRegistryCredentials({
			GAR_REPOSITORY:
				"us-central1-docker.pkg.dev/google-project/techulus-images",
			GAR_AGENT_KEY_BASE64: SERVICE_ACCOUNT_KEY,
			GAR_ADMIN_KEY_BASE64: SERVICE_ACCOUNT_KEY,
		});
		expect(credentials).toHaveLength(1);
		expect(credentials[0]).toMatchObject({
			host: "us-central1-docker.pkg.dev",
			username: "_json_key_base64",
			password: SERVICE_ACCOUNT_KEY,
			tlsVerify: true,
		});
	});

	it("rejects partial GAR configuration", () => {
		expect(() =>
			resolveSystemRegistryCredentials({
				GAR_REPOSITORY:
					"us-central1-docker.pkg.dev/google-project/techulus-images",
			}),
		).toThrow("GAR_AGENT_KEY_BASE64");
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
