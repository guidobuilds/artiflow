import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiApp, type ApiAppDeps } from "../apps/api/src/app.ts";
import type { AppConfig } from "../apps/api/src/config.ts";
import {
  API_RESOURCE_SCOPES,
  apiResourceProviderOptions,
  OAUTH_SCOPES,
  publicApiResource,
} from "../apps/api/src/oauth.ts";

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

function stubDeps(): ApiAppDeps {
  const database = { db: {}, check: async () => {} } as unknown as ApiAppDeps["database"];
  const storage = {
    client: {},
    bucket: "stub",
    checkBucket: async () => {},
    destroy: () => {},
  } as unknown as ApiAppDeps["storage"];
  return { config: config(), database, storage };
}

test("the API resource derives from the public origin and advertises the four product scopes", () => {
  assert.equal(publicApiResource(config()), "http://127.0.0.1:5173/api/v1");
  assert.deepEqual(OAUTH_SCOPES, [
    "artifacts:read",
    "artifacts:write",
    "comments:write",
    "shares:manage",
    "offline_access",
  ]);
  assert.deepEqual(API_RESOURCE_SCOPES, ["artifacts:read", "artifacts:write", "comments:write", "shares:manage"]);
});

test("the provider config seeds the API resource opt-in, never default-linked", () => {
  const options = apiResourceProviderOptions(config());
  const api = options.resources.find(
    (row: { identifier: string }) => row.identifier === "http://127.0.0.1:5173/api/v1",
  );
  assert.ok(api, "the API v1 resource is seeded into the existing oauthResource table");
  assert.deepEqual(api.allowedScopes, API_RESOURCE_SCOPES);
  assert.ok(
    options.clientRegistrationAllowedResources.includes("http://127.0.0.1:5173/api/v1"),
    "explicit DCR requests may name the API resource",
  );
});

test("the API v1 protected-resource document is served without a database", async () => {
  const app = createApiApp(stubDeps());
  const response = await app.fetch(new Request("http://127.0.0.1:5173/.well-known/oauth-protected-resource/api/v1"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as {
    resource: string;
    authorization_servers: string[];
    scopes_supported: string[];
  };
  assert.equal(body.resource, "http://127.0.0.1:5173/api/v1");
  assert.deepEqual(body.authorization_servers, ["http://127.0.0.1:5173/api/auth"]);
  assert.deepEqual(body.scopes_supported, API_RESOURCE_SCOPES);
});

test("the MCP discovery documents keep their paths and the required-resource authorize guard stays", async () => {
  const app = createApiApp(stubDeps());
  const mcp = await app.fetch(new Request("http://127.0.0.1:5173/.well-known/oauth-protected-resource/mcp"));
  assert.equal(mcp.status, 200);
  const authorize = await app.fetch(new Request("http://127.0.0.1:5173/api/auth/oauth2/authorize?client_id=x"));
  assert.equal(authorize.status, 400, "resource is still required before the provider runs");
});
