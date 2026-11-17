import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { loadConfig } from "../apps/api/src/config.ts";
import { createMcpApp } from "../apps/api/src/mcp/mount.ts";
import { publicIssuer, publicResource } from "../apps/api/src/oauth.ts";
import { countLeftoverTestDatabases, startOAuthHarness, type OAuthHarness } from "./helpers/oauth.ts";

const config = loadConfig(process.env);
const RESOURCE = publicResource(config);
const ISSUER = publicIssuer(config);
const TEST_TIMEOUT_MS = 20_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);
const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const ACCEPT_BOTH = "application/json, text/event-stream";
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "artiflow-integration-test", version: "0.0.0" },
  },
});
const INITIALIZED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });

let harness: OAuthHarness;

before(async () => {
  assert.equal(config.publicOrigin, "http://127.0.0.1:5173");
  harness = await startOAuthHarness(config, {
    mount: ({ auth, baseUrl }) =>
      createMcpApp(auth, {
        allowedHosts: [new URL(baseUrl).host, new URL(config.publicOrigin).host],
        allowedOrigins: [config.publicOrigin],
        jwksUrl: `${baseUrl}/api/auth/jwks`,
        resource: RESOURCE,
        issuer: ISSUER,
        challengeScopes: ["artifacts:read", "artifacts:write"],
      }),
  });
});

after(async () => {
  await harness.close();
  assert.equal(await countLeftoverTestDatabases(), 0);
});

const earnedBearer = async (): Promise<string> => {
  const client = await harness.seedPublicClient();
  const cookie = await harness.credentialSessionCookie();
  const token = await harness.authorizeToken(client, cookie, "artifacts:read artifacts:write");
  return token.access_token;
};

integration("an unauthenticated MCP request gets an RFC 9728 bearer challenge", async () => {
  const response = await harness.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: TOOLS_LIST,
  });
  assert.equal(response.status, 401);
  const challenge = response.headers.get("www-authenticate") ?? "";
  assert.equal(challenge.startsWith("Bearer "), true);
  assert.equal(
    challenge.includes(`resource_metadata="${config.publicOrigin}/.well-known/oauth-protected-resource/mcp"`),
    true,
  );
  const body = (await response.json()) as { jsonrpc?: string; error?: { code?: number } };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error?.code, -32000);
});

integration("a session cookie is not a bearer token", async () => {
  const cookie = await harness.credentialSessionCookie();
  const response = await harness.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: TOOLS_LIST,
  });
  assert.equal(response.status, 401);
  assert.equal((response.headers.get("www-authenticate") ?? "").startsWith("Bearer "), true);
});

integration("non-POST MCP methods are refused with 405 and Allow: POST", async () => {
  for (const method of ["GET", "DELETE"]) {
    const response = await harness.request("/mcp", { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  }
});

integration("initialize returns a JSON result without any session id", async () => {
  const token = await earnedBearer();
  const response = await harness.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT_BOTH, authorization: `Bearer ${token}` },
    body: INITIALIZE,
  });
  assert.equal(response.status, 200);
  assert.equal((response.headers.get("content-type") ?? "").startsWith("application/json"), true);
  assert.equal(response.headers.get("mcp-session-id"), null);
  const body = (await response.json()) as {
    jsonrpc?: string;
    result?: {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      capabilities?: Record<string, unknown>;
    };
  };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.result?.serverInfo?.name, "artiflow");
  assert.equal(typeof body.result?.serverInfo?.version, "string");
  assert.equal(typeof body.result?.protocolVersion, "string");
  assert.equal(typeof body.result?.capabilities?.tools, "object");
});

integration("a notifications-only POST is accepted with 202 and no content", async () => {
  const token = await earnedBearer();
  const response = await harness.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT_BOTH, authorization: `Bearer ${token}` },
    body: INITIALIZED,
  });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("mcp-session-id"), null);
});

integration("POST without text/event-stream is refused with 406", async () => {
  const token = await earnedBearer();
  for (const accept of [undefined, "application/json"]) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
    if (accept !== undefined) headers.accept = accept;
    const response = await harness.request("/mcp", { method: "POST", headers, body: TOOLS_LIST });
    assert.equal(response.status, 406, `accept=${String(accept)}`);
    const body = (await response.json()) as { error?: { code?: number; message?: string } };
    assert.equal(body.error?.code, -32000);
    assert.equal(body.error?.message?.startsWith("Not Acceptable"), true);
  }
});

integration("a foreign Origin is refused by the transport rebinding guard", async () => {
  const token = await earnedBearer();
  const response = await harness.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: ACCEPT_BOTH,
      origin: "http://evil.example",
      authorization: `Bearer ${token}`,
    },
    body: TOOLS_LIST,
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
  const body = (await response.json()) as { jsonrpc?: string; id?: unknown; error?: Record<string, unknown> };
  assert.deepEqual(Object.keys(body).sort(), ["error", "id", "jsonrpc"]);
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, null);
  assert.deepEqual(Object.keys(body.error ?? {}).sort(), ["code", "message"]);
  assert.equal(body.error?.code, -32000);
});

integration("a malformed bearer token gets the RFC 9728 challenge", async () => {
  const response = await harness.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT_BOTH, authorization: "Bearer not-a-jwt" },
    body: TOOLS_LIST,
  });
  assert.equal(response.status, 401);
  const challenge = response.headers.get("www-authenticate") ?? "";
  assert.equal(challenge.startsWith("Bearer "), true);
  assert.equal(
    challenge.includes(`resource_metadata="${config.publicOrigin}/.well-known/oauth-protected-resource/mcp"`),
    true,
  );
});

integration("a bearer token reaches the stateless transport and lists no tools yet", async () => {
  const token = await harness.authorizeToken(
    await harness.seedPublicClient(),
    await harness.credentialSessionCookie(),
    "artifacts:read artifacts:write",
  );
  const response = await harness.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token.access_token}`,
    },
    body: TOOLS_LIST,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result?: { tools?: unknown[] } };
  assert.deepEqual(body.result?.tools, []);
});
