import { createHash, randomBytes } from "node:crypto";

export const INVITE_TOKEN_BYTES = 32;
export const INVITE_TTL_HOURS = 24;

const HOUR_MS = 3_600_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type IssuedInviteToken = { token: string; tokenHash: string; expiresAt: Date };

export function createInviteToken(now: Date = new Date()): IssuedInviteToken {
  const token = randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: hashInviteToken(token),
    expiresAt: new Date(now.getTime() + INVITE_TTL_HOURS * HOUR_MS),
  };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function canonicalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isEmailAddress(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

export function inviteUrl(publicOrigin: string, token: string): string {
  return `${publicOrigin}/register#token=${token}`;
}
