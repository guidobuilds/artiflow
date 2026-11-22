import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { hashPassword } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";

import { createAuth, createAuthApp, type AuthConfig } from "../apps/api/src/auth.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { account, session, user } from "../apps/api/src/adapters/postgres/db/schema.ts";

const baseConfig: AuthConfig = loadConfig(process.env);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const TEST_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB = { clientId: "github-test-id", clientSecret: "github-test-secret" };
const SIGN_UP = "/api/auth/sign-up/email";
const policy = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);
const config = (overrides: Partial<AuthConfig> = {}): AuthConfig => ({ ...baseConfig, ...overrides });

let adminPool: Pool | null = null;
let database: Database | null = null;
let testDatabaseName = "";
let testDatabaseCreated = false;
let appServer: ReturnType<typeof serve> | null = null;
let appBaseUrl = "";

type Started = { server: ReturnType<typeof serve>; baseUrl: string };

async function startServer(authConfig: AuthConfig): Promise<Started> {
  const app = new Hono();
  app.route("/", createAuthApp(createAuth(authConfig, db()), authConfig));
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
      resolve({ server, baseUrl: `http://127.0.0.1:${info.port}` }),
    );
    server.once("error", reject);
  });
}

async function stopServer(server: ReturnType<typeof serve> | null): Promise<void> {
  if (!server) return;
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function db(): Database {
  assert.ok(database);
  return database;
}

function request(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  baseUrl = appBaseUrl,
): Promise<Response> {
  return request(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseConfig.publicOrigin, ...headers },
    body: JSON.stringify(body),
  });
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .filter((value) => value !== "")
    .join("; ");
}

function sessionCookie(response: Response): string {
  const pair = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .find((value) => value.includes("session_token"));
  assert.equal(typeof pair === "string" && pair.length > 0, true);
  return pair as string;
}

async function counts(): Promise<{ users: number; sessions: number; accounts: number }> {
  const [users, sessions, accounts] = await Promise.all([
    db().db.select({ id: user.id }).from(user),
    db().db.select({ id: session.id }).from(session),
    db().db.select({ id: account.id }).from(account),
  ]);
  return { users: users.length, sessions: sessions.length, accounts: accounts.length };
}

