import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Hono } from "hono";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier, Pool } from "pg";

import { createAuth, createAuthApp, type AuthConfig } from "../../apps/api/src/auth.ts";
import { createDatabase, type Database } from "../../apps/api/src/adapters/postgres/db/client.ts";
import { oauthClient, oauthClientResource } from "../../apps/api/src/adapters/postgres/db/oauth-schema.ts";
import { OAUTH_SCOPES, publicResource } from "../../apps/api/src/oauth.ts";
import {
  seedTrustedAccount,
  signInTrustedAccount,
  type TrustedAccount,
  type TrustedAccountInit,
} from "./trusted-accounts.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const REQUEST_TIMEOUT_MS = 10_000;
const REDIRECT_URI = "http://127.0.0.1:5173/oauth/callback";

export type SeededClient = { clientId: string; clientSecret?: string; redirectUri: string };

export type ClientSeed = { scopes?: string[]; linkResource?: boolean };

export type AuthorizationRequest = {
  challenge: string;
  scope?: string;
  state?: string;
  resource?: string | null;
};

export type TokenExchange = { code: string; codeVerifier: string; resource?: string };

export type BeginResult = { oauthQuery?: string; redirectUri?: string };

export type TokenResponse = {
  access_token: string;
  token_type: string;
  scope?: string;
  refresh_token?: string;
};

export type Introspection = {
  active: boolean;
  client_id?: string;
  scope?: string;
  iss?: string;
  aud?: string | string[];
};

export type PkcePair = { verifier: string; challenge: string };

export type HarnessMount = (context: { auth: ReturnType<typeof createAuth>; baseUrl: string }) => Hono;

export type HarnessOptions = { mount?: HarnessMount };

export type OAuthHarness = {
  auth: ReturnType<typeof createAuth>;
  baseUrl: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  seedTrustedAccount: (init?: TrustedAccountInit) => Promise<TrustedAccount>;
  credentialSessionCookie: (init?: TrustedAccountInit) => Promise<string>;
  seedPublicClient: (seed?: ClientSeed) => Promise<SeededClient>;
  seedConfidentialClient: (seed?: ClientSeed) => Promise<SeededClient>;
  begin: (client: SeededClient, authorization: AuthorizationRequest, cookie: string) => Promise<BeginResult>;
  authorizeRequest: (client: SeededClient, authorization: AuthorizationRequest, cookie: string) => Promise<Response>;
  authorize: (client: SeededClient, authorization: AuthorizationRequest, cookie: string) => Promise<string>;
  consent: (oauthQuery: string, cookie: string) => Promise<string>;
  token: (client: SeededClient, exchange: TokenExchange) => Promise<TokenResponse>;
  tokenRequest: (client: SeededClient, exchange: TokenExchange, clientSecret?: string) => Promise<Response>;
  refresh: (client: SeededClient, refreshToken: string) => Promise<TokenResponse>;
  refreshRequest: (client: SeededClient, refreshToken: string) => Promise<Response>;
  introspect: (client: SeededClient, accessToken: string) => Promise<Introspection>;
  introspectRequest: (client: SeededClient, accessToken: string, clientSecret?: string) => Promise<Response>;
  revoke: (client: SeededClient, accessToken: string, clientSecret?: string) => Promise<Response>;
  authorizeToken: (client: SeededClient, cookie: string, scope?: string) => Promise<TokenResponse>;
  close: () => Promise<void>;
};

export function createPkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function basicAuth(clientId: string, secret: string): Record<string, string> {
  const encoded = Buffer.from(`${clientId}:${secret}`).toString("base64");
  return { authorization: `Basic ${encoded}` };
}

export async function countLeftoverTestDatabases(): Promise<number> {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(LOOPBACK_HOSTS.has(url.hostname), true);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  const pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 5000 });
  try {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_database WHERE datname LIKE $1",
      ["artiflow_oauth_test_%"],
    );
    return result.rows[0]?.count ?? 0;
  } finally {
    await pool.end();
  }
}

