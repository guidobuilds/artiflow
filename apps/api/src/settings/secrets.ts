import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { instanceSecret } from "../adapters/postgres/db/settings-schema.ts";
import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";

type Query = AppDb | AppTx;

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_ID_BYTES = 8;

export type SecretErrorCode = "key_missing" | "key_invalid" | "key_unknown" | "envelope_invalid" | "decrypt_failed";

export class SecretError extends Error {
  override name = "SecretError";
  readonly code: SecretErrorCode;

  constructor(code: SecretErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type SecretKey = {
  keyId: string;
  bytes: Buffer;
};

function keyIdOf(bytes: Buffer): string {
  return createHash("sha256")
    .update(bytes)
    .digest("hex")
    .slice(0, KEY_ID_BYTES * 2);
}

export function decodeSecretKey(encoded: string): SecretKey {
  const value = encoded.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new SecretError("key_invalid", "ARTIFLOW_SECRET_ENCRYPTION_KEY must be base64 that decodes to 32 bytes.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== KEY_BYTES) {
    throw new SecretError("key_invalid", "ARTIFLOW_SECRET_ENCRYPTION_KEY must be base64 that decodes to 32 bytes.");
  }
  return { keyId: keyIdOf(bytes), bytes };
}

export function encryptSecret(plaintext: string, key: SecretKey): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.bytes, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, key.keyId, iv.toString("base64"), ciphertext.toString("base64"), tag.toString("base64")].join(":");
}

function partsOf(envelope: string): { keyId: string; iv: Buffer; ciphertext: Buffer; tag: Buffer } {
  const parts = envelope.split(":");
  const [version, keyId, iv, ciphertext, tag] = parts;
  if (
    parts.length !== 5 ||
    version !== VERSION ||
    keyId === undefined ||
    iv === undefined ||
    ciphertext === undefined ||
    tag === undefined
  ) {
    throw new SecretError("envelope_invalid", "the stored secret is not a supported v1 envelope.");
  }
  return {
    keyId,
    iv: Buffer.from(iv, "base64"),
    ciphertext: Buffer.from(ciphertext, "base64"),
    tag: Buffer.from(tag, "base64"),
  };
}

export function decryptSecret(envelope: string, key: SecretKey | null): string {
  if (key === null) {
    throw new SecretError(
      "key_missing",
      "secret encryption is not configured: ARTIFLOW_SECRET_ENCRYPTION_KEY is unset and a stored secret cannot be read.",
    );
  }
  const parts = partsOf(envelope);
  if (parts.keyId !== key.keyId) {
    throw new SecretError(
      "key_unknown",
      "the stored secret was encrypted with an unknown key id; provide the matching ARTIFLOW_SECRET_ENCRYPTION_KEY.",
    );
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key.bytes, parts.iv);
    decipher.setAuthTag(parts.tag);
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretError("decrypt_failed", "the stored secret failed authentication and will not be returned.");
  }
}

export type SecretWrite = {
  name: string;
  value: string;
  key: SecretKey;
  updatedBy?: string | null;
};

export async function writeSecret(db: Query, input: SecretWrite): Promise<void> {
  const ciphertext = encryptSecret(input.value, input.key);
  await db
    .insert(instanceSecret)
    .values({ name: input.name, ciphertext, updatedBy: input.updatedBy ?? null })
    .onConflictDoUpdate({
      target: instanceSecret.name,
      set: { ciphertext, updatedAt: new Date(), updatedBy: input.updatedBy ?? null },
    });
}

export async function readSecret(db: Query, name: string, key: SecretKey | null): Promise<string | null> {
  const rows = await db
    .select({ ciphertext: instanceSecret.ciphertext })
    .from(instanceSecret)
    .where(eq(instanceSecret.name, name));
  const row = rows[0];
  if (row === undefined) return null;
  return decryptSecret(row.ciphertext, key);
}

export async function secretConfigured(db: Query, name: string): Promise<boolean> {
  const rows = await db.select({ name: instanceSecret.name }).from(instanceSecret).where(eq(instanceSecret.name, name));
  return rows.length > 0;
}
