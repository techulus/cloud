import {
	createCipheriv,
	createDecipheriv,
	createPublicKey,
	randomBytes,
	verify,
} from "node:crypto";
import { resolveEncryptionKey } from "@/lib/kms";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export async function getEncryptionKeyHex(): Promise<string> {
	return (await resolveEncryptionKey()).toString("hex");
}

export async function encryptSecret(plaintext: string): Promise<string> {
	const key = await resolveEncryptionKey();
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, key, iv);

	const encrypted = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	const authTag = cipher.getAuthTag();

	return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export async function decryptSecret(encryptedBase64: string): Promise<string> {
	const key = await resolveEncryptionKey();
	const data = Buffer.from(encryptedBase64, "base64");

	const iv = data.subarray(0, IV_LENGTH);
	const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
	const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

	const decipher = createDecipheriv(ALGORITHM, key, iv);
	decipher.setAuthTag(authTag);

	const decrypted = Buffer.concat([
		decipher.update(ciphertext),
		decipher.final(),
	]);

	return decrypted.toString("utf8");
}

export function verifyEd25519Signature(
	publicKeyBase64: string,
	message: Buffer | string,
	signatureBase64: string,
): boolean {
	try {
		const publicKeyBuffer = Buffer.from(publicKeyBase64, "base64");
		const signatureBuffer = Buffer.from(signatureBase64, "base64");
		const messageBuffer = Buffer.isBuffer(message)
			? message
			: Buffer.from(message);

		if (publicKeyBuffer.length !== 32) {
			console.error("Invalid public key length:", publicKeyBuffer.length);
			return false;
		}
		if (signatureBuffer.length !== 64) {
			console.error("Invalid signature length:", signatureBuffer.length);
			return false;
		}

		const publicKeyDer = Buffer.concat([
			Buffer.from("302a300506032b6570032100", "hex"),
			publicKeyBuffer,
		]);

		const publicKey = createPublicKey({
			key: publicKeyDer,
			format: "der",
			type: "spki",
		});

		return verify(null, messageBuffer, publicKey, signatureBuffer);
	} catch (e) {
		console.error("Signature verification error:", e);
		return false;
	}
}
