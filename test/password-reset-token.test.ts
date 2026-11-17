import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  PASSWORD_RESET_TOKEN_BYTES,
  PASSWORD_RESET_TTL_HOURS,
  createResetToken,
  hashResetToken,
  resetPasswordUrl,
} from "../apps/api/src/password-reset/token.ts";

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

test("a reset token is 32 random bytes as unpadded base64url", () => {
  const issued = createResetToken();
  assert.equal(PASSWORD_RESET_TOKEN_BYTES, 32);
  assert.equal(issued.token.length, 43);
  assert.equal(BASE64URL_43.test(issued.token), true, `not base64url: ${issued.token}`);
  assert.equal(Buffer.from(issued.token, "base64url").length, 32);
});

test("two issued tokens never repeat", () => {
  const tokens = new Set(Array.from({ length: 32 }, () => createResetToken().token));
  assert.equal(tokens.size, 32);
});

test("only the SHA-256 hex digest of the token is stored", () => {
  const issued = createResetToken();
  assert.equal(HEX_SHA256.test(issued.tokenHash), true, `not a hex digest: ${issued.tokenHash}`);
  assert.equal(issued.tokenHash, createHash("sha256").update(issued.token).digest("hex"));
  assert.equal(hashResetToken(issued.token), issued.tokenHash);
  assert.notEqual(hashResetToken(createResetToken().token), issued.tokenHash);
});

test("a reset link expires one hour after it is issued", () => {
  const now = new Date("2024-01-01T00:00:00.000Z");
  const issued = createResetToken(now);
  assert.equal(PASSWORD_RESET_TTL_HOURS, 1);
  assert.equal(issued.expiresAt.toISOString(), "2024-01-01T01:00:00.000Z");
});

test("the URL carries the token in the fragment of the reset page", () => {
  const issued = createResetToken();
  const url = resetPasswordUrl("http://127.0.0.1:5399", issued.token);
  assert.equal(url, `http://127.0.0.1:5399/reset-password#token=${issued.token}`);
  assert.equal(url.includes(issued.tokenHash), false, "the URL never carries the stored digest");
});
