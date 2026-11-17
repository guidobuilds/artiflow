import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { requireMcpAuth } from "@better-auth/mcp";

import { loadConfig } from "../apps/api/src/config.ts";
import { OAUTH_SCOPES, publicIssuer, publicResource } from "../apps/api/src/oauth.ts";
import {
  basicAuth,
  countLeftoverTestDatabases,
  createPkce,
  startOAuthHarness,
  type OAuthHarness,
  type SeededClient,
} from "./helpers/oauth.ts";

const config = loadConfig(process.env);
const RESOURCE = publicResource(config);
const ISSUER = publicIssuer(config);
const TEST_TIMEOUT_MS = 20_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

let harness: OAuthHarness;
let sessionCookie = "";
let client: SeededClient;

const jsonHeaders = () => ({ "content-type": "application/json", origin: config.publicOrigin });

function formPost(path: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  return harness.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

function postJson(path: string, body: unknown, headers: Record<string, string> = jsonHeaders()) {
  return harness.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

before(async () => {
  assert.equal(config.publicOrigin, "http://127.0.0.1:5173");
  harness = await startOAuthHarness(config);
  sessionCookie = await harness.credentialSessionCookie();
  client = await harness.seedPublicClient();
});

after(async () => {
  await harness.close();
  assert.equal(await countLeftoverTestDatabases(), 0);
});

integration("protected resource metadata publishes resource, issuer and scopes", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const response = await harness.request(path);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      resource?: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
      bearer_methods_supported?: string[];
    };
    assert.equal(body.resource, RESOURCE);
    assert.deepEqual(body.authorization_servers, [ISSUER]);
    assert.deepEqual(
      body.scopes_supported,
      OAUTH_SCOPES.filter((scope) => scope !== "offline_access"),
    );
    assert.deepEqual(body.bearer_methods_supported, ["header"]);
  }
});

integration("authorization server metadata publishes the literal issuer", async () => {
  const response = await harness.request("/.well-known/oauth-authorization-server/api/auth");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    issuer?: string;
    scopes_supported?: string[];
    grant_types_supported?: string[];
  };
  assert.equal(body.issuer, ISSUER);
  assert.deepEqual(body.scopes_supported, OAUTH_SCOPES);
  assert.equal(body.grant_types_supported?.includes("refresh_token"), true);
});

integration("token endpoint accepts form-encoded client authentication past the cookie guard", async () => {
  const unknown = await formPost(
    "/api/auth/oauth2/token",
    { grant_type: "authorization_code", code: "not-a-code", redirect_uri: client.redirectUri },
    basicAuth("unknown-client", "invalid-secret"),
  );
  assert.equal(unknown.status === 400 || unknown.status === 401, true);
  const unknownBody = (await unknown.json()) as { error?: string };
  assert.equal(typeof unknownBody.error, "string");

  const seeded = await formPost("/api/auth/oauth2/token", {
    grant_type: "authorization_code",
    client_id: client.clientId,
    code: "not-a-code",
    redirect_uri: client.redirectUri,
    code_verifier: "v".repeat(64),
  });
  assert.equal(seeded.status === 400 || seeded.status === 401, true);
  const seededBody = (await seeded.json()) as { error?: string };
  assert.equal(typeof seededBody.error, "string");
  assert.equal(seededBody.error === "origin_not_allowed", false);
  assert.equal(seededBody.error === "json_content_type_required", false);
});

