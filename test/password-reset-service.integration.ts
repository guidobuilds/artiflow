import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";

import {
  createAuth,
  createAuthApp,
  emailPasswordOptions,
  socialProviderOptions,
  type AuthConfig,
} from "../apps/api/src/auth.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { registrationAuthSchema } from "../apps/api/src/adapters/postgres/db/auth-schema.ts";
import { account, user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { oauthPlugins } from "../apps/api/src/oauth.ts";
import { passwordReset } from "../apps/api/src/password-reset/plugin.ts";
import { consumePasswordReset, issuePasswordReset } from "../apps/api/src/password-reset/service.ts";

const baseConfig: AuthConfig = loadConfig(process.env);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_FOLDER = join(PROJECT_ROOT, "drizzle");
const TEST_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SIGN_IN_PATH = "/api/auth/sign-in/email";
const SESSION_PATH = "/api/auth/get-session";
const service = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

let adminPool: Pool | null = null;
let database: Database | null = null;
let testDatabaseName = "";
let testDatabaseCreated = false;
let authServer: ReturnType<typeof serve> | null = null;
let authBaseUrl = "";
let context: Awaited<ReturnType<typeof resetAuth>["$context"]> | null = null;

type Identity = { id?: string; email?: string };

function db(): Database {
  assert.ok(database);
  return database;
}

function resetAuth(target: Database) {
  return betterAuth({
    baseURL: baseConfig.publicOrigin,
    secret: baseConfig.authSecret,
    trustedOrigins: [baseConfig.publicOrigin],
    telemetry: { enabled: false },
    logger: { disabled: true },
    emailAndPassword: emailPasswordOptions(baseConfig),
    socialProviders: socialProviderOptions(baseConfig.authProviders),
    session: { cookieCache: { enabled: false } },
    plugins: [...oauthPlugins(baseConfig), passwordReset()],
    advanced: {
      cookiePrefix: "artiflow",
      useSecureCookies: baseConfig.nodeEnv === "production",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
    },
    database: drizzleAdapter(target.db, { provider: "pg", schema: registrationAuthSchema, transaction: true }),
  });
}

function authContext(): NonNullable<typeof context> {
  assert.ok(context, "the auth context is initialized");
  return context;
}

function request(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function signIn(email: string, password: string): Promise<Response> {
  return request(`${authBaseUrl}${SIGN_IN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseConfig.publicOrigin },
    body: JSON.stringify({ email, password }),
  });
}

function sessionCookie(response: Response): string {
  return (
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.includes("session_token")) ?? ""
  );
}

async function sessionUser(cookie: string): Promise<Identity | null> {
  const response = await request(`${authBaseUrl}${SESSION_PATH}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { user?: Identity } | null;
  return payload?.user ?? null;
}

async function signedInCookie(email: string, password: string): Promise<string> {
  const response = await signIn(email, password);
  assert.equal(response.status, 200, "the fixture signs in over the public route");
  const cookie = sessionCookie(response);
  assert.equal(cookie.length > 0, true, "a successful sign-in issues a session cookie");
  return cookie;
}

async function seedCredentialUser(email: string, password: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db()
    .db.insert(user)
    .values({ id, name: "Reset Service Owner", email, emailVerified: false, createdAt: now, updatedAt: now });
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

async function seedSocialUser(email: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db()
    .db.insert(user)
    .values({ id, name: "Social Owner", email, emailVerified: true, createdAt: now, updatedAt: now });
  await db()
    .db.insert(account)
    .values({
      id: randomUUID(),
      userId: id,
      providerId: "github",
      accountId: `github-${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

async function issue(email: string): Promise<string> {
  const issued = await issuePasswordReset(db().db, email);
  assert.equal(issued.kind, "issued", `a link is issued for ${email}`);
  return issued.kind === "issued" ? issued.token : "";
}

async function storedAccounts(userId: string): Promise<{ providerId: string; password: string | null }[]> {
  const result = await db().pool.query<{ providerId: string; password: string | null }>(
    'SELECT "providerId", "password" FROM "account" WHERE "userId" = $1 ORDER BY "providerId"',
    [userId],
  );
  return result.rows;
}

async function consumedCount(userId: string): Promise<number> {
  const result = await db().pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM "passwordResetToken" WHERE "userId" = $1 AND "consumedAt" IS NOT NULL',
    [userId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function sessionCount(userId: string): Promise<number> {
  const result = await db().pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM "session" WHERE "userId" = $1',
    [userId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function storedCredentialHash(userId: string): Promise<string> {
  const credential = (await storedAccounts(userId)).find((row) => row.providerId === "credential");
  assert.ok(credential?.password, "the account has a stored credential hash");
  return credential.password;
}

before(async () => {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  assert.equal(url.protocol === "postgres:" || url.protocol === "postgresql:", true);
  assert.equal(LOOPBACK_HOSTS.has(url.hostname), true);
  assert.equal(decodeURIComponent(url.pathname.replace(/^\//, "")) === "artiflow", true);

  adminPool = new Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  await adminPool.query("SELECT 1");
  testDatabaseName = `artiflow_reset_service_test_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query("CREATE DATABASE " + escapeIdentifier(testDatabaseName));
  testDatabaseCreated = true;

  const testUrl = new URL(raw);
  testUrl.pathname = `/${testDatabaseName}`;
  database = createDatabase(testUrl.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: MIGRATIONS_FOLDER });

  const auth = createAuth(baseConfig, database);
  context = await resetAuth(database).$context;

  const app = new Hono();
  app.route("/", createAuthApp(auth, baseConfig));
  authServer = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      authBaseUrl = `http://127.0.0.1:${info.port}`;
      resolve(server);
    });
    server.once("error", reject);
  });
});

