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

function deps(): ApiAppDeps {
  const database = { db: {}, check: async () => {} } as unknown as ApiAppDeps["database"];
  const storage = {
    client: {},
    bucket: "stub",
    checkBucket: async () => {},
    destroy: () => {},
  } as unknown as ApiAppDeps["storage"];
  return { config: config(), database, storage };
}

test("an over-limit declared body refuses before any session or parse work", async () => {
  const app = createApiApp(deps());
  const huge = 17 * 1024 * 1024;
  const response = await app.fetch(
    new Request("http://127.0.0.1:5173/api/artifacts/11111111-1111-4111-8111-111111111111/document", {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": String(huge), origin: "http://127.0.0.1:5173" },
      body: "",
    }),
  );
  assert.equal(response.status, 413);
  const body = (await response.json()) as { error: string; maxBytes: number };
  assert.equal(body.error, "too_large");
  assert.equal(body.maxBytes, 16 * 1024 * 1024);
});

test("an over-limit comment body refuses before parse, under its own cap", async () => {
  const app = createApiApp(deps());
  const response = await app.fetch(
    new Request("http://127.0.0.1:5173/api/artifacts/11111111-1111-4111-8111-111111111111/comments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(65 * 1024),
        origin: "http://127.0.0.1:5173",
      },
      body: "",
    }),
  );
  assert.equal(response.status, 413);
  const body = (await response.json()) as { error: string; maxBytes: number };
  assert.equal(body.error, "too_large");
  assert.equal(body.maxBytes, 64 * 1024);
});

test("a GET is never body-limited and an MCP POST above 2 MiB refuses before auth reads", async () => {
  const app = createApiApp(deps());
  const get = await app.fetch(
    new Request("http://127.0.0.1:5173/api/artifacts", { headers: { "content-length": "999999999" } }),
  );
  assert.notEqual(get.status, 413);
  const mcp = await app.fetch(
    new Request("http://127.0.0.1:5173/mcp", {
      method: "POST",
      headers: { "content-length": String(3 * 1024 * 1024) },
      body: "",
    }),
  );
  assert.equal(mcp.status, 413);
});
