import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ArtiflowAuth, authorizationUrl, registrationBody, type SavedAuth } from "@artiflow/plugin-core/auth";

const base = "https://artifacts.example";
const resource = `${base}/api/v1`;
const scope = "artifacts:read artifacts:write offline_access";
const sdkKey = `sdk-auth:${createHash("sha256").update(base).digest("base64url")}`;
const legacyKey = `token:${createHash("sha256").update(base).digest("hex")}`;

const saved = (access: string, refresh?: string): SavedAuth => ({
  client: { client_id: "client" },
  tokens: { access_token: access, ...(refresh === undefined ? {} : { refresh_token: refresh }) },
});

function storage(initial: Record<string, unknown> = {}) {
  const reads: string[] = [];
  const writes: { key: string; value: SavedAuth }[] = [];
  const values = new Map(Object.entries(initial));
  return {
    reads,
    writes,
    values,
    async get(key: string) {
      reads.push(key);
      return values.get(key);
    },
    async set(key: string, value: SavedAuth) {
      writes.push({ key, value });
      values.set(key, value);
    },
  };
}

const fail = (reason: string) => async () => {
  assert.fail(reason);
};

test("credentials live in the SDK key space and the legacy token key is never read", async () => {
  const store = storage({ [legacyKey]: saved("legacy-access", "legacy-refresh") });
  const auth = new ArtiflowAuth(base, store, fail("no network for a legacy-only credential"), fail("no consent"));
  assert.equal(await auth.viewerToken(), null);
  assert.deepEqual(store.reads, [sdkKey]);
  assert.deepEqual(store.writes, []);
});

test("the viewer token is proven against the /api/v1 resource and needs no consent", async () => {
  const store = storage({ [sdkKey]: saved("access", "refresh") });
  const seen: string[] = [];
  const auth = new ArtiflowAuth(
    base,
    store,
    async (url, init) => {
      seen.push(String(url));
      assert.equal(init?.method, "GET");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access");
      assert.equal(new Headers(init?.headers).get("accept"), "application/json");
      assert.equal(new Headers(init?.headers).get("content-type"), null);
      assert.equal(init?.body, undefined);
      return Response.json({ artifacts: [] });
    },
    fail("no viewer consent"),
  );
  assert.equal(await auth.viewerToken(), "access");
  assert.deepEqual(seen, [`${base}/api/v1/artifacts`]);
  assert.ok(!seen.some((url) => url.includes("/mcp")), "the probe must not touch the MCP endpoint");
  assert.deepEqual(store.writes, []);
});

test("viewer token without stored credentials returns null without consent or network", async () => {
  const store = storage();
  const auth = new ArtiflowAuth(base, store, fail("no probe without credentials"), fail("no viewer consent"));
  assert.equal(await auth.viewerToken(), null);
  assert.deepEqual(store.writes, []);
});

test("viewer refresh shares tool serialization and persists rotating credentials before retry and return", async () => {
  const store = storage({ [sdkKey]: saved("expired", "old-refresh") });
  let refreshes = 0;
  const auth = new ArtiflowAuth(
    base,
    store,
    async (url, init) => {
      if (url === `${base}/api/auth/oauth2/token`) {
        refreshes++;
        assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "old-refresh");
        return Response.json({ access_token: "fresh", refresh_token: "rotated" });
      }
      if (new Headers(init?.headers).get("authorization") === "Bearer expired")
        return new Response(null, { status: 401 });
      assert.equal(store.writes.length, 1);
      return Response.json({ artifacts: [] });
    },
    fail("no consent"),
  );
  assert.deepEqual(await Promise.all([auth.viewerToken(), auth.api((api) => api.probe())]), ["fresh", undefined]);
  assert.equal(refreshes, 1);
  assert.deepEqual(store.writes, [{ key: sdkKey, value: saved("fresh", "rotated") }]);
});

