import { timingSafeEqual } from "node:crypto";
import {
	DecryptCommand,
	DescribeKeyCommand,
	EncryptCommand,
	GenerateDataKeyCommand,
	KMSClient,
} from "@aws-sdk/client-kms";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { secrets, servers, settings } from "@/db/schema";
import {
	type KmsEncryptionConfig,
	kmsEncryptionConfigSchema,
	SETTING_KEYS,
} from "@/lib/settings-keys";

const ENCRYPTION_CONTEXT = {
	"techulus:purpose": "service-secret-dek",
} as const;
const DEK_LENGTH = 32;
const KMS_KEY_ARN_PATTERN =
	/^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/;

export class EncryptionKeyUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "EncryptionKeyUnavailableError";
	}
}

let encryptionKeyPromise: Promise<Buffer> | undefined;

function parseLocalKey(): Buffer | null {
	const value = process.env.ENCRYPTION_KEY;
	if (!value) return null;
	if (!/^[0-9a-fA-F]{64}$/.test(value)) {
		throw new EncryptionKeyUnavailableError(
			"ENCRYPTION_KEY must be 64 hex characters (32 bytes)",
		);
	}
	return Buffer.from(value, "hex");
}

function decodeWrappedDek(value: string): Buffer {
	const decoded = Buffer.from(value, "base64");
	if (!value || decoded.length === 0 || decoded.toString("base64") !== value) {
		throw new EncryptionKeyUnavailableError(
			"Stored KMS encryption configuration contains an invalid wrapped DEK",
		);
	}
	return decoded;
}

async function readConfig(): Promise<KmsEncryptionConfig | null> {
	const rows = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, SETTING_KEYS.KMS_ENCRYPTION_CONFIG))
		.limit(1);
	if (!rows[0]) return null;

	const parsed = kmsEncryptionConfigSchema.safeParse(rows[0].value);
	if (!parsed.success) {
		throw new EncryptionKeyUnavailableError(
			"Stored KMS encryption configuration is invalid",
			{ cause: parsed.error },
		);
	}
	return parsed.data;
}

async function hasExistingEncryptionState(): Promise<boolean> {
	const [secretRows, registeredServerRows] = await Promise.all([
		db.select({ id: secrets.id }).from(secrets).limit(1),
		db
			.select({ id: servers.id })
			.from(servers)
			.where(isNotNull(servers.tokenUsedAt))
			.limit(1),
	]);
	return secretRows.length > 0 || registeredServerRows.length > 0;
}

async function createCandidate(
	client: KMSClient,
	keyArn: string,
): Promise<KmsEncryptionConfig> {
	const localKey = parseLocalKey();
	if (localKey) {
		const result = await client.send(
			new EncryptCommand({
				KeyId: keyArn,
				Plaintext: localKey,
				EncryptionContext: ENCRYPTION_CONTEXT,
			}),
		);
		if (!result.CiphertextBlob) {
			throw new Error("KMS Encrypt did not return a ciphertext blob");
		}
		console.info("[kms] wrapped the existing encryption key");
		return {
			version: 1,
			keyArn,
			wrappedDekBase64: Buffer.from(result.CiphertextBlob).toString("base64"),
			wrappedAt: new Date().toISOString(),
			origin: "migrated",
		};
	}
	if (await hasExistingEncryptionState()) {
		throw new EncryptionKeyUnavailableError(
			"ENCRYPTION_KEY is required to migrate existing secrets or registered agents to AWS KMS",
		);
	}

	const result = await client.send(
		new GenerateDataKeyCommand({
			KeyId: keyArn,
			KeySpec: "AES_256",
			EncryptionContext: ENCRYPTION_CONTEXT,
		}),
	);
	if (!result.CiphertextBlob) {
		throw new Error("KMS GenerateDataKey did not return a ciphertext blob");
	}
	console.info("[kms] generated a new encryption key");
	return {
		version: 1,
		keyArn,
		wrappedDekBase64: Buffer.from(result.CiphertextBlob).toString("base64"),
		wrappedAt: new Date().toISOString(),
		origin: "generated",
	};
}

