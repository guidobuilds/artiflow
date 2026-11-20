import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { hashPassword } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";

import type { AccessMethodsDocument } from "@artiflow/contracts/settings";

import { createAuthApp, type AuthConfig } from "../apps/api/src/auth.ts";
import { createAuthHolder } from "../apps/api/src/auth-holder.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { account, user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { decodeSecretKey, writeSecret } from "../apps/api/src/settings/secrets.ts";
import { providerSecretName } from "../apps/api/src/settings/seed.ts";
import { accessMethodsSetting, readSetting, writeSetting } from "../apps/api/src/settings/store.ts";

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TEST_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
const integration = (name: string, run: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, run);

const GITHUB_CLIENT_ID = "github-client-id-4c1f";
const GITHUB_SECRET = "github-client-secret-71ab";
const GOOGLE_CLIENT_ID = "google-client-id-2dd0";
const GOOGLE_SECRET = "google-client-secret-9e5c";

const config = loadConfig(process.env);
const KEY = decodeSecretKey(randomBytes(32).toString("base64"));
const OTHER_KEY = decodeSecretKey(randomBytes(32).toString("base64"));
const authConfig: AuthConfig = { ...config, authProviders: {}, secretEncryptionKey: KEY };

let adminPool: Pool | null = null;
let database: Database | null = null;
let testDatabaseName = "";
let testDatabaseCreated = false;
let holder: ReturnType<typeof createAuthHolder> | null = null;
let appServer: ReturnType<typeof serve> | null = null;
let appBaseUrl = "";
let ownerEmail = "";
let ownerCookie = "";

function db(): Database {
  assert.ok(database);
  return database;
}

function authHolder(): ReturnType<typeof createAuthHolder> {
  assert.ok(holder);
  return holder;
}

function disabled(): AccessMethodsDocument["providers"]["github"] {
  return { enabled: false, clientId: "", secretName: "" };
}

function accessDocument(providers: Partial<AccessMethodsDocument["providers"]> = {}): AccessMethodsDocument {
  return {
    password: { enabled: true },
    providers: {
      google: providers.google ?? disabled(),
      github: providers.github ?? disabled(),
    },
    provenance: { source: "environment", at: "2026-11-20T10:00:00.000Z" },
  };
}

async function storeAccess(value: AccessMethodsDocument): Promise<number> {
  const current = await readSetting(db().db, accessMethodsSetting);
  const written = await writeSetting(db().db, accessMethodsSetting, {
    value,
    expectedRevision: current?.revision ?? null,
  });
  return written.revision;
}

function startServer(): Promise<void> {
  const app = new Hono();
  app.route("/", createAuthApp(authHolder().auth, authConfig, authHolder().snapshot));
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      appServer = server;
      appBaseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
    server.once("error", reject);
  });
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${appBaseUrl}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function capabilities(): Promise<{ emailPassword: boolean; registration: boolean; socialProviders: string[] }> {
  const response = await request("/api/auth/capabilities");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as { emailPassword: boolean; registration: boolean; socialProviders: string[] };
}

