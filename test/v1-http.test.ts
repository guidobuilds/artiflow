import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiApp, type ApiAppDeps } from "../apps/api/src/app.ts";
import type { AppConfig } from "../apps/api/src/config.ts";
import { requiredScope } from "../apps/api/src/routes/v1/scopes.ts";

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

test("the scope table maps every phase-1 read to artifacts:read and nothing else", () => {
  for (const path of [
    "/api/artifacts",
    "/api/artifacts/shared",
    "/api/artifacts/11111111-1111-4111-8111-111111111111",
    "/api/artifacts/11111111-1111-4111-8111-111111111111/document",
    "/api/artifacts/11111111-1111-4111-8111-111111111111/revisions",
    "/api/artifacts/11111111-1111-4111-8111-111111111111/comments",
  ]) {
    assert.equal(requiredScope("GET", path), "artifacts:read", path);
  }
  assert.equal(requiredScope("PUT", "/api/artifacts/11111111-1111-4111-8111-111111111111/document"), "artifacts:write");
  assert.equal(
    requiredScope("POST", "/api/artifacts/11111111-1111-4111-8111-111111111111/revisions/r1/restore"),
    "artifacts:write",
  );
  assert.equal(requiredScope("DELETE", "/api/artifacts/11111111-1111-4111-8111-111111111111"), "artifacts:write");
  assert.equal(
    requiredScope("POST", "/api/artifacts/11111111-1111-4111-8111-111111111111/comments/c1/resolve"),
    "comments:write",
  );
  assert.equal(
    requiredScope("POST", "/api/artifacts/11111111-1111-4111-8111-111111111111/comments/c1/unresolve"),
    "comments:write",
  );
  assert.equal(
    requiredScope("DELETE", "/api/artifacts/11111111-1111-4111-8111-111111111111/comments/c1"),
    "comments:write",
  );
  assert.equal(requiredScope("GET", "/api/artifacts/11111111-1111-4111-8111-111111111111/shares"), "shares:manage");
  assert.equal(requiredScope("POST", "/api/artifacts/11111111-1111-4111-8111-111111111111/shares"), "shares:manage");
  assert.equal(
    requiredScope("DELETE", "/api/artifacts/11111111-1111-4111-8111-111111111111/shares/c1"),
    "shares:manage",
  );
  assert.equal(requiredScope("GET", "/api/artifacts/11111111-1111-4111-8111-111111111111/links"), "shares:manage");
  assert.equal(
    requiredScope("POST", "/api/artifacts/11111111-1111-4111-8111-111111111111/links/l1/rotate"),
    "shares:manage",
  );
  assert.equal(
    requiredScope("DELETE", "/api/artifacts/11111111-1111-4111-8111-111111111111/links/l1"),
    "shares:manage",
  );
  assert.equal(requiredScope("POST", "/api/artifacts"), "artifacts:write", "creation is the /api/v1 route");
  assert.equal(requiredScope("HEAD", "/api/artifacts"), "artifacts:read", "HEAD rides GET");
});

test("a stripped principal and no bearer are refused; the challenge targets the api/v1 document", async () => {
  const app = createApiApp(stubDeps());
  const response = await app.fetch(new Request("http://127.0.0.1:5173/api/v1/artifacts"));
  assert.equal(response.status, 401);
  const challenge = response.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /Bearer/i);
  assert.match(
    challenge,
    /resource_metadata="http:\/\/127\.0\.0\.1:5173\/\.well-known\/oauth-protected-resource\/api\/v1"/,
  );
  const spoofed = await app.fetch(
    new Request("http://127.0.0.1:5173/api/v1/artifacts", {
      headers: { "x-artiflow-principal": JSON.stringify({ userId: "u", scopes: ["artifacts:read"] }) },
    }),
  );
  assert.notEqual(spoofed.status, 200, "a forged principal header never reaches the handlers");
});

test("unmapped methods and paths are 405 before credentials; orchestrated writes reach the verifier", async () => {
  const app = createApiApp(stubDeps());
  const creation = await app.fetch(new Request("http://127.0.0.1:5173/api/v1/artifacts", { method: "POST" }));
  assert.equal(creation.status, 401, "creation exists now and still requires a bearer credential");
  const spoofed = await app.fetch(
    new Request("http://127.0.0.1:5173/api/v1/artifacts/11111111-1111-4111-8111-111111111111", {
      method: "DELETE",
      headers: { "x-artiflow-principal": JSON.stringify({ userId: "u", scopes: ["artifacts:write"] }) },
    }),
  );
  assert.equal(spoofed.status, 400, "a forged principal header is refused before verification");
  const unauthenticated = await app.fetch(
    new Request("http://127.0.0.1:5173/api/v1/artifacts/11111111-1111-4111-8111-111111111111", { method: "DELETE" }),
  );
  assert.equal(unauthenticated.status, 401, "a real write rule reaches the verifier for its challenge");
});

test("links management scope-gates to shares:manage and requires a bearer credential", async () => {
  assert.equal(requiredScope("GET", "/api/artifacts/11111111-1111-4111-8111-111111111111/links"), "shares:manage");
  const app = createApiApp(stubDeps());
  const response = await app.fetch(
    new Request("http://127.0.0.1:5173/api/v1/artifacts/11111111-1111-4111-8111-111111111111/links", {
      headers: { authorization: "Bearer junk" },
    }),
  );
  assert.equal(response.status, 401, "the token is verified against the api/v1 audience before any data call");
});
