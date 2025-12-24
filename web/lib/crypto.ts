import { randomBytes, verify, createPublicKey } from "crypto";

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function verifyEd25519Signature(
  publicKeyBase64: string,
  message: string,
  signatureBase64: string
): boolean {
  try {
    const publicKeyBuffer = Buffer.from(publicKeyBase64, "base64");
    const signatureBuffer = Buffer.from(signatureBase64, "base64");
    const messageBuffer = Buffer.from(message);

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