async function initializeEncryptionKey(): Promise<Buffer> {
	const keyArn = process.env.ENCRYPTION_KMS_KEY_ARN;
	if (!keyArn) {
		const localKey = parseLocalKey();
		if (!localKey) {
			throw new EncryptionKeyUnavailableError(
				"ENCRYPTION_KEY must be 64 hex characters (32 bytes)",
			);
		}
		return localKey;
	}
	if (!process.env.AWS_REGION) {
		throw new EncryptionKeyUnavailableError(
			"AWS_REGION is required when ENCRYPTION_KMS_KEY_ARN is configured",
		);
	}
	if (!KMS_KEY_ARN_PATTERN.test(keyArn)) {
		throw new EncryptionKeyUnavailableError(
			"ENCRYPTION_KMS_KEY_ARN must be a full AWS KMS key ARN",
		);
	}

	try {
		const client = new KMSClient({ region: process.env.AWS_REGION });
		let config = await readConfig();
		if (config && config.keyArn !== keyArn) {
			throw new EncryptionKeyUnavailableError(
				`Configured KMS key ARN does not match the stored key ARN (${config.keyArn})`,
			);
		}

		const description = await client.send(
			new DescribeKeyCommand({ KeyId: keyArn }),
		);
		if (
			description.KeyMetadata?.KeyUsage !== "ENCRYPT_DECRYPT" ||
			description.KeyMetadata?.KeySpec !== "SYMMETRIC_DEFAULT"
		) {
			throw new Error("KMS key must be a symmetric encryption key");
		}
		if (description.KeyMetadata.KeyState !== "Enabled") {
			throw new Error(
				`KMS key must be enabled (current state: ${description.KeyMetadata.KeyState ?? "unknown"})`,
			);
		}

		if (!config) {
			const candidate = await createCandidate(client, keyArn);
			await db
				.insert(settings)
				.values({
					key: SETTING_KEYS.KMS_ENCRYPTION_CONFIG,
					value: candidate,
				})
				.onConflictDoNothing({ target: settings.key });
			config = await readConfig();
			if (!config) {
				throw new Error("Failed to read stored KMS encryption configuration");
			}
		}

		if (config.keyArn !== keyArn) {
			throw new EncryptionKeyUnavailableError(
				`Configured KMS key ARN does not match the stored key ARN (${config.keyArn})`,
			);
		}
		const result = await client.send(
			new DecryptCommand({
				KeyId: keyArn,
				CiphertextBlob: decodeWrappedDek(config.wrappedDekBase64),
				EncryptionContext: ENCRYPTION_CONTEXT,
			}),
		);
		const plaintext = result.Plaintext && Buffer.from(result.Plaintext);
		if (!plaintext || plaintext.length !== DEK_LENGTH) {
			throw new Error("KMS returned an invalid encryption key length");
		}
		const localKey = parseLocalKey();
		if (localKey) {
			if (!timingSafeEqual(localKey, plaintext)) {
				throw new EncryptionKeyUnavailableError(
					"ENCRYPTION_KEY does not match the stored KMS-wrapped encryption key",
				);
			}
			console.warn(
				"[kms] ENCRYPTION_KEY matches the wrapped key and can be removed after migration verification",
			);
		}
		return plaintext;
	} catch (error) {
		if (error instanceof EncryptionKeyUnavailableError) throw error;
		throw new EncryptionKeyUnavailableError(
			"AWS KMS encryption key is unavailable",
			{ cause: error },
		);
	}
}

export function resolveEncryptionKey(): Promise<Buffer> {
	if (!encryptionKeyPromise) {
		encryptionKeyPromise = initializeEncryptionKey().catch((error) => {
			encryptionKeyPromise = undefined;
			throw error;
		});
	}
	return encryptionKeyPromise;
}

export function resetEncryptionKeyCacheForTests(): void {
	encryptionKeyPromise = undefined;
}
