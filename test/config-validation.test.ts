import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ConfigError, loadConfig } from "../apps/api/src/config.ts";

const TEST_AUTH_SECRET = "3f9c1d7a5b2e8046c9f1a3d5e7b90246";

function developmentEnv(): Record<string, string> {
  return {
    NODE_ENV: "development",
    ARTIFLOW_API_HOST: "127.0.0.1",
    ARTIFLOW_API_PORT: "8787",
    ARTIFLOW_PUBLIC_ORIGIN: "http://127.0.0.1:5173",
    ARTIFLOW_DEMO_AUTH: "1",
    ARTIFLOW_AUTH_SECRET: TEST_AUTH_SECRET,
    DATABASE_URL: "postgres://artiflow:local-db-secret@127.0.0.1:5432/artiflow",
    ARTIFLOW_S3_ENDPOINT: "http://127.0.0.1:9000",
    ARTIFLOW_S3_REGION: "us-east-1",
    ARTIFLOW_S3_BUCKET: "artiflow-local",
    ARTIFLOW_S3_ACCESS_KEY_ID: "local-access-key",
    ARTIFLOW_S3_SECRET_ACCESS_KEY: "local-secret-key",
  };
}

function productionEnv(): Record<string, string> {
  return {
    NODE_ENV: "production",
    ARTIFLOW_PUBLIC_ORIGIN: "https://artifacts.example.com",
    ARTIFLOW_AUTH_SECRET: TEST_AUTH_SECRET,
    DATABASE_URL: "postgres://artiflow:db-password@db.example.com:5432/artiflow?sslmode=verify-full",
    ARTIFLOW_S3_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
    ARTIFLOW_S3_REGION: "auto",
    ARTIFLOW_S3_BUCKET: "artiflow",
    ARTIFLOW_S3_ACCESS_KEY_ID: "prod-access-key",
    ARTIFLOW_S3_SECRET_ACCESS_KEY: "prod-secret-key",
  };
}

function rejectionMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ConfigError, "expected a ConfigError");
    return error.message;
  }
  assert.fail("expected the configuration to be rejected");
}

const PLACEHOLDER_SECRETS = [
  "replace-with-openssl-rand-hex-32",
  "replace-with-your-own-random-secret",
  "changeme-changeme-changeme-changeme",
  "change-me-0123456789abcdef0123456789",
  "placeholder-secret-value-0123456789ab",
];

for (const [index, secret] of PLACEHOLDER_SECRETS.entries()) {
  test(`rejects placeholder auth secret #${index}`, () => {
    const message = rejectionMessage(() => loadConfig({ ...developmentEnv(), ARTIFLOW_AUTH_SECRET: secret }));

    assert.match(message, /ARTIFLOW_AUTH_SECRET/);
    assert.match(message, /openssl rand/);
    assert.ok(!message.includes(secret), "the rejection must never echo the rejected secret");
  });
}

const LOW_ENTROPY_SECRETS = ["a".repeat(48), "ab".repeat(24), "abcd1234".repeat(5), "fixme".repeat(8)];

for (const [index, secret] of LOW_ENTROPY_SECRETS.entries()) {
  test(`rejects low-entropy auth secret #${index}`, () => {
    const message = rejectionMessage(() => loadConfig({ ...developmentEnv(), ARTIFLOW_AUTH_SECRET: secret }));

    assert.match(message, /ARTIFLOW_AUTH_SECRET/);
    assert.match(message, /openssl rand/);
    assert.ok(!message.includes(secret), "the rejection must never echo the rejected secret");
  });
}

test("keeps the 32-character length rule", () => {
  const message = rejectionMessage(() => loadConfig({ ...developmentEnv(), ARTIFLOW_AUTH_SECRET: "9f2c4b7e1a8d3056" }));

  assert.match(message, /32/);
  assert.match(message, /ARTIFLOW_AUTH_SECRET/);
});

