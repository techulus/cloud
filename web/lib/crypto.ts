import {
  randomBytes,
  verify,
  createPublicKey,
  createCipheriv,
  createDecipheriv,
} from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(key, "hex");
}

export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(encryptedBase64: string): string {
  const key = getEncryptionKey();
  const data = Buffer.from(encryptedBase64, "base64");

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8"
  );
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function verifyEd25519Signature(
  publicKeyBase64: string,
  message: Buffer | string,
  signatureBase64: string
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