async function createOwnedDatabase(): Promise<{ pool: Pool; name: string; database: Database }> {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  assert.equal(url.protocol === "postgres:" || url.protocol === "postgresql:", true);
  assert.equal(LOOPBACK_HOSTS.has(url.hostname), true);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  assert.equal(decodeURIComponent(url.pathname.replace(/^\//, "")) === "artiflow", true);

  const pool = new Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  const name = `artiflow_oauth_test_${randomUUID().replaceAll("-", "")}`;
  assert.equal(/^artiflow_oauth_test_[0-9a-f]{32}$/.test(name), true);
  await pool.query("SELECT 1");
  await pool.query("CREATE DATABASE " + escapeIdentifier(name));

  const testUrl = new URL(raw);
  testUrl.pathname = `/${name}`;
  const database = createDatabase(testUrl.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: MIGRATIONS_FOLDER });
  return { pool, name, database };
}

export async function startOAuthHarness(config: AuthConfig, options: HarnessOptions = {}): Promise<OAuthHarness> {
  const { pool, name, database } = await createOwnedDatabase();
  const RESOURCE = publicResource(config);
  const auth = createAuth(config, database);
  const app = createAuthApp(auth, config);
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    started.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (options.mount) app.route("/", options.mount({ auth, baseUrl }));

  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  const seedAccount = (init: TrustedAccountInit = {}): Promise<TrustedAccount> => seedTrustedAccount(database, init);
  const credentialSessionCookie = async (init: TrustedAccountInit = {}): Promise<string> => {
    const account = await seedAccount({ name: "OAuth Test Owner", ...init });
    return signInTrustedAccount(baseUrl, config.publicOrigin, account);
  };

  const linkResource = async (clientId: string, createdAt: Date): Promise<void> => {
    await database.db.insert(oauthClientResource).values({
      id: randomUUID(),
      clientId,
      resourceId: RESOURCE,
      createdAt,
    });
  };

  const seedPublicClient = async (seed: ClientSeed = {}): Promise<SeededClient> => {
    const clientId = `fixture-${randomUUID()}`;
    const now = new Date();
    await database.db.insert(oauthClient).values({
      id: randomUUID(),
      clientId,
      name: "Fixture public client",
      redirectUris: [REDIRECT_URI],
      scopes: seed.scopes ?? [...OAUTH_SCOPES],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      requirePKCE: true,
      createdAt: now,
      updatedAt: now,
    });
    if (seed.linkResource !== false) await linkResource(clientId, now);
    return { clientId, redirectUri: REDIRECT_URI };
  };

  const seedConfidentialClient = async (seed: ClientSeed = {}): Promise<SeededClient> => {
    const clientId = `fixture-confidential-${randomUUID()}`;
    const clientSecret = `fixture-secret-${randomUUID()}`;
    const now = new Date();
    await database.db.insert(oauthClient).values({
      id: randomUUID(),
      clientId,
      clientSecret: createHash("sha256").update(clientSecret).digest("base64url"),
      name: "Fixture confidential client",
      redirectUris: [REDIRECT_URI],
      scopes: seed.scopes ?? [...OAUTH_SCOPES],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "client_secret_basic",
      requirePKCE: true,
      createdAt: now,
      updatedAt: now,
    });
    if (seed.linkResource !== false) await linkResource(clientId, now);
    return { clientId, clientSecret, redirectUri: REDIRECT_URI };
  };

  const clientCredentials = (
    client: SeededClient,
    clientSecret?: string,
  ): { headers: Record<string, string>; body: Record<string, string> } => {
    const secret = clientSecret ?? client.clientSecret;
    return secret
      ? { headers: basicAuth(client.clientId, secret), body: {} }
      : { headers: {}, body: { client_id: client.clientId } };
  };

  const clientFormPost = (path: string, client: SeededClient, form: Record<string, string>, clientSecret?: string) => {
    const credentials = clientCredentials(client, clientSecret);
    return request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...credentials.headers },
      body: new URLSearchParams({ ...credentials.body, ...form }).toString(),
    });
  };

  const authorizeRequest = (
    client: SeededClient,
    authorization: AuthorizationRequest,
    cookie: string,
  ): Promise<Response> => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      scope: authorization.scope ?? OAUTH_SCOPES.join(" "),
      state: authorization.state ?? randomUUID(),
      code_challenge: authorization.challenge,
      code_challenge_method: "S256",
    });
    const resource = authorization.resource === undefined ? RESOURCE : authorization.resource;
    if (resource !== null) params.set("resource", resource);
    return request(`/api/auth/oauth2/authorize?${params}`, {
      headers: { cookie },
      redirect: "manual",
    });
  };

  const beginAuthorization = async (
    client: SeededClient,
    authorization: AuthorizationRequest,
    cookie: string,
  ): Promise<BeginResult> => {
    const response = await authorizeRequest(client, authorization, cookie);
    let target = response.headers.get("location") ?? "";
    if (response.status === 200) {
      const body = (await response.json()) as { redirect?: boolean; url?: string };
      assert.equal(body.redirect, true);
      target = body.url ?? "";
    }
    assert.equal(target.length > 0, true);
    if (target.startsWith("/consent?")) return { oauthQuery: target.slice("/consent?".length) };
    return { redirectUri: target };
  };

  const authorize = async (client: SeededClient, authorization: AuthorizationRequest, cookie: string) => {
    const started = await beginAuthorization(client, authorization, cookie);
    assert.equal(typeof started.oauthQuery, "string");
    return started.oauthQuery as string;
  };

  const consent = async (oauthQuery: string, cookie: string): Promise<string> => {
    const response = await request("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json", origin: config.publicOrigin, cookie },
      body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { redirect?: boolean; url?: string };
    assert.equal(body.redirect, true);
    assert.equal(typeof body.url === "string", true);
    return body.url as string;
  };

  const tokenRequest = (client: SeededClient, exchange: TokenExchange, clientSecret?: string): Promise<Response> =>
    clientFormPost(
      "/api/auth/oauth2/token",
      client,
      {
        grant_type: "authorization_code",
        code: exchange.code,
        redirect_uri: client.redirectUri,
        code_verifier: exchange.codeVerifier,
        ...(exchange.resource ? { resource: exchange.resource } : {}),
      },
      clientSecret,
    );

  const token = async (client: SeededClient, exchange: TokenExchange): Promise<TokenResponse> => {
    const response = await tokenRequest(client, exchange);
    assert.equal(response.status, 200);
    return (await response.json()) as TokenResponse;
  };

  const introspectRequest = (client: SeededClient, accessToken: string, clientSecret?: string): Promise<Response> =>
    clientFormPost("/api/auth/oauth2/introspect", client, { token: accessToken }, clientSecret);

  const introspect = async (client: SeededClient, accessToken: string): Promise<Introspection> => {
    const response = await introspectRequest(client, accessToken);
    assert.equal(response.status, 200);
    return (await response.json()) as Introspection;
  };

  const revoke = (client: SeededClient, accessToken: string, clientSecret?: string): Promise<Response> =>
    clientFormPost("/api/auth/oauth2/revoke", client, { token: accessToken }, clientSecret);

  const refreshRequest = (client: SeededClient, refreshToken: string): Promise<Response> =>
    clientFormPost("/api/auth/oauth2/token", client, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

  const refresh = async (client: SeededClient, refreshToken: string): Promise<TokenResponse> => {
    const response = await refreshRequest(client, refreshToken);
    assert.equal(response.status, 200);
    return (await response.json()) as TokenResponse;
  };

  const authorizeToken = async (client: SeededClient, cookie: string, scope?: string) => {
    const pkce = createPkce();
    const started = await beginAuthorization(client, { challenge: pkce.challenge, scope }, cookie);
    const redirectUri = started.oauthQuery ? await consent(started.oauthQuery, cookie) : (started.redirectUri ?? "");
    const code = new URL(redirectUri).searchParams.get("code") ?? "";
    assert.equal(code.length > 0, true);
    return token(client, { code, codeVerifier: pkce.verifier });
  };

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await database.close().catch(() => undefined);
    let retained = "";
    try {
      await pool.query("DROP DATABASE IF EXISTS " + escapeIdentifier(name));
    } catch {
      retained = name;
    }
    await pool.end().catch(() => undefined);
    assert.equal(retained, "", `Owned test database retained for manual cleanup: ${retained}`);
  };

  return {
    auth,
    baseUrl,
    request,
    seedTrustedAccount: seedAccount,
    credentialSessionCookie,
    seedPublicClient,
    seedConfidentialClient,
    begin: beginAuthorization,
    authorizeRequest,
    authorize,
    consent,
    token,
    tokenRequest,
    refresh,
    refreshRequest,
    introspect,
    introspectRequest,
    revoke,
    authorizeToken,
    close,
  };
}