for (const failure of ["http", "network"])
  test(`viewer refreshes after ${failure} probe failure before returning a token`, async () => {
    const store = storage({ [sdkKey]: saved("old", "refresh") });
    const auth = new ArtiflowAuth(base, store, async (url, init) => {
      if (url === `${base}/api/auth/oauth2/token`)
        return Response.json({ access_token: "fresh", refresh_token: "rotated" });
      if (new Headers(init?.headers).get("authorization") === "Bearer old") {
        if (failure === "network") throw new Error("probe unavailable");
        return new Response(null, { status: 503 });
      }
      assert.equal(store.writes.length, 1);
      return Response.json({ artifacts: [] });
    });
    assert.equal(await auth.viewerToken(), "fresh");
    assert.equal(store.writes.length, 1);
  });

test("viewer rejected token without refresh falls back without consent or storage mutation", async () => {
  const store = storage({ [sdkKey]: saved("expired") });
  const auth = new ArtiflowAuth(
    base,
    store,
    async () => new Response(null, { status: 401 }),
    fail("no viewer consent"),
  );
  assert.equal(await auth.viewerToken(), null);
  assert.deepEqual(store.writes, []);
});

test("viewer failed refresh returns null instead of rejecting, and preserves the credential", async () => {
  const store = storage({ [sdkKey]: saved("expired", "revoked") });
  let probes = 0;
  let refreshes = 0;
  const auth = new ArtiflowAuth(
    base,
    store,
    async (url) => {
      if (url === `${base}/api/auth/oauth2/token`) {
        refreshes++;
        return new Response(null, { status: 400 });
      }
      probes++;
      return new Response(null, { status: 401 });
    },
    fail("must not open browser"),
  );
  assert.equal(await auth.viewerToken(), null);
  assert.equal(probes, 1);
  assert.equal(refreshes, 1);
  assert.deepEqual(store.writes, []);
});

test("viewer token storage failure returns null instead of rejecting the RPC", async () => {
  const auth = new ArtiflowAuth(
    base,
    {
      async get() {
        throw new Error("storage unavailable");
      },
      async set() {},
    },
    fail("no network without a credential"),
    fail("no viewer consent"),
  );
  assert.equal(await auth.viewerToken(), null);
});

test("consent returns the stored token silently and never opens a browser for a working credential", async () => {
  const store = storage({ [sdkKey]: saved("access", "refresh") });
  const auth = new ArtiflowAuth(
    base,
    store,
    async (url, init) => {
      assert.equal(url, `${base}/api/v1/artifacts`);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access");
      return Response.json({ artifacts: [] });
    },
    fail("consent must not open a browser when the stored token works"),
  );
  assert.deepEqual(await auth.consent(), { token: "access" });
  assert.deepEqual(store.writes, []);
});

test("consent reports an unrepairable credential as an error value instead of rejecting", async () => {
  const store = storage({ [sdkKey]: saved("expired", "revoked") });
  const auth = new ArtiflowAuth(
    base,
    store,
    async (url) => {
      if (url === `${base}/api/auth/oauth2/token`) return new Response(null, { status: 400 });
      return new Response(null, { status: 401 });
    },
    fail("the injected consent flow replaces the browser"),
    async () => {
      throw new Error("Artiflow OAuth consent cancelled or timed out");
    },
  );
  assert.deepEqual(await auth.consent(), { error: "Artiflow OAuth consent cancelled or timed out" });
  assert.deepEqual(store.writes, []);
});

test("consent replaces a dead credential under the SDK key and the viewer then loads silently", async () => {
  const store = storage({ [sdkKey]: saved("expired", "revoked") });
  const auth = new ArtiflowAuth(
    base,
    store,
    async (url, init) => {
      if (url === `${base}/api/auth/oauth2/token`) return new Response(null, { status: 400 });
      if (new Headers(init?.headers).get("authorization") !== "Bearer consented")
        return new Response(null, { status: 401 });
      assert.equal(store.writes.length, 1);
      return Response.json({ artifacts: [] });
    },
    fail("the injected consent flow replaces the browser"),
    async () => saved("consented", "rotated"),
  );
  assert.deepEqual(await auth.consent(), { token: "consented" });
  assert.deepEqual(store.writes, [{ key: sdkKey, value: saved("consented", "rotated") }]);
  assert.equal(await auth.viewerToken(), "consented");
});

