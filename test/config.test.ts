import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, loadConfig, resolveMcpNetwork } from "../apps/api/src/config.ts";

const DATABASE_URL = "postgres://artiflow:local-db-secret@127.0.0.1:5432/artiflow";
const TEST_AUTH_SECRET = "test-only-fixed-nonsecret-value-0123456789";

function validEnv(): Record<string, string> {
  return {
    NODE_ENV: "development",
    ARTIFLOW_API_HOST: "127.0.0.1",
    ARTIFLOW_API_PORT: "8787",
    ARTIFLOW_PUBLIC_ORIGIN: "http://127.0.0.1:5173",
    ARTIFLOW_DEMO_AUTH: "1",
    ARTIFLOW_AUTH_SECRET: TEST_AUTH_SECRET,
    DATABASE_URL,
    ARTIFLOW_S3_ENDPOINT: "http://127.0.0.1:9000",
    ARTIFLOW_S3_REGION: "us-east-1",
    ARTIFLOW_S3_BUCKET: "artiflow-local",
    ARTIFLOW_S3_ACCESS_KEY_ID: "local-access-key",
    ARTIFLOW_S3_SECRET_ACCESS_KEY: "local-secret-key",
  };
}

test("accepts the documented loopback development profile", () => {
  const config = loadConfig(validEnv());

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.apiHost, "127.0.0.1");
  assert.equal(config.apiPort, 8787);
  assert.equal(config.publicOrigin, "http://127.0.0.1:5173");
  assert.equal(config.demoAuth, true);
  assert.equal(config.databaseUrl, DATABASE_URL);
  assert.equal(config.authSecret, TEST_AUTH_SECRET);
  assert.equal(config.storage.endpoint, "http://127.0.0.1:9000");
  assert.equal(config.storage.bucket, "artiflow-local");
  assert.equal(config.storage.forcePathStyle, true);
});

test("resolves the development MCP authorities and JWKS URL", () => {
  assert.deepEqual(resolveMcpNetwork(loadConfig(validEnv())), {
    allowedHosts: ["127.0.0.1:5173", "127.0.0.1:8787"],
    jwksUrl: "http://127.0.0.1:8787/api/auth/jwks",
  });
});

test("trusts only the public host and explicit extras in production", () => {
  const env = validEnv();
  env.NODE_ENV = "production";
  env.ARTIFLOW_PUBLIC_ORIGIN = "https://artifacts.example.com";
  env.DATABASE_URL = "postgres://artiflow:local-db-secret@db.example.com:5432/artiflow?sslmode=require";
  env.ARTIFLOW_S3_ENDPOINT = "https://s3.example.com";
  delete env.ARTIFLOW_DEMO_AUTH;

  assert.deepEqual(resolveMcpNetwork(loadConfig(env)), {
    allowedHosts: ["artifacts.example.com"],
    jwksUrl: "http://127.0.0.1:8787/api/auth/jwks",
  });

  env.ARTIFLOW_ALLOWED_HOSTS = "api:8787, internal.local:9000";
  assert.deepEqual(resolveMcpNetwork(loadConfig(env)), {
    allowedHosts: ["artifacts.example.com", "api:8787", "internal.local:9000"],
    jwksUrl: "http://127.0.0.1:8787/api/auth/jwks",
  });
});

test("derives MCP loopback authority and JWKS URL from the API port", () => {
  const env = validEnv();
  env.ARTIFLOW_API_PORT = "9123";

  assert.deepEqual(resolveMcpNetwork(loadConfig(env)), {
    allowedHosts: ["127.0.0.1:5173", "127.0.0.1:9123"],
    jwksUrl: "http://127.0.0.1:9123/api/auth/jwks",
  });
});

test("uses the internal origin override only for the JWKS fetch", () => {
  const env = validEnv();
  env.ARTIFLOW_INTERNAL_ORIGIN = "http://api-sidecar:8080";

  assert.deepEqual(resolveMcpNetwork(loadConfig(env)), {
    allowedHosts: ["127.0.0.1:5173", "127.0.0.1:8787"],
    jwksUrl: "http://api-sidecar:8080/api/auth/jwks",
  });
});

for (const authority of ["https://evil.example", "evil.example/path"]) {
  test(`rejects a non-authority MCP allowed host: ${authority}`, () => {
    const env = validEnv();
    env.ARTIFLOW_ALLOWED_HOSTS = authority;

    assert.throws(
      () => resolveMcpNetwork(loadConfig(env)),
      (error: unknown) => error instanceof ConfigError && error.message.includes("ARTIFLOW_ALLOWED_HOSTS"),
    );
  });
}

test("rejects an internal origin containing a path", () => {
  const env = validEnv();
  env.ARTIFLOW_INTERNAL_ORIGIN = "https://api.example.com/path";

  assert.throws(
    () => resolveMcpNetwork(loadConfig(env)),
    (error: unknown) => error instanceof ConfigError && error.message.includes("ARTIFLOW_INTERNAL_ORIGIN"),
  );
});

