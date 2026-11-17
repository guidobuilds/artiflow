import assert from "node:assert/strict";
import { test } from "node:test";

import { emailPasswordEnabled, type AuthConfig } from "../apps/api/src/auth.ts";

const config = (overrides: Partial<AuthConfig> = {}): AuthConfig => ({
  nodeEnv: "development",
  demoAuth: true,
  authSecret: "x".repeat(32),
  publicOrigin: "http://127.0.0.1:5173",
  authProviders: {},
  ...overrides,
});

test("production enables email/password login", () => {
  assert.equal(emailPasswordEnabled(config({ nodeEnv: "production", demoAuth: false })), true);
});

test("production enables email/password login even on a non-loopback origin", () => {
  assert.equal(
    emailPasswordEnabled(
      config({ nodeEnv: "production", demoAuth: false, publicOrigin: "https://artifact.example.com" }),
    ),
    true,
  );
});

test("development keeps the demo-auth loopback guards", () => {
  assert.equal(emailPasswordEnabled(config()), true);
  assert.equal(emailPasswordEnabled(config({ demoAuth: false })), false);
  assert.equal(emailPasswordEnabled(config({ publicOrigin: "https://artifact.example.com" })), false);
});

test("test and other environments fail closed", () => {
  assert.equal(emailPasswordEnabled(config({ nodeEnv: "test" })), false);
  assert.equal(emailPasswordEnabled(config({ nodeEnv: "test", demoAuth: false })), false);
});
