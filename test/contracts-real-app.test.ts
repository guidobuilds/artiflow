import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiApp, type ApiAppDeps } from "../apps/api/src/app.ts";
import type { AppConfig } from "../apps/api/src/config.ts";
import { artifactListResponseSchema } from "@artiflow/contracts/artifacts";
import { parseArtifactList } from "../apps/dashboard/src/auth-client.ts";
import { parseComments } from "../apps/dashboard/src/comments-api.ts";

function fixtureConfig(): AppConfig {
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

function stubDeps(build?: ApiAppDeps["build"]) {
  const database = { db: {}, check: async () => {} } as unknown as ApiAppDeps["database"];
  const storage = {
    client: {},
    bucket: "stub",
    checkBucket: async () => {},
    destroy: () => {},
  } as unknown as ApiAppDeps["storage"];
  return { config: fixtureConfig(), database, storage, build };
}

test("the real app composition serves health through app.fetch with no listener or database", async () => {
  const app = createApiApp(stubDeps());
  const response = await app.fetch(new Request("http://127.0.0.1:5173/api/health"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { status: string; checks: { database: string; storage: string } };
  assert.equal(body.status, "ok");
  assert.equal(body.checks.database, "ok");
});

test("the real app composition serves the build identity it was given", async () => {
  const app = createApiApp(stubDeps({ version: "0.4.1", revision: "abc123" }));
  const response = await app.fetch(new Request("http://127.0.0.1:5173/api/version"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { version: "0.4.1", revision: "abc123" });
});

test("unauthorized library reads keep the legacy error shape the dashboard parses", async () => {
  const app = createApiApp(stubDeps());
  const response = await app.fetch(new Request("http://127.0.0.1:5173/api/artifacts"));
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.deepEqual(artifactListResponseSchema.safeParse(body).success, false);
  assert.deepEqual(parseArtifactList(body), null);
});

test("the comments contract matches the dashboard parser through the real app gate", async () => {
  const app = createApiApp(stubDeps());
  const response = await app.fetch(new Request("http://127.0.0.1:5173/api/artifacts/x/comments"));
  assert.notEqual(response.status, 200);
  assert.deepEqual(parseComments(await response.json().catch(() => null)), null);
});