test("rejects the demo auth flag in production", () => {
  const env = validEnv();
  env.NODE_ENV = "production";

  assert.throws(
    () => loadConfig(env),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes("ARTIFLOW_DEMO_AUTH") &&
      error.message.includes("production"),
  );
});

test("rejects the demo auth flag outside development", () => {
  const env = validEnv();
  env.NODE_ENV = "test";

  assert.throws(
    () => loadConfig(env),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes("ARTIFLOW_DEMO_AUTH") &&
      error.message.includes("NODE_ENV=development"),
  );
});

test("requires a configured auth secret and never echoes values", () => {
  const env = validEnv();
  delete env.ARTIFLOW_AUTH_SECRET;

  assert.throws(
    () => loadConfig(env),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.message.includes("ARTIFLOW_AUTH_SECRET"));
      assert.ok(error.message.includes("setup:local"));
      assert.ok(!error.message.includes("local-db-secret"));
      return true;
    },
  );
});

test("rejects an auth secret shorter than 32 characters", () => {
  const env = validEnv();
  env.ARTIFLOW_AUTH_SECRET = "too-short-secret";

  assert.throws(
    () => loadConfig(env),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes("ARTIFLOW_AUTH_SECRET") &&
      error.message.includes("32") &&
      !error.message.includes("too-short-secret"),
  );
});

test("rejects demo auth for a non-loopback public origin", () => {
  const env = validEnv();
  env.ARTIFLOW_PUBLIC_ORIGIN = "https://artifacts.example.com";

  assert.throws(
    () => loadConfig(env),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes("ARTIFLOW_PUBLIC_ORIGIN") &&
      error.message.includes("loopback"),
  );
});

test("accepts the wildcard API bind address for containers", () => {
  const env = validEnv();
  env.ARTIFLOW_API_HOST = "0.0.0.0";

  const config = loadConfig(env);
  assert.equal(config.apiHost, "0.0.0.0");
});

test("rejects an API bind address other than loopback or the wildcard", () => {
  const env = validEnv();
  env.ARTIFLOW_API_HOST = "0.0.0.1";

  assert.throws(
    () => loadConfig(env),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes("ARTIFLOW_API_HOST") &&
      error.message.includes("127.0.0.1") &&
      error.message.includes("0.0.0.0"),
  );
});

test("keeps loopback-derived path style when no override is set", () => {
  const env = validEnv();
  assert.equal(loadConfig(env).storage.forcePathStyle, true);

  const remoteEnv = validEnv();
  remoteEnv.ARTIFLOW_S3_ENDPOINT = "https://account-id.r2.cloudflarestorage.com";
  assert.equal(loadConfig(remoteEnv).storage.forcePathStyle, false);
});

test("forces path style on request for non-loopback S3 endpoints", () => {
  const env = validEnv();
  env.ARTIFLOW_S3_ENDPOINT = "http://s3.internal:9000";
  env.ARTIFLOW_S3_FORCE_PATH_STYLE = "1";

  const config = loadConfig(env);
  assert.equal(config.storage.endpoint, "http://s3.internal:9000");
  assert.equal(config.storage.forcePathStyle, true);
});

test("rejects S3 force path style values other than 0 or 1", () => {
  const env = validEnv();
  env.ARTIFLOW_S3_FORCE_PATH_STYLE = "true";

  assert.throws(
    () => loadConfig(env),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes("ARTIFLOW_S3_FORCE_PATH_STYLE") &&
      !error.message.includes("true"),
  );
});

test("rejects an out-of-range API port", () => {
  const env = validEnv();
  env.ARTIFLOW_API_PORT = "99999";

  assert.throws(
    () => loadConfig(env),
    (error: unknown) => error instanceof ConfigError && error.message.includes("ARTIFLOW_API_PORT"),
  );
});

test("reports missing names without echoing configured values", () => {
  const env = validEnv();
  delete env.DATABASE_URL;
  delete env.ARTIFLOW_S3_SECRET_ACCESS_KEY;

  assert.throws(
    () => loadConfig(env),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.message.includes("DATABASE_URL"));
      assert.ok(error.message.includes("ARTIFLOW_S3_SECRET_ACCESS_KEY"));
      assert.ok(!error.message.includes("local-secret-key"));
      assert.ok(!error.message.includes("local-access-key"));
      assert.ok(!error.message.includes("local-db-secret"));
      return true;
    },
  );
});

test("defaults to no social providers when no credentials are configured", () => {
  const config = loadConfig(validEnv());

  assert.deepEqual(config.authProviders, {});
});

test("accepts a complete GitHub credential pair", () => {
  const env = validEnv();
  env.ARTIFLOW_AUTH_GITHUB_CLIENT_ID = "github-client-id";
  env.ARTIFLOW_AUTH_GITHUB_CLIENT_SECRET = "github-client-secret";

  const config = loadConfig(env);

  assert.deepEqual(config.authProviders.github, {
    clientId: "github-client-id",
    clientSecret: "github-client-secret",
  });
  assert.equal(config.authProviders.google, undefined);
});

