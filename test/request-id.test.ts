import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiApp, type ApiAppDeps } from "../apps/api/src/app.ts";
import type { AppConfig } from "../apps/api/src/config.ts";

function config(): AppConfig {
  return {
    nodeEnv: "test",
    apiHost: "127.0.0.1",
    apiPort: 0,
    publicOrigin: "http://127.0.0.1:5173",
    allowedHosts: [],
    internalOrigin: "http://127.0.0.1:5173",
    demoAuth: false,
    authSecret: "x".repeat(32),
    authProviders: {},
    databaseUrl: "postgres://stub",
    storage: {
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket: "stub",
      accessKeyId: "stub",
      secretAccessKey: "stub",
      forcePathStyle: true,
    },
  };
}

function depsWithThrowingSession(): ApiAppDeps {
  const database = {
    db: {},
    check: async () => {},
  } as unknown as ApiAppDeps["database"];
  const storage = {
    client: {},
    bucket: "stub",
    checkBucket: async () => {},
    destroy: () => {},
  } as unknown as ApiAppDeps["storage"];
  return { config: config(), database, storage };
}

test("health keeps its own answer without a failing probe: onError stays out of expected paths", async () => {
  const app = createApiApp(depsWithThrowingSession());
  const response = await app.fetch(new Request("http://127.0.0.1:5173/api/health"));
  assert.equal(response.status, 200);
});

test("the client-provided request id is echoed, not regenerated", async () => {
  const app = createApiApp(depsWithThrowingSession());
  const response = await app.fetch(
    new Request("http://127.0.0.1:5173/api/health", { headers: { "x-request-id": "fixed-id-1234" } }),
  );
  assert.equal(response.headers.get("x-request-id"), "fixed-id-1234");
  const echo = await app.fetch(
    new Request("http://127.0.0.1:5173/api/artifacts", { headers: { "x-request-id": "fixed-id-1235" } }),
  );
  assert.equal(echo.headers.get("x-request-id"), "fixed-id-1235");
  assert.equal(echo.status, 401, "unauthorized still carries the shared id");
});