async function seedCredentialUser(email: string, password: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db()
    .db.insert(user)
    .values({ id, name: "Policy Test Owner", email, emailVerified: false, createdAt: now, updatedAt: now });
  await db()
    .db.insert(account)
    .values({
      id: randomUUID(),
      userId: id,
      providerId: "credential",
      accountId: id,
      password: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

async function seedLinkedSocialUser(email: string, providerAccountId: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db()
    .db.insert(user)
    .values({ id, name: "Linked Social Owner", email, emailVerified: true, createdAt: now, updatedAt: now });
  await db().db.insert(account).values({
    id: randomUUID(),
    userId: id,
    providerId: "github",
    accountId: providerAccountId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

type FakeProfile = { id: string; name: string; email: string };
type FakeIdp = { origin: string; close: () => Promise<void> };

function startFakeIdp(profile: FakeProfile): Promise<FakeIdp> {
  const server: Server = createServer((incoming, response) => {
    incoming.resume();
    const url = incoming.url ?? "";
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (incoming.method === "POST" && url.startsWith("/login/oauth/access_token")) {
      send(200, { access_token: "fake-provider-token", token_type: "bearer", scope: "read:user,user:email" });
      return;
    }
    if (incoming.method === "GET" && url === "/user") {
      send(200, { id: profile.id, login: "fake-octo", name: profile.name, email: profile.email, avatar_url: "" });
      return;
    }
    if (incoming.method === "GET" && url === "/user/emails") {
      send(200, [{ email: profile.email, primary: true, verified: true }]);
      return;
    }
    send(404, { error: "not_found" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.equal(typeof address === "object" && address !== null && "port" in address, true);
      const origin = `http://127.0.0.1:${(address as { port: number }).port}`;
      resolve({
        origin,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function routeProviderToIdp(origin: string): () => void {
  const real = globalThis.fetch;
  const realFetch = real.bind(globalThis);
  const routes: Record<string, string> = {
    "https://github.com/login/oauth/access_token": "/login/oauth/access_token",
    "https://api.github.com/user": "/user",
    "https://api.github.com/user/emails": "/user/emails",
  };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: unknown }).url ?? "");
    const route = routes[url];
    const target = route === undefined ? input : `${origin}${route}`;
    return realFetch(target as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

async function beginSocial(baseUrl: string, extra: Record<string, unknown> = {}) {
  const response = await post(
    "/api/auth/sign-in/social",
    {
      provider: "github",
      callbackURL: "/dashboard",
      errorCallbackURL: "/login?social=blocked",
      disableRedirect: true,
      ...extra,
    },
    {},
    baseUrl,
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { url?: string; redirect?: boolean };
  const state = new URL(String(payload.url)).searchParams.get("state");
  assert.equal(typeof state === "string" && state.length > 0, true);
  return { state: state as string, cookie: cookieHeader(response) };
}

function socialCallback(baseUrl: string, state: string, cookie: string): Promise<Response> {
  const query = new URLSearchParams({ code: "fake-authorization-code", state });
  return request(`${baseUrl}/api/auth/callback/github?${query.toString()}`, {
    redirect: "manual",
    headers: { cookie },
  });
}

before(async () => {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  assert.equal(url.protocol === "postgres:" || url.protocol === "postgresql:", true);
  assert.equal(LOOPBACK_HOSTS.has(url.hostname), true);
  assert.equal(decodeURIComponent(url.pathname.replace(/^\//, "")) === "artiflow", true);

  adminPool = new Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  await adminPool.query("SELECT 1");
  testDatabaseName = `artiflow_policy_test_${randomUUID().replaceAll("-", "")}`;
  assert.equal(/^artiflow_policy_test_[0-9a-f]{32}$/.test(testDatabaseName), true);
  await adminPool.query("CREATE DATABASE " + escapeIdentifier(testDatabaseName));
  testDatabaseCreated = true;

  const testUrl = new URL(raw);
  testUrl.pathname = `/${testDatabaseName}`;
  database = createDatabase(testUrl.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: MIGRATIONS_FOLDER });

  const started = await startServer(baseConfig);
  appServer = started.server;
  appBaseUrl = started.baseUrl;
});

after(async () => {
  await stopServer(appServer).catch(() => undefined);
  await database?.close().catch(() => undefined);
  appServer = null;
  database = null;

  let retained = "";
  if (adminPool && testDatabaseCreated && testDatabaseName) {
    try {
      await adminPool.query("DROP DATABASE IF EXISTS " + escapeIdentifier(testDatabaseName));
    } catch {
      retained = testDatabaseName;
    }
  }
  await adminPool?.end().catch(() => undefined);
  adminPool = null;
  assert.equal(retained, "", `Owned test database retained for manual cleanup: ${retained}`);
});

policy("public sign-up is refused in every profile, including forged headers and requestSignUp", async () => {
  const production = await startServer(config({ nodeEnv: "production", demoAuth: false }));
  const testEnv = await startServer(config({ nodeEnv: "test" }));
  try {
    const before = await counts();
    const valid = () => ({
      name: "Public Sign Up",
      email: `public-${randomUUID()}@example.test`,
      password: `public-password-${randomUUID()}`,
    });
    const attempts: { path: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [
      { path: SIGN_UP, headers: {}, body: valid() },
      { path: SIGN_UP, headers: { "x-artiflow-invitation": "forged-invitation" }, body: valid() },
      { path: `${SIGN_UP}?invitation=forged-invitation`, headers: {}, body: valid() },
      { path: SIGN_UP, headers: {}, body: { ...valid(), invitation: "forged-invitation", requestSignUp: true } },
    ];
    for (const baseUrl of [appBaseUrl, production.baseUrl, testEnv.baseUrl]) {
      for (const attempt of attempts) {
        const response = await post(attempt.path, attempt.body, attempt.headers, baseUrl);
        assert.equal(response.status, 400, `${attempt.path} must be refused`);
        const sent = (await response.json()) as { code?: string };
        assert.equal(sent.code, "EMAIL_PASSWORD_SIGN_UP_DISABLED");
        assert.equal(
          response.headers.getSetCookie().some((value) => value.includes("session_token")),
          false,
        );
      }
    }
    assert.deepEqual(await counts(), before);
  } finally {
    await stopServer(production.server);
    await stopServer(testEnv.server);
  }
});

policy("a new social account is refused even when the client asks to sign up", async () => {
  const idp = await startFakeIdp({
    id: `gh-new-${randomUUID()}`,
    name: "New Social",
    email: `new-${randomUUID()}@example.test`,
  });
  const restore = routeProviderToIdp(idp.origin);
  const server = await startServer(config({ authProviders: { github: GITHUB } }));
  try {
    const before = await counts();
    const begun = await beginSocial(server.baseUrl, { requestSignUp: true });
    const response = await socialCallback(server.baseUrl, begun.state, begun.cookie);
    assert.equal(response.status, 302);
    const location = response.headers.get("location") ?? "";
    assert.equal(location.startsWith("/login?social=blocked"), true);
    assert.equal(location.includes("error=signup_disabled"), true);
    assert.equal(
      response.headers.getSetCookie().some((value) => value.includes("session_token")),
      false,
    );
    assert.deepEqual(await counts(), before);
  } finally {
    restore();
    await idp.close();
    await stopServer(server.server);
  }
});

policy("an already-linked social account still signs in", async () => {
  const email = `linked-${randomUUID()}@example.test`;
  const providerAccountId = `gh-linked-${randomUUID()}`;
  await seedLinkedSocialUser(email, providerAccountId);
  const idp = await startFakeIdp({ id: providerAccountId, name: "Linked Social", email });
  const restore = routeProviderToIdp(idp.origin);
  const server = await startServer(config({ authProviders: { github: GITHUB } }));
  try {
    const before = await counts();
    const begun = await beginSocial(server.baseUrl);
    const response = await socialCallback(server.baseUrl, begun.state, begun.cookie);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/dashboard");

    const sessionResponse = await request(`${server.baseUrl}/api/auth/get-session`, {
      headers: { cookie: sessionCookie(response) },
    });
    assert.equal(sessionResponse.status, 200);
    const payload = (await sessionResponse.json()) as { user?: { email?: string } } | null;
    assert.equal(payload?.user?.email, email);

    const afterwards = await counts();
    assert.equal(afterwards.users, before.users);
    assert.equal(afterwards.sessions, before.sessions + 1);
  } finally {
    restore();
    await idp.close();
    await stopServer(server.server);
  }
});

policy("a seeded existing password account still signs in", async () => {
  const email = `owner-${randomUUID()}@example.test`;
  const password = `local-test-password-${randomUUID()}`;
  const ownerId = await seedCredentialUser(email, password);
  const before = await counts();
  const response = await post("/api/auth/sign-in/email", { email, password });
  assert.equal(response.status, 200);
  const cookie = sessionCookie(response);

  const sessionResponse = await request(`${appBaseUrl}/api/auth/get-session`, { headers: { cookie } });
  assert.equal(sessionResponse.status, 200);
  const payload = (await sessionResponse.json()) as { user?: { id?: string; email?: string } } | null;
  assert.equal(payload?.user?.id, ownerId);
  assert.equal(payload?.user?.email, email);

  const afterwards = await counts();
  assert.equal(afterwards.users, before.users);
  assert.equal(afterwards.sessions, before.sessions + 1);
});
