import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";

import { createAuth, createAuthApp, emailPasswordEnabled, type AuthConfig } from "../apps/api/src/auth.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { account, session, user } from "../apps/api/src/adapters/postgres/db/schema.ts";

const config = loadConfig(process.env);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const TEST_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 10_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

let adminPool: Pool | null = null;
let database: Database | null = null;
let testDatabaseName = "";
let testDatabaseCreated = false;
let appServer: ReturnType<typeof serve> | null = null;
let appBaseUrl = "";
let ownerEmail = "";
let ownerPassword = "";
let ownerCookie = "";

type Started = { server: ReturnType<typeof serve>; baseUrl: string };

function db(): Database {
  assert.ok(database);
  return database;
}

function startServer(authConfig: AuthConfig): Promise<Started> {
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
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
    headers: { "content-type": "application/json", origin: config.publicOrigin, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
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
    .values({ id, name: "Local Test Owner", email, emailVerified: false, createdAt: now, updatedAt: now });
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

before(async () => {
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

  adminPool = new Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  await adminPool.query("SELECT 1");
  testDatabaseName = `artiflow_auth_test_${randomUUID().replaceAll("-", "")}`;
  assert.equal(/^artiflow_auth_test_[0-9a-f]{32}$/.test(testDatabaseName), true);
  await adminPool.query("CREATE DATABASE " + escapeIdentifier(testDatabaseName));
  testDatabaseCreated = true;

  const testUrl = new URL(raw);
  testUrl.pathname = `/${testDatabaseName}`;
  database = createDatabase(testUrl.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: MIGRATIONS_FOLDER });

  const started = await startServer(config);
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

integration("a trusted seeded identity signs in and gets a loopback-safe session cookie", async () => {
  assert.equal(emailPasswordEnabled(config), true);
  ownerEmail = `owner-${randomUUID()}@example.test`;
  ownerPassword = `local-test-password-${randomUUID()}`;
  const ownerId = await seedCredentialUser(ownerEmail, ownerPassword);
  const response = await post("/api/auth/sign-in/email", { email: ownerEmail, password: ownerPassword });
  assert.equal(response.status, 200);

  const wire = response.headers.getSetCookie().join("\n");
  assert.equal(wire.length > 0, true);
  assert.equal(/httponly/i.test(wire), true);
  assert.equal(/samesite=lax/i.test(wire), true);
  assert.equal(/path=\//i.test(wire), true);
  assert.equal(/;\s*secure/i.test(wire), false);
  ownerCookie = sessionCookie(response);

  const owners = await db().db.select({ id: user.id }).from(user).where(eq(user.email, ownerEmail));
  assert.equal(owners.length, 1);
  assert.equal(owners[0]?.id, ownerId);

  const accounts = await db().db.select().from(account).where(eq(account.userId, ownerId));
  assert.equal(accounts.length, 1);
  const stored = accounts[0]?.password ?? "";
  assert.equal(stored.length > 0, true);
  assert.equal(stored === ownerPassword, false);
  assert.equal(stored.includes(":"), true);
  assert.equal((await db().db.select().from(session).where(eq(session.userId, ownerId))).length, 1);
});

integration("public sign-up is refused with an invitation header and leaves no account", async () => {
  const before = await counts();
  const response = await post(
    "/api/auth/sign-up/email",
    {
      name: "Public Sign Up",
      email: `closed-${randomUUID()}@example.test`,
      password: `closed-password-${randomUUID()}`,
    },
    { "x-artiflow-invitation": "not-a-real-invitation" },
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, "EMAIL_PASSWORD_SIGN_UP_DISABLED");
  assert.equal(
    response.headers.getSetCookie().some((value) => value.includes("session_token")),
    false,
  );
  assert.deepEqual(await counts(), before);
});

integration("session lookup returns identity only with the cookie", async () => {
  const withCookie = await request(`${appBaseUrl}/api/auth/get-session`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(withCookie.status, 200);
  const body = (await withCookie.json()) as { user?: { email?: string } } | null;
  assert.equal(body?.user?.email === ownerEmail, true);

  const anonymous = await request(`${appBaseUrl}/api/auth/get-session`, {});
  assert.equal(anonymous.status === 200 || anonymous.status === 401, true);
  const text = await anonymous.text();
  assert.equal(text === "null" || text === "", true);
});

integration("wrong password is denied without creating a session", async () => {
  const before = await counts();
  const response = await post(
    "/api/auth/sign-in/email",
    { email: ownerEmail, password: `wrong-${randomUUID()}` },
    { "content-type": "application/json; charset=utf-8" },
  );
  assert.equal(response.status >= 400, true);
  assert.equal(
    response.headers.getSetCookie().some((value) => value.includes("session_token")),
    false,
  );
  assert.deepEqual(await counts(), before);
});

integration("mutations reject missing, foreign, null and non-JSON requests", async () => {
  const before = await counts();
  const payload = () => ({
    name: "Guard Test",
    email: `guard-${randomUUID()}@example.test`,
    password: `guard-password-${randomUUID()}`,
  });
  const path = "/api/auth/sign-up/email";
  const missing = await request(`${appBaseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload()),
  });
  assert.equal(missing.status, 403);
  assert.equal((await post(path, payload(), { origin: "http://127.0.0.1:9999" })).status, 403);
  assert.equal((await post(path, payload(), { origin: "null" })).status, 403);
  const text = await post(path, JSON.stringify(payload()), { "content-type": "text/plain" });
  assert.equal(text.status, 415);
  const form = await post(path, new URLSearchParams(payload()).toString(), {
    "content-type": "application/x-www-form-urlencoded",
  });
  assert.equal(form.status, 415);
  assert.deepEqual(await counts(), before);
});

integration("a fresh auth instance with the same database and secret keeps the session", async () => {
  const second = await startServer(config);
  try {
    const response = await request(`${second.baseUrl}/api/auth/get-session`, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { user?: { email?: string } } | null;
    assert.equal(body?.user?.email === ownerEmail, true);
  } finally {
    await stopServer(second.server);
  }
});

integration("sign-out clears the cookie and invalidates the database session", async () => {
  const response = await post("/api/auth/sign-out", {}, { cookie: ownerCookie });
  assert.equal(response.status, 200);
  assert.equal(/max-age=0/i.test(response.headers.getSetCookie().join("\n")), true);
  assert.equal((await db().db.select().from(session)).length, 0);

  const reuse = await request(`${appBaseUrl}/api/auth/get-session`, {
    headers: { cookie: ownerCookie },
  });
  const text = await reuse.text();
  assert.equal(text === "null" || text === "", true);
});

integration("capabilities expose the real login guards, uncached", async () => {
  const response = await request(`${appBaseUrl}/api/auth/capabilities`, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { emailPassword: true, registration: false, socialProviders: [] });
});

integration("capabilities expose production login and configured social providers", async () => {
  const production: AuthConfig = {
    ...config,
    nodeEnv: "production",
    demoAuth: false,
    authProviders: { github: { clientId: "github-id", clientSecret: "github-secret" } },
  };
  const prod = await startServer(production);
  try {
    const response = await request(`${prod.baseUrl}/api/auth/capabilities`, {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { emailPassword: true, registration: false, socialProviders: ["github"] });
  } finally {
    await stopServer(prod.server);
  }
});

integration("production refuses public sign-up and keeps existing-account login", async () => {
  const production: AuthConfig = { ...config, nodeEnv: "production", demoAuth: false };
  assert.equal(emailPasswordEnabled(production), true);
  const before = await counts();
  const prod = await startServer(production);
  try {
    const signUp = await post(
      "/api/auth/sign-up/email",
      { name: "Prod Test", email: `prod-${randomUUID()}@example.test`, password: randomUUID() },
      {},
      prod.baseUrl,
    );
    assert.equal(signUp.status, 400);
    assert.equal(
      signUp.headers.getSetCookie().some((value) => value.includes("session_token")),
      false,
    );

    const email = `prod-owner-${randomUUID()}@example.test`;
    const password = `prod-password-${randomUUID()}`;
    await seedCredentialUser(email, password);
    const signIn = await post("/api/auth/sign-in/email", { email, password }, {}, prod.baseUrl);
    assert.equal(signIn.status < 400, true);
    assert.equal(
      signIn.headers.getSetCookie().some((value) => value.includes("session_token")),
      true,
    );
  } finally {
    await stopServer(prod.server);
  }
  assert.equal((await counts()).users, before.users + 1);
});