after(async () => {
  if (authServer) {
    (authServer as { closeAllConnections?: () => void }).closeAllConnections?.();
    const server = authServer;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    authServer = null;
  }
  await database?.close().catch(() => undefined);
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

service("a link is consumed once and the second attempt is refused", async () => {
  const email = `once-${randomUUID()}@example.test`;
  const oldPassword = `old-password-${randomUUID()}`;
  const newPassword = `new-password-${randomUUID()}`;
  const ownerId = await seedCredentialUser(email, oldPassword);
  const token = await issue(email);

  const first = await consumePasswordReset(authContext(), { token, newPassword });
  assert.deepEqual(first, { kind: "consumed" });
  const second = await consumePasswordReset(authContext(), { token, newPassword: `again-${randomUUID()}` });
  assert.deepEqual(second, { kind: "invalid" }, "the same link never works twice");
  assert.equal(await consumedCount(ownerId), 1, "the link is marked consumed exactly once");
  assert.equal(await verifyPassword({ hash: await storedCredentialHash(ownerId), password: newPassword }), true);
});

service("an expired link is refused and changes nothing", async () => {
  const email = `expired-${randomUUID()}@example.test`;
  const oldPassword = `old-password-${randomUUID()}`;
  const ownerId = await seedCredentialUser(email, oldPassword);
  const token = await issue(email);
  await db().pool.query(
    'UPDATE "passwordResetToken" SET "expiresAt" = now() - interval \'1 second\' WHERE "userId" = $1',
    [ownerId],
  );

  const refused = await consumePasswordReset(authContext(), { token, newPassword: `new-password-${randomUUID()}` });
  assert.deepEqual(refused, { kind: "invalid" }, "an expired link reports the same generic refusal");
  assert.equal(await consumedCount(ownerId), 0, "an expired link is never marked consumed");
  assert.equal((await signIn(email, oldPassword)).status, 200, "the old password still works");
});

service("an unknown or tampered token is refused", async () => {
  const email = `tampered-${randomUUID()}@example.test`;
  const oldPassword = `old-password-${randomUUID()}`;
  const ownerId = await seedCredentialUser(email, oldPassword);
  const token = await issue(email);

  const tampered = await consumePasswordReset(authContext(), {
    token: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
    newPassword: `tampered-${randomUUID()}`,
  });
  assert.deepEqual(tampered, { kind: "invalid" });

  const unknown = await consumePasswordReset(authContext(), {
    token: Buffer.alloc(32, 7).toString("base64url"),
    newPassword: `unknown-${randomUUID()}`,
  });
  assert.deepEqual(unknown, { kind: "invalid" });

  const empty = await consumePasswordReset(authContext(), { token: "", newPassword: `empty-${randomUUID()}` });
  assert.deepEqual(empty, { kind: "invalid" });

  assert.equal(await consumedCount(ownerId), 0, "a refused attempt consumes nothing");
  assert.equal((await signIn(email, oldPassword)).status, 200, "the old password still works");

  const newPassword = `still-valid-${randomUUID()}`;
  assert.deepEqual(await consumePasswordReset(authContext(), { token, newPassword }), { kind: "consumed" });
});

service("a credential account gets its password replaced, not a second account row", async () => {
  const email = `credential-${randomUUID()}@example.test`;
  const oldPassword = `old-password-${randomUUID()}`;
  const newPassword = `new-password-${randomUUID()}`;
  const ownerId = await seedCredentialUser(email, oldPassword);
  const token = await issue(email);

  assert.deepEqual(await consumePasswordReset(authContext(), { token, newPassword }), { kind: "consumed" });

  const accounts = await storedAccounts(ownerId);
  assert.deepEqual(
    accounts.map((row) => row.providerId),
    ["credential"],
    "no account row is created for an account that already has one",
  );
  const hash = await storedCredentialHash(ownerId);
  assert.equal(await verifyPassword({ hash, password: newPassword }), true, "the new password verifies");
  assert.equal(await verifyPassword({ hash, password: oldPassword }), false, "the old password no longer verifies");

  assert.equal((await signIn(email, newPassword)).status, 200, "the new password signs in");
  assert.equal((await signIn(email, oldPassword)).status >= 400, true, "the old password is refused");
});

service("a social-only account gains a local credential password", async () => {
  const email = `social-${randomUUID()}@example.test`;
  const newPassword = `social-password-${randomUUID()}`;
  const ownerId = await seedSocialUser(email);
  const token = await issue(email);

  assert.deepEqual(await consumePasswordReset(authContext(), { token, newPassword }), { kind: "consumed" });

  const accounts = await storedAccounts(ownerId);
  assert.deepEqual(
    accounts.map((row) => row.providerId),
    ["credential", "github"],
    "the social account keeps its provider row and gains a credential one",
  );
  const hash = await storedCredentialHash(ownerId);
  assert.equal(await verifyPassword({ hash, password: newPassword }), true);
  assert.equal((await signIn(email, newPassword)).status, 200, "the new local password signs in");
});

service("every open session of the account is invalidated", async () => {
  const email = `sessions-${randomUUID()}@example.test`;
  const oldPassword = `old-password-${randomUUID()}`;
  const newPassword = `new-password-${randomUUID()}`;
  const ownerId = await seedCredentialUser(email, oldPassword);
  const laptop = await signedInCookie(email, oldPassword);
  const phone = await signedInCookie(email, oldPassword);
  assert.equal(await sessionCount(ownerId), 2, "the fixture holds two open sessions");
  assert.equal((await sessionUser(laptop))?.id, ownerId);

  const token = await issue(email);
  assert.deepEqual(await consumePasswordReset(authContext(), { token, newPassword }), { kind: "consumed" });

  assert.equal(await sessionCount(ownerId), 0, "no session row survives the reset");
  assert.equal(await sessionUser(laptop), null, "the first stolen session is dead");
  assert.equal(await sessionUser(phone), null, "the second session is dead");
});

service("no token is written for an account that does not exist", async () => {
  const before = await db().pool.query<{ count: string }>('SELECT count(*)::text AS count FROM "passwordResetToken"');
  const missing = await issuePasswordReset(db().db, `missing-${randomUUID()}@example.test`);
  assert.deepEqual(missing, { kind: "no-account" });
  const afterRows = await db().pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM "passwordResetToken"',
  );
  assert.equal(afterRows.rows[0]?.count, before.rows[0]?.count, "a refused request writes no token");
});

service("a newer link invalidates the previous pending one", async () => {
  const local = `rotation-${randomUUID()}`;
  const email = `${local}@example.test`;
  const ownerId = await seedCredentialUser(email, `rotation-password-${randomUUID()}`);

  const first = await issue(email);
  const second = await issue(`  ${local.toUpperCase()}@Example.TEST  `);
  assert.notEqual(first, second);

  assert.deepEqual(
    await consumePasswordReset(authContext(), { token: first, newPassword: `stale-${randomUUID()}` }),
    { kind: "invalid" },
    "the replaced link is dead",
  );
  assert.equal((await signIn(email, `stale-${randomUUID()}`)).status >= 400, true);
  assert.deepEqual(
    await consumePasswordReset(authContext(), { token: second, newPassword: `fresh-${randomUUID()}` }),
    { kind: "consumed" },
    "the newest link is the only one that works",
  );
  assert.equal(await consumedCount(ownerId), 1);
});

service("the service hashes whatever it is given: policy belongs to the HTTP layer", async () => {
  const email = `policy-${randomUUID()}@example.test`;
  const ownerId = await seedCredentialUser(email, `old-password-${randomUUID()}`);
  const token = await issue(email);

  assert.deepEqual(await consumePasswordReset(authContext(), { token, newPassword: "short" }), { kind: "consumed" });
  const hash = await storedCredentialHash(ownerId);
  assert.equal(hash === "short", false, "the password is never stored in plaintext");
  assert.equal(await verifyPassword({ hash, password: "short" }), true);
});
