import * as crypto from "crypto";

/**
 * RFC 7636 helpers. The verifier never leaves this machine; only its SHA-256
 * challenge is sent when the ceremony starts, so an authorization code
 * intercepted on the way back is useless without this process.
 */

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkcePair(): PkcePair {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

export function generateState(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export function generateDeviceId(): string {
  return crypto.randomUUID();
}