integration("cookie-guarded protocol paths still require the exact origin and JSON", async () => {
  const noOrigin = await postJson("/api/auth/oauth2/consent", {}, { "content-type": "application/json" });
  assert.equal(noOrigin.status, 403);
  assert.deepEqual(await noOrigin.json(), { error: "origin_not_allowed" });

  const foreign = await postJson(
    "/api/auth/oauth2/consent",
    {},
    {
      ...jsonHeaders(),
      origin: "http://127.0.0.1:9999",
    },
  );
  assert.equal(foreign.status, 403);

  const notJson = await harness.request("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: config.publicOrigin },
    body: "",
  });
  assert.equal(notJson.status, 415);

  const lookalike = await formPost("/api/auth/oauth2/tokenx", { grant_type: "authorization_code" });
  assert.equal(lookalike.status, 403);
  assert.deepEqual(await lookalike.json(), { error: "origin_not_allowed" });

  const head = await harness.request("/.well-known/oauth-protected-resource", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

integration("dynamic client registration is open for native clients and still CSRF-guarded", async () => {
  const metadata = await harness.request("/.well-known/oauth-authorization-server/api/auth");
  const meta = (await metadata.json()) as { registration_endpoint?: string };
  assert.equal(metadata.status, 200);
  assert.equal(meta.registration_endpoint, `${ISSUER}/oauth2/register`);

  const registration = {
    client_name: "Local MCP CLI",
    redirect_uris: ["http://127.0.0.1:4919/callback"],
    application_type: "native",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };

  const anonymous = await postJson("/api/auth/oauth2/register", registration, {
    "content-type": "application/json",
  });
  assert.equal(anonymous.status, 201);
  const created = (await anonymous.json()) as {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
    token_endpoint_auth_method?: string;
  };
  assert.equal(typeof created.client_id === "string" && created.client_id.length > 0, true);
  assert.equal(created.client_secret, undefined, "an anonymous registration is a public client");
  assert.deepEqual(created.redirect_uris, ["http://127.0.0.1:4919/callback"]);
  assert.equal(created.token_endpoint_auth_method, "none");

  const cookieNoOrigin = await postJson("/api/auth/oauth2/register", registration, {
    "content-type": "application/json",
    cookie: sessionCookie,
  });
  assert.equal(cookieNoOrigin.status, 403);
  assert.deepEqual(await cookieNoOrigin.json(), { error: "origin_not_allowed" });

  const foreignOrigin = await postJson("/api/auth/oauth2/register", registration, {
    "content-type": "application/json",
    origin: "http://127.0.0.1:9999",
  });
  assert.equal(foreignOrigin.status, 403);
  assert.deepEqual(await foreignOrigin.json(), { error: "origin_not_allowed" });

  const notJson = await harness.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_name: "Nope" }).toString(),
  });
  assert.equal(notJson.status, 415);

  const badRedirect = await postJson(
    "/api/auth/oauth2/register",
    {
      ...registration,
      redirect_uris: ["http://10.0.0.8:4919/callback"],
    },
    { "content-type": "application/json" },
  );
  assert.equal(badRedirect.status, 400);
  const badRedirectBody = (await badRedirect.json()) as { error?: string };
  assert.equal(badRedirectBody.error === "access_denied", false);

  const clientCredentials = await postJson(
    "/api/auth/oauth2/register",
    {
      ...registration,
      grant_types: ["client_credentials"],
    },
    { "content-type": "application/json" },
  );
  assert.equal(clientCredentials.status, 400);
});

integration("owner-authorized managed client creation issues a working resource-bound client", async () => {
  const redirectUri = `${harness.baseUrl}/oauth/callback`;
  const attempt = {
    redirect_uris: [redirectUri],
    client_name: "Owner CLI",
    application_type: "native",
    token_endpoint_auth_method: "client_secret_basic",
  };
  const session = await harness.request("/api/auth/get-session", { headers: { cookie: sessionCookie } });
  const userId = ((await session.json()) as { user?: { id?: string } }).user?.id ?? "";
  assert.equal(userId.length > 0, true);

  const response = await postJson("/api/auth/oauth2/create-client", attempt, {
    ...jsonHeaders(),
    cookie: sessionCookie,
  });
  assert.equal(response.status, 201);
  const created = (await response.json()) as {
    client_id?: string;
    client_secret?: string;
    user_id?: string;
    application_type?: string;
    resources?: string[];
    redirect_uris?: string[];
    client_name?: string;
  };
  const clientId = created.client_id ?? "";
  const clientSecret = created.client_secret ?? "";
  assert.equal(clientId.length > 0, true);
  assert.equal(clientSecret.length > 0, true);
  assert.equal(created.user_id, userId);
  assert.equal(created.application_type, "native");
  assert.equal(created.client_name, "Owner CLI");
  assert.deepEqual(created.redirect_uris, [redirectUri]);
  assert.deepEqual(created.resources, [RESOURCE]);

  const owned: SeededClient = { clientId, clientSecret, redirectUri };
  const pkce = createPkce();
  const oauthQuery = await harness.authorize(owned, { challenge: pkce.challenge }, sessionCookie);
  const code = new URL(await harness.consent(oauthQuery, sessionCookie)).searchParams.get("code") ?? "";
  assert.equal(code.length > 0, true);
  const tokens = await harness.token(owned, { code, codeVerifier: pkce.verifier });
  assert.equal(tokens.access_token.length > 0, true);
  const active = await harness.introspect(owned, tokens.access_token);
  assert.equal(active.active, true);
  assert.equal(active.client_id, clientId);
  assert.equal(JSON.stringify(active.aud).includes(RESOURCE), true);

  const read = await harness.request(`/api/auth/oauth2/get-client?client_id=${clientId}`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(read.status, 401);
  assert.equal((await read.text()).includes("client_secret"), false);
  const list = await harness.request("/api/auth/oauth2/get-clients", { headers: { cookie: sessionCookie } });
  assert.equal(list.status, 401);

  const rotate = await postJson(
    "/api/auth/oauth2/client/rotate-secret",
    { client_id: clientId },
    {
      ...jsonHeaders(),
      cookie: sessionCookie,
    },
  );
  assert.equal(rotate.status, 401);
  assert.equal((await harness.introspect(owned, tokens.access_token)).active, true);

  const anonymous = await postJson("/api/auth/oauth2/create-client", attempt, jsonHeaders());
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.text()).includes("client_id"), false);

  const foreignOrigin = await postJson("/api/auth/oauth2/create-client", attempt, {
    ...jsonHeaders(),
    origin: "http://127.0.0.1:9999",
    cookie: sessionCookie,
  });
  assert.equal(foreignOrigin.status, 403);
  assert.deepEqual(await foreignOrigin.json(), { error: "origin_not_allowed" });

  const notJson = await harness.request("/api/auth/oauth2/create-client", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: config.publicOrigin,
      cookie: sessionCookie,
    },
    body: "",
  });
  assert.equal(notJson.status, 415);

  const admin = await postJson("/api/auth/admin/oauth2/create-client", attempt, {
    ...jsonHeaders(),
    cookie: sessionCookie,
  });
  assert.equal(admin.status, 404);
});