async function seedCredentialUser(email: string, password: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db()
    .db.insert(user)
    .values({ id, name: "Rebuild Test Owner", email, emailVerified: false, createdAt: now, updatedAt: now });
  await db().db.insert(account).values({
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

async function signIn(email: string, password: string): Promise<string> {
  const response = await request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: authConfig.publicOrigin },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200, "the seeded identity signs in");
  const pair = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .find((value) => value.includes("session_token"));
  assert.equal(typeof pair === "string" && pair.length > 0, true);
  return pair as string;
}

async function sessionEmail(cookie: string): Promise<string | null> {
  const response = await request("/api/auth/get-session", { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { user?: { email?: string } } | null;
  return body?.user?.email ?? null;
}

before(async () => {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  assert.equal(url.protocol === "postgres:" || url.protocol === "postgresql:", true);
  assert.equal(LOOPBACK_HOSTS.has(url.hostname), true, "the test database must be a loopback PostgreSQL instance");
  assert.equal(decodeURIComponent(url.pathname.replace(/^\//, "")), "artiflow", "the test database must be the fixture");

  adminPool = new Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  await adminPool.query("SELECT 1");
  testDatabaseName = `artiflow_auth_rebuild_test_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query("CREATE DATABASE " + escapeIdentifier(testDatabaseName));
  testDatabaseCreated = true;

  const testUrl = new URL(raw);
  testUrl.pathname = `/${testDatabaseName}`;
  database = createDatabase(testUrl.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: MIGRATIONS_FOLDER });

  holder = createAuthHolder({ config: authConfig, database });
  await startServer();
});

after(async () => {
  if (appServer !== null) {
    await new Promise<void>((resolve, reject) => appServer?.close((error) => (error ? reject(error) : resolve())));
    appServer = null;
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

integration("a social provider appears only after the stored configuration enables it, with no restart", async () => {
  assert.deepEqual(await capabilities(), { emailPassword: true, registration: false, socialProviders: [] });

  await writeSetting(db().db, accessMethodsSetting, { value: accessDocument(), expectedRevision: null });
  assert.deepEqual(await capabilities(), { emailPassword: true, registration: false, socialProviders: [] });

  ownerEmail = `rebuild-owner-${randomUUID()}@example.test`;
  const password = `rebuild-password-${randomUUID()}`;
  await seedCredentialUser(ownerEmail, password);
  ownerCookie = await signIn(ownerEmail, password);
  assert.equal(await sessionEmail(ownerCookie), ownerEmail);

  await writeSecret(db().db, {
    name: providerSecretName("github"),
    value: GITHUB_SECRET,
    key: KEY,
  });
  await storeAccess(
    accessDocument({ github: { enabled: true, clientId: GITHUB_CLIENT_ID, secretName: providerSecretName("github") } }),
  );

  const enabled = await capabilities();
  assert.deepEqual(enabled, { emailPassword: true, registration: false, socialProviders: ["github"] });
  assert.equal(JSON.stringify(enabled).includes(GITHUB_SECRET), false, "capabilities never carry a credential");

  assert.equal(await sessionEmail(ownerCookie), ownerEmail, "a session created before the change still validates");

  const snapshot = await authHolder().snapshot();
  assert.deepEqual(Object.keys(snapshot.providers), ["github"]);
  assert.equal(snapshot.providers.github?.clientId, GITHUB_CLIENT_ID);
  assert.equal(snapshot.providers.github?.clientSecret, GITHUB_SECRET);
  assert.deepEqual(snapshot.degraded, []);
});

integration("a credential that cannot be decrypted degrades its provider instead of failing the request", async () => {
  await writeSecret(db().db, { name: providerSecretName("google"), value: GOOGLE_SECRET, key: OTHER_KEY });
  await storeAccess(
    accessDocument({
      google: { enabled: true, clientId: GOOGLE_CLIENT_ID, secretName: providerSecretName("google") },
      github: { enabled: true, clientId: GITHUB_CLIENT_ID, secretName: providerSecretName("github") },
    }),
  );

  assert.deepEqual(await capabilities(), {
    emailPassword: true,
    registration: false,
    socialProviders: ["github"],
  });

  const snapshot = await authHolder().snapshot();
  assert.deepEqual(snapshot.degraded, ["google"]);
  assert.equal("google" in snapshot.providers, false);
  assert.equal(await sessionEmail(ownerCookie), ownerEmail);

  const stored = await readSetting(db().db, accessMethodsSetting);
  assert.ok(stored !== null);
  assert.equal(JSON.stringify(stored.value).includes(GOOGLE_SECRET), false, "the document never carries a credential");
  assert.equal(JSON.stringify(stored.value).includes(GITHUB_SECRET), false, "the document never carries a credential");
});

integration("disabling the provider removes it again without a restart", async () => {
  await storeAccess(accessDocument());

  assert.deepEqual(await capabilities(), { emailPassword: true, registration: false, socialProviders: [] });
  assert.deepEqual((await authHolder().snapshot()).providers, {});
  assert.equal(await sessionEmail(ownerCookie), ownerEmail);
});

integration("the holder builds once per revision and rebuilds once when the revision changes", async () => {
  await capabilities();
  const warm = authHolder().builds();

  for (let index = 0; index < 3; index += 1) assert.deepEqual((await capabilities()).socialProviders, []);
  assert.equal(authHolder().builds(), warm, "repeated requests at the same revision never rebuild");

  await storeAccess(accessDocument());

  const burst = await Promise.all(Array.from({ length: 4 }, () => capabilities()));
  for (const body of burst) assert.deepEqual(body.socialProviders, []);
  assert.equal(authHolder().builds(), warm + 1, "one revision change rebuilds exactly once");

  await capabilities();
  assert.equal(authHolder().builds(), warm + 1, "the rebuilt instance is reused");
});
