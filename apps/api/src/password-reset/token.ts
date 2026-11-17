import { createHash, randomBytes } from "node:crypto";

export const PASSWORD_RESET_TOKEN_BYTES = 32;
export const PASSWORD_RESET_TTL_HOURS = 1;

const HOUR_MS = 3_600_000;

export type IssuedResetToken = { token: string; tokenHash: string; expiresAt: Date };

export function createResetToken(now: Date = new Date()): IssuedResetToken {
  const token = randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_HOURS * HOUR_MS),
  };
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function resetPasswordUrl(publicOrigin: string, token: string): string {
  return `${publicOrigin}/reset-password#token=${token}`;
}