integration("positive PKCE flow earns a resource-bound bearer token end to end", async () => {
  const owned = await harness.seedConfidentialClient();
  const pkce = createPkce();
  const oauthQuery = await harness.authorize(owned, { challenge: pkce.challenge }, sessionCookie);
  const redirectUri = await harness.consent(oauthQuery, sessionCookie);

  const authorized = new URL(redirectUri);
  assert.equal(`${authorized.origin}${authorized.pathname}`, owned.redirectUri);
  assert.equal(authorized.searchParams.get("iss"), ISSUER);
  assert.equal(authorized.searchParams.get("state"), new URLSearchParams(oauthQuery).get("state"));
  const code = authorized.searchParams.get("code") ?? "";
  assert.equal(code.length > 0, true);

  const tokens = await harness.token(owned, { code, codeVerifier: pkce.verifier });
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.scope, OAUTH_SCOPES.join(" "));
  assert.equal(tokens.access_token.length > 0, true);

  const active = await harness.introspect(owned, tokens.access_token);
  assert.equal(active.active, true);
  assert.equal(active.client_id, owned.clientId);
  assert.equal(active.scope, OAUTH_SCOPES.join(" "));
  assert.equal(active.iss, ISSUER);
  assert.equal(JSON.stringify(active.aud).includes(RESOURCE), true);

  const revocation = await harness.revoke(owned, tokens.access_token);
  assert.equal(revocation.status, 400);
  const revokeBody = (await revocation.json()) as { error?: string };
  assert.equal(revokeBody.error, "unsupported_token_type");
  assert.equal((await harness.introspect(owned, tokens.access_token)).active, true);

  const strict = await harness.seedConfidentialClient();
  const strictQuery = await harness.authorize(strict, { challenge: createPkce().challenge }, sessionCookie);
  const strictCode = new URL(await harness.consent(strictQuery, sessionCookie)).searchParams.get("code") ?? "";
  const mismatched = await harness.tokenRequest(strict, { code: strictCode, codeVerifier: createPkce().verifier });
  assert.equal(mismatched.status, 400);
  const mismatchBody = (await mismatched.json()) as { error?: string };
  assert.equal(mismatchBody.error, "invalid_grant");
});

