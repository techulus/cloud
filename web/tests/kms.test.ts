import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	config: null as unknown,
	hasRegisteredServer: false,
	hasSecret: false,
	send: vi.fn(),
}));

vi.mock("@aws-sdk/client-kms", () => {
	class Command {
		constructor(public input: unknown) {}
	}
	return {
		DecryptCommand: class DecryptCommand extends Command {},
		DescribeKeyCommand: class DescribeKeyCommand extends Command {},
		EncryptCommand: class EncryptCommand extends Command {},
		GenerateDataKeyCommand: class GenerateDataKeyCommand extends Command {},
		KMSClient: class KMSClient {
			send = mocks.send;
		},
	};
});

vi.mock("@/db", () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn((table) => {
				const tableName = table[Symbol.for("drizzle:Name")];
				const rows = () => {
					if (tableName === "settings") {
						return mocks.config ? [{ value: mocks.config }] : [];
					}
					if (tableName === "secrets")
						return mocks.hasSecret ? [{ id: "secret" }] : [];
					return mocks.hasRegisteredServer ? [{ id: "server" }] : [];
				};
				return {
					limit: vi.fn(async () => rows()),
					where: vi.fn(() => ({ limit: vi.fn(async () => rows()) })),
				};
			}),
		})),
		insert: vi.fn(() => ({
			values: vi.fn((row: { value: unknown }) => ({
				onConflictDoNothing: vi.fn(async () => {
					mocks.config ??= row.value;
				}),
			})),
		})),
	},
}));

import {
	EncryptionKeyUnavailableError,
	resetEncryptionKeyCacheForTests,
	resolveEncryptionKey,
} from "@/lib/kms";

const KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/example";
const DEK = Buffer.alloc(32, 7);
const WRAPPED_DEK = Buffer.from("wrapped-dek");

describe("KMS encryption key resolution", () => {
	beforeEach(() => {
		mocks.config = null;
		mocks.hasRegisteredServer = false;
		mocks.hasSecret = false;
		mocks.send.mockReset();
		process.env.ENCRYPTION_KMS_KEY_ARN = KEY_ARN;
		process.env.AWS_REGION = "us-east-1";
		delete process.env.ENCRYPTION_KEY;
		resetEncryptionKeyCacheForTests();
	});

	afterEach(() => {
		delete process.env.ENCRYPTION_KMS_KEY_ARN;
		delete process.env.AWS_REGION;
		delete process.env.ENCRYPTION_KEY;
		resetEncryptionKeyCacheForTests();
	});

	it("bootstraps, stores, and decrypts a generated DEK", async () => {
		mocks.send.mockImplementation(async (command) => {
			if (command.constructor.name === "DescribeKeyCommand") {
				return {
					KeyMetadata: {
						KeyState: "Enabled",
						KeySpec: "SYMMETRIC_DEFAULT",
						KeyUsage: "ENCRYPT_DECRYPT",
					},
				};
			}
			if (command.constructor.name === "GenerateDataKeyCommand") {
				return { CiphertextBlob: WRAPPED_DEK, Plaintext: Buffer.alloc(32, 9) };
			}
			return { Plaintext: DEK };
		});

		await expect(resolveEncryptionKey()).resolves.toEqual(DEK);
		expect(mocks.config).toMatchObject({
			version: 1,
			keyArn: KEY_ARN,
			origin: "generated",
			wrappedDekBase64: WRAPPED_DEK.toString("base64"),
		});
		expect(mocks.send).toHaveBeenCalledTimes(3);
	});

	it("wraps the exact local key during migration", async () => {
		process.env.ENCRYPTION_KEY = DEK.toString("hex");
		mocks.send.mockImplementation(async (command) => {
			if (command.constructor.name === "DescribeKeyCommand") {
				return {
					KeyMetadata: {
						KeyState: "Enabled",
						KeySpec: "SYMMETRIC_DEFAULT",
						KeyUsage: "ENCRYPT_DECRYPT",
					},
				};
			}
			if (command.constructor.name === "EncryptCommand") {
				expect(Buffer.from(command.input.Plaintext)).toEqual(DEK);
				return { CiphertextBlob: WRAPPED_DEK };
			}
			return { Plaintext: DEK };
		});

		await expect(resolveEncryptionKey()).resolves.toEqual(DEK);
		expect(mocks.config).toMatchObject({ origin: "migrated" });
	});

	it("refuses to generate a new key when encrypted state already exists", async () => {
		mocks.hasSecret = true;
		mocks.send.mockResolvedValueOnce({
			KeyMetadata: {
				KeyState: "Enabled",
				KeySpec: "SYMMETRIC_DEFAULT",
				KeyUsage: "ENCRYPT_DECRYPT",
			},
		});

		await expect(resolveEncryptionKey()).rejects.toThrow(
			"ENCRYPTION_KEY is required to migrate existing secrets",
		);
		expect(mocks.config).toBeNull();
		expect(mocks.send).toHaveBeenCalledTimes(1);
	});

	it("rejects a leftover local key that does not match the stored key", async () => {
		process.env.ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("hex");
		mocks.config = {
			version: 1,
			keyArn: KEY_ARN,
			origin: "generated",
			wrappedAt: new Date().toISOString(),
			wrappedDekBase64: WRAPPED_DEK.toString("base64"),
		};
		mocks.send
			.mockResolvedValueOnce({
				KeyMetadata: {
					KeyState: "Enabled",
					KeySpec: "SYMMETRIC_DEFAULT",
					KeyUsage: "ENCRYPT_DECRYPT",
				},
			})
			.mockResolvedValueOnce({ Plaintext: DEK });

		await expect(resolveEncryptionKey()).rejects.toThrow(
			"ENCRYPTION_KEY does not match the stored KMS-wrapped encryption key",
		);
	});

	it("fails without replacing a config recorded for another ARN", async () => {
		mocks.config = {
			version: 1,
			keyArn: `${KEY_ARN}-other`,
			origin: "generated",
			wrappedAt: new Date().toISOString(),
			wrappedDekBase64: WRAPPED_DEK.toString("base64"),
		};

		await expect(resolveEncryptionKey()).rejects.toBeInstanceOf(
			EncryptionKeyUnavailableError,
		);
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("clears a failed initialization so the next operation retries", async () => {
		mocks.config = {
			version: 1,
			keyArn: KEY_ARN,
			origin: "generated",
			wrappedAt: new Date().toISOString(),
			wrappedDekBase64: WRAPPED_DEK.toString("base64"),
		};
		mocks.send
			.mockResolvedValueOnce({
				KeyMetadata: {
					KeyState: "Enabled",
					KeySpec: "SYMMETRIC_DEFAULT",
					KeyUsage: "ENCRYPT_DECRYPT",
				},
			})
			.mockRejectedValueOnce(new Error("KMS unavailable"))
			.mockResolvedValueOnce({
				KeyMetadata: {
					KeyState: "Enabled",
					KeySpec: "SYMMETRIC_DEFAULT",
					KeyUsage: "ENCRYPT_DECRYPT",
				},
			})
			.mockResolvedValueOnce({ Plaintext: DEK });

		await expect(resolveEncryptionKey()).rejects.toBeInstanceOf(
			EncryptionKeyUnavailableError,
		);
		await expect(resolveEncryptionKey()).resolves.toEqual(DEK);
		expect(mocks.send).toHaveBeenCalledTimes(4);
	});
});