test("accepts a random-looking 32-character hex secret", () => {
  const config = loadConfig(developmentEnv());

  assert.equal(config.authSecret, TEST_AUTH_SECRET);
});

test("accepts the documented production profile", () => {
  const config = loadConfig(productionEnv());

  assert.equal(config.nodeEnv, "production");
  assert.equal(config.databaseUrl, productionEnv().DATABASE_URL);
  assert.equal(config.storage.endpoint, "https://account-id.r2.cloudflarestorage.com");
});

test("accepts sslmode=require for the production database", () => {
  const env = productionEnv();
  env.DATABASE_URL = "postgres://artiflow:db-password@db.example.com:5432/artiflow?sslmode=require";

  assert.equal(loadConfig(env).databaseUrl, env.DATABASE_URL);
});

const NON_TLS_DATABASE_URLS = [
  "postgres://artiflow:db-password@db.example.com:5432/artiflow",
  "postgres://artiflow:db-password@db.example.com:5432/artiflow?sslmode=disable",
  "postgres://artiflow:db-password@db.example.com:5432/artiflow?sslmode=prefer",
  "postgres://artiflow:db-password@db.example.com:5432/artiflow?sslmode=no-verify",
];

for (const [index, url] of NON_TLS_DATABASE_URLS.entries()) {
  test(`rejects a production database without verifiable TLS #${index}`, () => {
    const message = rejectionMessage(() => loadConfig({ ...productionEnv(), DATABASE_URL: url }));

    assert.match(message, /DATABASE_URL/);
    assert.match(message, /sslmode/);
    assert.match(message, /verify-full/);
    assert.ok(!message.includes("db-password"), "the rejection must never echo credentials");
  });
}

const NON_HTTPS_S3_ENDPOINTS = [
  "http://127.0.0.1:9000",
  "http://s3.internal:9000",
  "http://account-id.r2.cloudflarestorage.com",
];

for (const [index, endpoint] of NON_HTTPS_S3_ENDPOINTS.entries()) {
  test(`rejects a non-https production S3 endpoint #${index}`, () => {
    const message = rejectionMessage(() => loadConfig({ ...productionEnv(), ARTIFLOW_S3_ENDPOINT: endpoint }));

    assert.match(message, /ARTIFLOW_S3_ENDPOINT/);
    assert.match(message, /https/);
    assert.ok(!message.includes(endpoint), "the rejection must never echo the rejected endpoint");
  });
}

test("keeps development and test accepting loopback http storage and a TLS-less database", () => {
  for (const nodeEnv of ["development", "test"]) {
    const env: Record<string, string> = { ...developmentEnv(), NODE_ENV: nodeEnv };
    if (nodeEnv === "test") delete env.ARTIFLOW_DEMO_AUTH;

    const config = loadConfig(env);

    assert.equal(config.nodeEnv, nodeEnv);
    assert.equal(config.storage.endpoint, "http://127.0.0.1:9000");
    assert.equal(config.databaseUrl, env.DATABASE_URL);
  }
});

function publishedAuthSecret(): string {
  const template = readFileSync(new URL("../env.prod.example", import.meta.url), "utf8");
  const match = /^ARTIFLOW_AUTH_SECRET=(.*)$/m.exec(template);
  assert.ok(match, "env.prod.example must publish ARTIFLOW_AUTH_SECRET");
  const published = match[1];
  assert.ok(published !== undefined);
  return published.trim();
}

test("env.prod.example publishes a secret that fails validation", () => {
  const published = publishedAuthSecret();
  assert.ok(published.length >= 32, "the published placeholder must stay long enough for the length rule");

  const message = rejectionMessage(() => loadConfig({ ...developmentEnv(), ARTIFLOW_AUTH_SECRET: published }));

  assert.match(message, /ARTIFLOW_AUTH_SECRET/);
  assert.match(message, /openssl rand/);
  assert.ok(!message.includes(published), "the rejection must never echo the published placeholder");
});
