import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
	resetEncryptionKeyCacheForTests,
	resolveEncryptionKey,
} from "@/lib/kms";

const KEY = "ab".repeat(32);

describe("secret encryption", () => {
	beforeEach(() => {
		delete process.env.ENCRYPTION_KMS_KEY_ARN;
		process.env.ENCRYPTION_KEY = KEY;
		resetEncryptionKeyCacheForTests();
	});

	afterEach(() => {
		delete process.env.ENCRYPTION_KEY;
		resetEncryptionKeyCacheForTests();
	});

	it("preserves the AES-256-GCM framing and round trips", async () => {
		const encrypted = await encryptSecret("top secret");
		const decrypted = await decryptSecret(encrypted);
		const framed = Buffer.from(encrypted, "base64");
		const encryptionKey = await resolveEncryptionKey();

		expect(framed.length).toBe(12 + 16 + Buffer.byteLength("top secret"));
		expect(decrypted).toBe("top secret");
		expect(encryptionKey.toString("hex")).toBe(KEY);
	});

	it("fails authentication when the key changes", async () => {
		const encrypted = await encryptSecret("top secret");
		process.env.ENCRYPTION_KEY = "cd".repeat(32);
		resetEncryptionKeyCacheForTests();

		await expect(decryptSecret(encrypted)).rejects.toThrow();
	});
});