integration("offline_access refresh rotates the token and revocation is server-side", async () => {
  const owned = await harness.seedConfidentialClient();
  const pkce = createPkce();
  const oauthQuery = await harness.authorize(owned, { challenge: pkce.challenge }, sessionCookie);
  const scope = (new URLSearchParams(oauthQuery).get("scope") ?? "").split(" ");
  assert.equal(scope.includes("offline_access"), true);
  const code = new URL(await harness.consent(oauthQuery, sessionCookie)).searchParams.get("code") ?? "";

  const granted = await harness.token(owned, { code, codeVerifier: pkce.verifier });
  assert.equal(granted.scope, OAUTH_SCOPES.join(" "));
  const refreshToken = granted.refresh_token ?? "";
  assert.equal(refreshToken.length > 0, true);
  assert.equal((await harness.introspect(owned, refreshToken)).active, true);

  const refreshed = await harness.refresh(owned, refreshToken);
  assert.equal(refreshed.access_token.length > 0, true);
  assert.equal(refreshed.access_token === granted.access_token, false);
  const rotated = refreshed.refresh_token ?? "";
  assert.equal(rotated.length > 0, true);
  assert.equal(rotated === refreshToken, false);
  assert.equal((await harness.introspect(owned, refreshToken)).active, false);

  const active = await harness.introspect(owned, refreshed.access_token);
  assert.equal(active.active, true);
  assert.equal(active.client_id, owned.clientId);
  assert.equal(JSON.stringify(active.aud).includes(RESOURCE), true);

  assert.equal((await harness.revoke(owned, rotated)).status, 200);
  assert.equal((await harness.introspect(owned, rotated)).active, false);
  const afterRevoke = await harness.refreshRequest(owned, rotated);
  assert.equal(afterRevoke.status, 400);
  assert.equal(((await afterRevoke.json()) as { error?: string }).error, "invalid_grant");
});

integration("a grant without offline_access returns no refresh token", async () => {
  const owned = await harness.seedConfidentialClient();
  const pkce = createPkce();
  const scope = `${OAUTH_SCOPES[0]} ${OAUTH_SCOPES[1]}`;
  const oauthQuery = await harness.authorize(owned, { challenge: pkce.challenge, scope }, sessionCookie);
  const code = new URL(await harness.consent(oauthQuery, sessionCookie)).searchParams.get("code") ?? "";

  const tokens = await harness.token(owned, { code, codeVerifier: pkce.verifier });
  assert.equal(tokens.scope, scope);
  assert.equal("refresh_token" in tokens, false);
});

integration("a rotated refresh token cannot be replayed", async () => {
  const owned = await harness.seedConfidentialClient();
  const pkce = createPkce();
  const oauthQuery = await harness.authorize(owned, { challenge: pkce.challenge }, sessionCookie);
  const code = new URL(await harness.consent(oauthQuery, sessionCookie)).searchParams.get("code") ?? "";
  const granted = await harness.token(owned, { code, codeVerifier: pkce.verifier });
  const refreshToken = granted.refresh_token ?? "";

  const refreshed = await harness.refresh(owned, refreshToken);
  const rotated = refreshed.refresh_token ?? "";
  assert.equal(rotated === refreshToken, false);

  const replay = await harness.refreshRequest(owned, refreshToken);
  assert.equal(replay.status, 400);
  assert.equal(((await replay.json()) as { error?: string }).error, "invalid_grant");
  assert.equal((await harness.introspect(owned, rotated)).active, false);
});

integration("requireMcpAuth verifies exchanged tokens and enforces scopes", async () => {
  const owned = await harness.seedConfidentialClient();
  const protectedStub = requireMcpAuth(harness.auth, () => new Response("mcp-ok"), {
    issuer: ISSUER,
    resource: RESOURCE,
    requiredScopes: OAUTH_SCOPES,
    jwksUrl: `${harness.baseUrl}/api/auth/jwks`,
  });

  const anonymous = await protectedStub(new Request(RESOURCE));
  assert.equal(anonymous.status, 401);
  assert.equal((anonymous.headers.get("www-authenticate") ?? "").startsWith("Bearer"), true);

  const narrow = await harness.authorizeToken(owned, sessionCookie, OAUTH_SCOPES[0]);
  const denied = await protectedStub(
    new Request(RESOURCE, {
      headers: { authorization: `Bearer ${narrow.access_token}` },
    }),
  );
  assert.equal(denied.status, 403);
  const challenge = denied.headers.get("www-authenticate") ?? "";
  assert.equal(challenge.includes('error="insufficient_scope"'), true);
  assert.equal(challenge.includes("artifacts:write"), true);

  const full = await harness.authorizeToken(owned, sessionCookie);
  const bearer = await protectedStub(
    new Request(RESOURCE, {
      headers: { authorization: `Bearer ${full.access_token}` },
    }),
  );
  assert.equal(bearer.status, 200);
  assert.equal(await bearer.text(), "mcp-ok");

  const garbage = await protectedStub(
    new Request(RESOURCE, {
      headers: { authorization: "Bearer not-a-signed-token" },
    }),
  );
  assert.equal(garbage.status, 401);
  assert.equal((garbage.headers.get("www-authenticate") ?? "").startsWith("Bearer"), true);
});

