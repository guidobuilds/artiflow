import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { ConfigError, loadConfig } from "../apps/api/src/config.ts";
import {
  SecretError,
  decodeSecretKey,
  decryptSecret,
  encryptSecret,
  type SecretErrorCode,
  type SecretKey,
} from "../apps/api/src/settings/secrets.ts";

const PLAINTEXT = "provider-client-secret-4f1c";

function keyFrom(bytes: Buffer): SecretKey {
  return decodeSecretKey(bytes.toString("base64"));
}

function freshKey(): SecretKey {
  return keyFrom(randomBytes(32));
}

function isSecretError(code: SecretErrorCode) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof SecretError, "a typed secret error is raised");
    assert.equal(error.code, code);
    assert.equal(error.message.includes(PLAINTEXT), false, "the error never carries the plaintext");
    return true;
  };
}

function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: "development",
    ARTIFLOW_API_HOST: "127.0.0.1",
    ARTIFLOW_API_PORT: "8787",
    ARTIFLOW_PUBLIC_ORIGIN: "http://127.0.0.1:5173",
    ARTIFLOW_DEMO_AUTH: "1",
    ARTIFLOW_AUTH_SECRET: "test-only-fixed-nonsecret-value-0123456789",
    DATABASE_URL: "postgres://artiflow:local-db-secret@127.0.0.1:5432/artiflow",
    ARTIFLOW_S3_ENDPOINT: "http://127.0.0.1:9000",
    ARTIFLOW_S3_REGION: "us-east-1",
    ARTIFLOW_S3_BUCKET: "artiflow-local",
    ARTIFLOW_S3_ACCESS_KEY_ID: "local-access-key",
    ARTIFLOW_S3_SECRET_ACCESS_KEY: "local-secret-key",
  };
}

test("a secret survives a round trip and the envelope names its version, key id, iv, ciphertext and tag", () => {
  const key = freshKey();

  const envelope = encryptSecret(PLAINTEXT, key);

  assert.equal(decryptSecret(envelope, key), PLAINTEXT);
  const parts = envelope.split(":");
  assert.equal(parts.length, 5);
  assert.equal(parts[0], "v1");
  assert.equal(parts[1], key.keyId);
  for (const part of parts.slice(1)) assert.ok(Buffer.from(part ?? "", "base64").length > 0, "each part is base64");
});

test("the stored ciphertext never carries the plaintext", () => {
  const key = freshKey();

  const envelope = encryptSecret(PLAINTEXT, key);

  assert.equal(envelope.includes(PLAINTEXT), false);
  assert.equal(envelope.includes(Buffer.from(PLAINTEXT).toString("base64")), false);
  assert.equal(envelope.includes(Buffer.from(PLAINTEXT).toString("hex")), false);
  for (const part of envelope.split(":").slice(2)) {
    assert.equal(Buffer.from(part ?? "", "base64").toString("utf8").includes(PLAINTEXT), false);
  }
});

test("two encryptions of the same plaintext differ, so the iv is fresh", () => {
  const key = freshKey();

  assert.notEqual(encryptSecret(PLAINTEXT, key), encryptSecret(PLAINTEXT, key));
});

test("a wrong key under the same key id fails the tag check", () => {
  const key = freshKey();
  const other = randomBytes(32);
  const impostor: SecretKey = { keyId: key.keyId, bytes: other };

  const envelope = encryptSecret(PLAINTEXT, key);

  assert.throws(() => decryptSecret(envelope, impostor), isSecretError("decrypt_failed"));
});

test("a tampered ciphertext is refused instead of returning bytes", () => {
  const key = freshKey();
  const parts = encryptSecret(PLAINTEXT, key).split(":");
  const ciphertext = Buffer.from(parts[3] ?? "", "base64");
  ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
  const tampered = [parts[0], parts[1], parts[2], ciphertext.toString("base64"), parts[4]].join(":");

  assert.throws(() => decryptSecret(tampered, key), isSecretError("decrypt_failed"));
});

test("a tampered authentication tag is refused", () => {
  const key = freshKey();
  const parts = encryptSecret(PLAINTEXT, key).split(":");
  const tag = Buffer.from(parts[4] ?? "", "base64");
  tag[0] = (tag[0] ?? 0) ^ 0xff;
  const tampered = [parts[0], parts[1], parts[2], parts[3], tag.toString("base64")].join(":");

  assert.throws(() => decryptSecret(tampered, key), isSecretError("decrypt_failed"));
});

test("a secret encrypted under another key id reports the unknown key id", () => {
  const envelope = encryptSecret(PLAINTEXT, freshKey());

  assert.throws(() => decryptSecret(envelope, freshKey()), isSecretError("key_unknown"));
});

test("a missing encryption key fails closed", () => {
  const envelope = encryptSecret(PLAINTEXT, freshKey());

  assert.throws(() => decryptSecret(envelope, null), isSecretError("key_missing"));
});

test("malformed envelopes and unsupported versions are refused", () => {
  const key = freshKey();

  for (const envelope of ["", "v1", "v1:keyid:iv", "v2:keyid:aXY=:Y3Q=:dGFn", "v1:keyid:aXY=:Y3Q=:dGFn:extra"]) {
    assert.throws(() => decryptSecret(envelope, key), isSecretError("envelope_invalid"));
  }
});

test("key material must be base64 for exactly 32 bytes", () => {
  assert.equal(decodeSecretKey(randomBytes(32).toString("base64")).bytes.length, 32);
  assert.throws(() => decodeSecretKey(randomBytes(16).toString("base64")), isSecretError("key_invalid"));
  assert.throws(() => decodeSecretKey(randomBytes(33).toString("base64")), isSecretError("key_invalid"));
  assert.throws(() => decodeSecretKey("not base64 at all!"), isSecretError("key_invalid"));
});

test("the configuration keeps the encryption key optional and reads it when present", () => {
  const withoutKey = loadConfig(baseEnv());
  assert.equal(withoutKey.secretEncryptionKey, null);

  const bytes = randomBytes(32);
  const withKey = loadConfig({ ...baseEnv(), ARTIFLOW_SECRET_ENCRYPTION_KEY: bytes.toString("base64") });
  assert.equal(withKey.secretEncryptionKey?.keyId, decodeSecretKey(bytes.toString("base64")).keyId);
});

test("an invalid encryption key is reported by name without echoing its value", () => {
  const value = "short-not-a-32-byte-key";

  assert.throws(
    () => loadConfig({ ...baseEnv(), ARTIFLOW_SECRET_ENCRYPTION_KEY: value }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.message.includes("ARTIFLOW_SECRET_ENCRYPTION_KEY"));
      assert.equal(error.message.includes(value), false);
      return true;
    },
  );
});