test("concurrent operations serialize rotating refresh tokens and persist before retry", async () => {
  const store = storage({ [sdkKey]: saved("expired", "old-refresh") });
  let refreshes = 0;
  const auth = new ArtiflowAuth(
    base,
    store,
    async (url, init) => {
      if (url === `${base}/api/auth/oauth2/token`) {
        refreshes++;
        assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "old-refresh");
        return Response.json({ access_token: "fresh", refresh_token: "rotated" });
      }
      if (new Headers(init?.headers).get("authorization") === "Bearer expired")
        return new Response(null, { status: 401 });
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fresh");
      return Response.json({ artifacts: [] });
    },
    fail("must not open browser"),
  );
  await Promise.all([auth.api((api) => api.probe()), auth.api((api) => api.probe())]);
  assert.equal(refreshes, 1);
  assert.deepEqual(store.writes[0], { key: sdkKey, value: saved("fresh", "rotated") });
});

test("failed refresh leaves persisted state untouched and does not retry a write", async () => {
  const store = storage({ [sdkKey]: saved("expired", "revoked") });
  let calls = 0;
  const auth = new ArtiflowAuth(base, store, async (url) => {
    if (url === `${base}/api/auth/oauth2/token`)
      return Response.json({ error: "sensitive-server-detail" }, { status: 400 });
    calls++;
    return new Response(null, { status: 401 });
  });
  await assert.rejects(
    auth.api((api) => api.write({ text: "text" })),
    {
      message: "Artiflow OAuth token request failed (HTTP 400)",
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(store.writes, []);
});

test("dynamic registration opts a native client into the API v1 resource", () => {
  assert.deepEqual(registrationBody({ redirectUri: "http://127.0.0.1:7777/callback", scope, resource }), {
    redirect_uris: ["http://127.0.0.1:7777/callback"],
    client_name: "Artiflow OpenCode",
    application_type: "native",
    token_endpoint_auth_method: "none",
    scope,
    resources: [resource],
  });
});

test("the authorization request carries PKCE, state and the mandatory resource", () => {
  const url = new URL(
    authorizationUrl({
      origin: base,
      clientId: "client",
      redirectUri: "http://127.0.0.1:7777/callback",
      scope,
      resource,
      state: "state",
      codeChallenge: "challenge",
    }),
  );
  assert.equal(url.origin, base);
  assert.equal(url.pathname, "/api/auth/oauth2/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    response_type: "code",
    client_id: "client",
    redirect_uri: "http://127.0.0.1:7777/callback",
    scope,
    state: "state",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    resource,
  });
});

test("DCR, browser consent, state and PKCE exchange persist under the SDK key", async () => {
  const store = storage();
  let challenge = "";
  let redirect = "";
  let registrations = 0;
  const auth = new ArtiflowAuth(
    base,
    store,
    async (url, init) => {
      if (url === `${base}/api/auth/oauth2/register`) {
        registrations++;
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init?.body));
        redirect = body.redirect_uris[0];
        assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        assert.deepEqual(body.resources, [resource]);
        assert.equal(body.application_type, "native");
        assert.equal(body.token_endpoint_auth_method, "none");
        assert.equal(body.scope, scope);
        return Response.json({ client_id: "client" }, { status: 201 });
      }
      if (url === `${base}/api/auth/oauth2/token`) {
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("client_id"), "client");
        assert.equal(body.get("redirect_uri"), redirect);
        assert.equal(body.get("code"), "code");
        assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), challenge);
        return Response.json({ access_token: "access", refresh_token: "refresh" });
      }
      assert.equal(url, `${base}/api/v1/artifacts`);
      assert.equal(store.writes.length, 1);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access");
      return Response.json({ artifacts: [] });
    },
    async (url) => {
      const authorize = new URL(url);
      assert.equal(authorize.origin, base);
      assert.equal(authorize.pathname, "/api/auth/oauth2/authorize");
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      assert.equal(authorize.searchParams.get("resource"), resource);
      challenge = authorize.searchParams.get("code_challenge")!;
      const callback = new URL(redirect);
      callback.searchParams.set("code", "code");
      callback.searchParams.set("state", "wrong-state");
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      assert.equal((await fetch(callback)).status, 200);
    },
  );
  await auth.api((api) => api.probe());
  await auth.api((api) => api.probe());
  assert.equal(registrations, 1);
  assert.deepEqual(store.writes, [{ key: sdkKey, value: saved("access", "refresh") }]);
});