integration("a resource-bound grant cannot be redeemed for another resource", async () => {
  const unlinked = await harness.seedPublicClient({ linkResource: false });
  const rejected = await harness.begin(unlinked, { challenge: createPkce().challenge }, sessionCookie);
  assert.equal(rejected.oauthQuery, undefined);
  const target = new URL(rejected.redirectUri ?? "");
  assert.equal(target.searchParams.get("error"), "invalid_target");
  assert.equal(target.searchParams.get("code"), null);

  const owned = await harness.seedConfidentialClient();
  const pkce = createPkce();
  const oauthQuery = await harness.authorize(owned, { challenge: pkce.challenge }, sessionCookie);
  const code = new URL(await harness.consent(oauthQuery, sessionCookie)).searchParams.get("code") ?? "";
  assert.equal(code.length > 0, true);

  const response = await harness.tokenRequest(owned, {
    code,
    codeVerifier: pkce.verifier,
    resource: "http://127.0.0.1:5173/other",
  });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error?: string }).error, "invalid_target");
});

integration("authorize requires the resource parameter and rejects a foreign one", async () => {
  const owned = await harness.seedPublicClient();
  const foreign = await harness.begin(
    owned,
    {
      challenge: createPkce().challenge,
      resource: "http://127.0.0.1:5173/other",
      state: "foreign-resource",
    },
    sessionCookie,
  );
  assert.equal(foreign.oauthQuery, undefined);
  const rejected = new URL(foreign.redirectUri ?? "");
  assert.equal(`${rejected.origin}${rejected.pathname}`, owned.redirectUri);
  assert.equal(rejected.searchParams.get("error"), "invalid_target");
  assert.equal(rejected.searchParams.get("state"), "foreign-resource");
  assert.equal(rejected.searchParams.get("iss"), ISSUER);
  assert.equal(rejected.searchParams.get("code"), null);

  const owned2 = await harness.seedConfidentialClient();
  const missing = await harness.authorizeRequest(
    owned2,
    {
      challenge: createPkce().challenge,
      resource: null,
    },
    sessionCookie,
  );
  assert.equal(missing.status, 400);
  assert.equal(missing.headers.get("location"), null);
  assert.deepEqual(await missing.json(), {
    error: "invalid_target",
    error_description: "resource parameter is required",
  });
});

integration("scope escalation at authorize is refused instead of silently narrowed", async () => {
  const readOnly = await harness.seedPublicClient({ scopes: ["artifacts:read"] });
  const escalated = await harness.begin(
    readOnly,
    {
      challenge: createPkce().challenge,
      scope: "artifacts:write",
    },
    sessionCookie,
  );
  assert.equal(escalated.oauthQuery, undefined);
  const rejected = new URL(escalated.redirectUri ?? "");
  assert.equal(`${rejected.origin}${rejected.pathname}`, readOnly.redirectUri);
  assert.equal(rejected.searchParams.get("error"), "invalid_scope");
  assert.equal(rejected.searchParams.get("code"), null);
});

integration("client authentication failures answer 401 invalid_client", async () => {
  const owned = await harness.seedConfidentialClient();
  const wrongSecret = "fixture-wrong-secret";
  const grant = {
    grant_type: "authorization_code",
    code: "not-a-code",
    redirect_uri: owned.redirectUri,
    code_verifier: "v".repeat(64),
  };

  const unknown = await formPost("/api/auth/oauth2/token", grant, basicAuth("unknown-client", wrongSecret));
  assert.equal(unknown.status, 401);
  assert.equal(((await unknown.json()) as { error?: string }).error, "invalid_client");

  const wrongToken = await harness.tokenRequest(
    owned,
    { code: grant.code, codeVerifier: grant.code_verifier },
    wrongSecret,
  );
  assert.equal(wrongToken.status, 401);
  assert.equal(((await wrongToken.json()) as { error?: string }).error, "invalid_client");

  const wrongIntrospection = await harness.introspectRequest(owned, "not-a-token", wrongSecret);
  assert.equal(wrongIntrospection.status, 401);
  assert.equal(((await wrongIntrospection.json()) as { error?: string }).error, "invalid_client");

  const wrongRevocation = await harness.revoke(owned, "not-a-token", wrongSecret);
  assert.equal(wrongRevocation.status, 401);
  assert.equal(((await wrongRevocation.json()) as { error?: string }).error, "invalid_client");
});