test("accepts a complete Google credential pair", () => {
  const env = validEnv();
  env.ARTIFLOW_AUTH_GOOGLE_CLIENT_ID = "google-client-id";
  env.ARTIFLOW_AUTH_GOOGLE_CLIENT_SECRET = "google-client-secret";

  const config = loadConfig(env);

  assert.deepEqual(config.authProviders.google, {
    clientId: "google-client-id",
    clientSecret: "google-client-secret",
  });
  assert.equal(config.authProviders.github, undefined);
});

test("rejects a GitHub client id without its secret", () => {
  const env = validEnv();
  env.ARTIFLOW_AUTH_GITHUB_CLIENT_ID = "github-client-id";

  assert.throws(
    () => loadConfig(env),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes("ARTIFLOW_AUTH_GITHUB_CLIENT_ID") &&
      error.message.includes("ARTIFLOW_AUTH_GITHUB_CLIENT_SECRET"),
  );
});

test("rejects a GitHub client secret without its id", () => {
  const env = validEnv();
  env.ARTIFLOW_AUTH_GITHUB_CLIENT_SECRET = "github-client-secret";

  assert.throws(
    () => loadConfig(env),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes("ARTIFLOW_AUTH_GITHUB_CLIENT_ID") &&
      error.message.includes("ARTIFLOW_AUTH_GITHUB_CLIENT_SECRET"),
  );
});

test("rejects a Google client id without its secret", () => {
  const env = validEnv();
  env.ARTIFLOW_AUTH_GOOGLE_CLIENT_ID = "google-client-id";

  assert.throws(
    () => loadConfig(env),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes("ARTIFLOW_AUTH_GOOGLE_CLIENT_ID") &&
      error.message.includes("ARTIFLOW_AUTH_GOOGLE_CLIENT_SECRET"),
  );
});

test("treats a blank credential pair like unset ones", () => {
  const env = validEnv();
  env.ARTIFLOW_AUTH_GITHUB_CLIENT_ID = "   ";
  env.ARTIFLOW_AUTH_GITHUB_CLIENT_SECRET = "  ";

  const config = loadConfig(env);

  assert.deepEqual(config.authProviders, {});
});

test("rejects a blank id beside a present secret", () => {
  const env = validEnv();
  env.ARTIFLOW_AUTH_GITHUB_CLIENT_ID = "   ";
  env.ARTIFLOW_AUTH_GITHUB_CLIENT_SECRET = "github-client-secret";

  assert.throws(
    () => loadConfig(env),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes("ARTIFLOW_AUTH_GITHUB_CLIENT_ID") &&
      error.message.includes("ARTIFLOW_AUTH_GITHUB_CLIENT_SECRET"),
  );
});

test("production wildcard binding excludes implicit loopback trust", async () => {
  const env = validEnv();
  env.NODE_ENV = "production";
  env.ARTIFLOW_API_HOST = "0.0.0.0";
  env.ARTIFLOW_PUBLIC_ORIGIN = "https://Artifacts.Example.com:443";
  env.DATABASE_URL = "postgres://artiflow:local-db-secret@db.example.com:5432/artiflow?sslmode=require";
  env.ARTIFLOW_S3_ENDPOINT = "https://s3.example.com";
  delete env.ARTIFLOW_DEMO_AUTH;

  const network = resolveMcpNetwork(loadConfig(env));
  assert.deepEqual(network, {
    allowedHosts: ["artifacts.example.com"],
    jwksUrl: "http://127.0.0.1:8787/api/auth/jwks",
  });

  const { WebStandardStreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
  for (const host of [
    "artifacts.example.com",
    "Artifacts.Example.com",
    "artifacts.example.com:443",
    "127.0.0.1:8787",
    "localhost:8787",
    "api:8787",
  ]) {
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableDnsRebindingProtection: true,
      allowedHosts: network.allowedHosts,
    });
    try {
      const reply = await transport.handleRequest(
        new Request("http://api:8787/mcp", { method: "PUT", headers: { host } }),
      );
      assert.equal(reply.status, host === "artifacts.example.com" ? 405 : 403, host);
    } finally {
      await transport.close();
    }
  }
});

test("rejects malformed or out-of-range extra authorities", () => {
  for (const value of [
    "*",
    "*.example.com",
    "https://example.com",
    ",",
    "api:8787,",
    "api:8787,,other",
    "[::1]:8787",
    "::1",
    "bad host",
    "api:0",
    "api:99999",
  ]) {
    assert.throws(
      () => loadConfig({ ...validEnv(), ARTIFLOW_ALLOWED_HOSTS: value }),
      (error: unknown) => error instanceof ConfigError && error.message.includes("ARTIFLOW_ALLOWED_HOSTS"),
      value,
    );
  }
});
