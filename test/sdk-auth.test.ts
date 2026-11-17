import assert from "node:assert/strict";
import { test } from "node:test";
import { createSdkAuth, Unauthorized, type AuthStorage, type SavedAuth } from "@artiflow/sdk/auth";

function memoryStorage(initial: [string, SavedAuth][] = []): AuthStorage & { entries: Map<string, SavedAuth> } {
  const entries = new Map<string, SavedAuth>(initial);
  return {
    entries,
    async get(key) {
      return entries.get(key);
    },
    async set(key, value) {
      entries.set(key, value);
    },
  };
}

const jwt = async (payload: Record<string, unknown>): Promise<string> => {
  const encode = (part: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(part)));
  const signature = new Uint8Array(16).fill(7);
  return `${encode({ alg: "ES256", typ: "JWT" })}.${encode(payload)}.${encode(signature)}`;
};
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const origin = "https://artiflow.example";
const storageKeyFor = async (): Promise<string> =>
  `sdk-auth:${toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(origin))))}`;

test("a silent authorized call uses the stored access token and pins the v1 resource", async () => {
  const access = await jwt({ sub: "u1", scope: "artifacts:read artifacts:write" });
  const storage = memoryStorage([
    [await storageKeyFor(), { client: { client_id: "client-1" }, tokens: { access_token: access } }],
  ]);
  const auth = createSdkAuth({ origin, storage });
  assert.deepEqual(auth.options.resource, `${origin}/api/v1`);
  assert.deepEqual(auth.options.scope, "artifacts:read artifacts:write");
  const token = await auth.authorized(async (value) => value, undefined);
  assert.equal(token, access, "the operation runs with the stored access token, no consent");
  assert.deepEqual(storage.entries.size, 1, "silent flow persists nothing");
});

test("a rejected operation rotates the refresh token, persists it, and retries once", async () => {
  const saved: SavedAuth = {
    client: { client_id: "client-1" },
    tokens: { access_token: await jwt({ sub: "u1" }), refresh_token: "refresh-1" },
  };
  const storage = memoryStorage([[await storageKeyFor(), saved]]);
  const bodies: string[] = [];
  let attempts = 0;
  const auth = createSdkAuth({
    origin,
    storage,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json({ access_token: await jwt({ sub: "u1" }), refresh_token: "refresh-2" });
    }) as typeof fetch,
  });
  let first = true;
  const value = await auth.authorized(async (token) => {
    if (first) {
      first = false;
      attempts += 1;
      throw new Unauthorized("expired");
    }
    attempts += 1;
    return { token, used: true };
  });
  assert.deepEqual(value, {
    token: (await storage.entries.values().next().value)?.tokens.access_token ?? "",
    used: true,
  });
  assert.equal(attempts, 2, "exactly one retry after rotation");
  const rotated = [...storage.entries.values()][0]!;
  assert.equal(rotated.tokens.refresh_token, "refresh-2", "the rotated refresh token is persisted before the retry");
  const params = new URLSearchParams(bodies[0]!);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "refresh-1");
  assert.equal(params.get("client_id"), "client-1");
});

test("without an injected authorize, a client without tokens stays silent and registers the v1 resource opt-in", async () => {
  const storage = memoryStorage();
  const registerCalls: string[] = [];
  const auth = createSdkAuth({
    origin,
    storage,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      registerCalls.push(String(init?.body));
      return new Response(JSON.stringify({ client_id: "client-9" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const none = await auth.authorized(async () => "never");
  assert.equal(none, null, "no tokens and no consent flow: null, not a fabricated success");
  const client = await auth.register();
  assert.deepEqual(client, { client: { client_id: "client-9" } });
  const body = JSON.parse(registerCalls[0]!) as {
    resources: string[];
    client_name: string;
    token_endpoint_auth_method: string;
  };
  assert.deepEqual(body.resources, [`${origin}/api/v1`], "api/v1 is requested explicitly (opt-in resource linking)");
  assert.equal(body.token_endpoint_auth_method, "none", "public native client with PKCE");
});
