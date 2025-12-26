import { randomBytes, verify, createPublicKey } from "crypto";

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