integration("an authorization code cannot be exchanged twice", async () => {
  const owned = await harness.seedConfidentialClient();
  const pkce = createPkce();
  const oauthQuery = await harness.authorize(owned, { challenge: pkce.challenge }, sessionCookie);
  const code = new URL(await harness.consent(oauthQuery, sessionCookie)).searchParams.get("code") ?? "";

  const first = await harness.tokenRequest(owned, { code, codeVerifier: pkce.verifier });
  assert.equal(first.status, 200);
  const replay = await harness.tokenRequest(owned, { code, codeVerifier: pkce.verifier });
  assert.equal(replay.status, 400);
  assert.equal(((await replay.json()) as { error?: string }).error, "invalid_grant");
});

integration("managed OAuth mutations stay guarded and deny-all for a real session", async () => {
  const owned = await harness.seedConfidentialClient();
  const noOrigin = await postJson("/api/auth/oauth2/continue", {}, { "content-type": "application/json" });
  assert.equal(noOrigin.status, 403);
  assert.deepEqual(await noOrigin.json(), { error: "origin_not_allowed" });

  const headers = { ...jsonHeaders(), cookie: sessionCookie };
  const attempts = [
    ["/api/auth/oauth2/update-client", { client_id: owned.clientId, update: {} }],
    ["/api/auth/oauth2/delete-client", { client_id: owned.clientId }],
  ] as const;
  for (const [path, body] of attempts) {
    const response = await postJson(path, body, headers);
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes("client_id"), false);
  }

  const survived = await harness.begin(owned, { challenge: createPkce().challenge }, sessionCookie);
  assert.equal(typeof survived.oauthQuery, "string");
});

integration("sign-in with an oauth_query resumes authorization through the provider hook", async () => {
  const owned = await harness.seedPublicClient();
  const pkce = createPkce();

  const anonymous = await harness.authorizeRequest(owned, { challenge: pkce.challenge }, "");
  assert.equal(anonymous.status, 200);
  const anonymousBody = (await anonymous.json()) as { redirect?: boolean; url?: string };
  assert.equal(anonymousBody.redirect, true);
  const loginTarget = anonymousBody.url ?? "";
  assert.equal(loginTarget.startsWith("/login?"), true);
  const signedQuery = loginTarget.slice("/login?".length);

  const account = await harness.seedTrustedAccount({ name: "Login Owner" });
  const { email, password } = account;

  const signIn = await postJson("/api/auth/sign-in/email", { email, password, oauth_query: signedQuery });
  assert.equal(signIn.status, 200);
  const signInBody = (await signIn.json()) as { redirect?: boolean; url?: string };
  assert.equal(signInBody.redirect, true, `sign-in body keys: ${Object.keys(signInBody).join(",")}`);
  const consentTarget = signInBody.url ?? "";
  assert.equal(consentTarget.startsWith("/consent?"), true);

  const freshQuery = consentTarget.slice("/consent?".length);
  assert.equal(freshQuery === signedQuery, false);
  const sessionPair = signIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .find((value) => value.includes("session_token"));
  assert.equal(typeof sessionPair === "string" && sessionPair.length > 0, true);
  const callback = await harness.consent(freshQuery, sessionPair as string);
  assert.equal(new URL(callback).searchParams.get("state"), new URLSearchParams(freshQuery).get("state"));
  assert.equal((new URL(callback).searchParams.get("code") ?? "").length > 0, true);
});

integration("cookie guard still blocks consent without the exact origin", async () => {
  const owned = await harness.seedConfidentialClient();
  const pkce = createPkce();
  const oauthQuery = await harness.authorize(owned, { challenge: pkce.challenge }, sessionCookie);
  const body = { accept: true, oauth_query: oauthQuery };

  const noOrigin = await postJson("/api/auth/oauth2/consent", body, { "content-type": "application/json" });
  assert.equal(noOrigin.status, 403);
  assert.deepEqual(await noOrigin.json(), { error: "origin_not_allowed" });

  assert.equal((await harness.consent(oauthQuery, sessionCookie)).includes("code="), true);
});
