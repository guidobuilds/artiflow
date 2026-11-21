import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
import { account, user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { assertNoSensitiveContent, type AuditLine } from "./helpers/audit.ts";

const baseConfig: AuthConfig = loadConfig(process.env);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_FOLDER = join(PROJECT_ROOT, "drizzle");
const TEST_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const PUBLIC_ORIGIN = "http://127.0.0.1:5399";
const URL_PREFIX = `${PUBLIC_ORIGIN}/reset-password#token=`;
const USAGE_LINE = "usage: bun run user:reset-password EMAIL";
const SIGN_IN_PATH = "/api/auth/sign-in/email";
const MAX_DIAGNOSTIC_CHARS = 600;
const MAX_DIAGNOSTIC_LINES = 4;
const cli = (name: string, fn: () => void | Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

function bunBinary(): string {
  const explicit = process.env.ARTIFLOW_TEST_BUN?.trim();
  const found = [explicit, join("/toolchain", "bun")].find(
    (candidate): candidate is string => candidate !== undefined && candidate !== "" && existsSync(candidate),
  );
  return found ?? "bun";
}

const BUN_BIN = bunBinary();
const BUN_DIR = dirname(BUN_BIN);
const CHILD_PATH = [BUN_DIR === "." ? "" : BUN_DIR, process.env.PATH ?? ""].filter((part) => part !== "").join(":");

let adminPool: Pool | null = null;
let database: Database | null = null;
let testDatabaseName = "";
let testDatabaseCreated = false;
let testDatabaseUrl = "";
let authServer: ReturnType<typeof serve> | null = null;
let authBaseUrl = "";

type CliResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function db(): Database {
  assert.ok(database);
  return database;
}

function runReset(args: string[], env: Record<string, string> = {}): CliResult {
  const result = spawnSync(BUN_BIN, ["run", "--silent", "user:reset-password", ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: CHILD_PATH,
      DATABASE_URL: testDatabaseUrl,
      ARTIFLOW_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      ...env,
    },
  });
  assert.equal(result.error, undefined, `the command must start: ${String(result.error)}`);
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertNoResetUrl(output: string): void {
  assert.equal(output.includes("#token="), false, "no token may appear in this output");
  assert.equal(output.includes("/reset-password"), false, "no reset URL may appear in this output");
}

function assertBoundedFailure(result: CliResult): void {
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim().length > 0, true, "a failure explains itself on stderr");
  assert.equal(
    result.stderr.split("\n").some((line) => line.startsWith("{")),
    false,
    "a refusal records no audit line",
  );
  assert.equal(result.stderr.length <= MAX_DIAGNOSTIC_CHARS, true, "diagnostics stay bounded");
  assert.equal(result.stderr.trimEnd().split("\n").length <= MAX_DIAGNOSTIC_LINES, true, "diagnostics stay bounded");
  assert.equal(/^\s+at\s/m.test(result.stderr), false, "no stack trace");
  assertNoResetUrl(result.stderr);
  assert.equal(/postgres(ql)?:\/\//.test(result.stderr), false, "never echo the connection string");
}

function assertSingleResetUrl(line: string): string {
  assert.equal(line.startsWith(URL_PREFIX), true, `URL must use the configured public origin: ${line}`);
  const token = line.slice(URL_PREFIX.length);
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(token), true, "the token is 32 random bytes as base64url");
  assert.equal(Buffer.from(token, "base64url").length, 32);
  return token;
}

function consoleAuditLine(result: CliResult): AuditLine {
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr.endsWith("\n"), true, "the audit line is newline-terminated");
  const lines = result.stderr.split("\n");
  assert.equal(lines.length, 2, "stderr carries exactly one audit line");
  const raw = lines[0] ?? "";
  assert.equal(raw.startsWith("{"), true, `the audit record is one JSON line: ${raw}`);
  return JSON.parse(raw) as AuditLine;
}

function assertIssuanceRecorded(result: CliResult): AuditLine {
  const line = consoleAuditLine(result);
  assert.equal(line.event, "password.reset.issued", "the record names the operation");
  assert.equal(line.actorId, "console", "the record names the console as the actor");
  assert.equal(line.actorRole, "console", "the record names the console role");
  assert.equal(line.outcome, "applied", "the record names the outcome");
  assert.equal(typeof line.ts, "string", "the record carries a timestamp");
  assert.equal(typeof line.subjectId === "string" && line.subjectId !== "", true, "the record names the account");
  assert.equal("email" in line || "address" in line, false, "the record carries no address field");
  assertNoSensitiveContent([line], []);
  assertNoResetUrl(result.stderr);
  return line;
}

function assertSingleUrlOutput(result: CliResult): { token: string; audit: AuditLine } {
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.endsWith("\n"), true, "stdout is one newline-terminated line");
  const lines = result.stdout.split("\n");
  assert.equal(lines.length, 2, "stdout carries exactly the URL line");
  const line = lines[0] ?? "";
  assert.equal(/\s/.test(line), false, "the URL line has no stray whitespace");
  const token = assertSingleResetUrl(line);
  const audit = assertIssuanceRecorded(result);
  assert.equal(result.stderr.includes(token), false, "the audit record carries no token");
  return { token, audit };
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

async function seedCredentialUser(email: string, password: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db()
    .db.insert(user)
    .values({ id, name: "Reset Test Owner", email, emailVerified: false, createdAt: now, updatedAt: now });
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

type StoredToken = { tokenHash: string; expiresAt: Date; createdAt: Date };

async function storedTokens(userId: string): Promise<StoredToken[]> {
  const result = await db().pool.query<StoredToken>(
    'SELECT "tokenHash", "expiresAt", "createdAt" FROM "passwordResetToken" WHERE "userId" = $1 ORDER BY "createdAt"',
    [userId],
  );
  return result.rows;
}

async function providerIds(userId: string): Promise<string[]> {
  const result = await db().pool.query<{ providerId: string }>(
    'SELECT "providerId" FROM "account" WHERE "userId" = $1 ORDER BY "providerId"',
    [userId],
  );
  return result.rows.map((row) => row.providerId);
}

before(async () => {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  assert.equal(url.protocol === "postgres:" || url.protocol === "postgresql:", true);
  assert.equal(LOOPBACK_HOSTS.has(url.hostname), true);
  assert.equal(decodeURIComponent(url.pathname.replace(/^\//, "")) === "artiflow", true);

  adminPool = new Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  await adminPool.query("SELECT 1");
  testDatabaseName = `artiflow_reset_cli_test_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query("CREATE DATABASE " + escapeIdentifier(testDatabaseName));
  testDatabaseCreated = true;

  const testUrl = new URL(raw);
  testUrl.pathname = `/${testDatabaseName}`;
  testDatabaseUrl = testUrl.toString();
  database = createDatabase(testDatabaseUrl);
  await migrate(drizzle(database.pool), { migrationsFolder: MIGRATIONS_FOLDER });

  const app = new Hono();
  app.route("/", createAuthApp(createAuth(baseConfig, database), baseConfig));
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

cli("--help documents the single EMAIL argument and prints no usable URL", () => {
  const result = runReset(["--help"]);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(USAGE_LINE), true);
  assert.equal(result.stdout.includes(PUBLIC_ORIGIN), false, "help never prints a usable link");
  assert.equal(/token=[A-Za-z0-9_-]{43}/.test(result.stdout), false);
});

cli("exactly one EMAIL argument: zero, extra and --force are refused", () => {
  const email = `arity-${randomUUID()}@example.test`;
  const cases: string[][] = [[], [email, `extra-${randomUUID()}@example.test`], [email, "--force"]];
  for (const args of cases) {
    const result = runReset(args);
    assertBoundedFailure(result);
    assert.equal(
      result.stderr.includes(USAGE_LINE),
      true,
      `usage is printed for ${JSON.stringify(args)}: ${result.stderr}`,
    );
  }
});

cli("a malformed email is refused instead of producing a link", () => {
  for (const value of ["not-an-email", "alice@", "@example.test", `two words ${randomUUID()}@example.test`]) {
    const result = runReset([value]);
    assertBoundedFailure(result);
    assert.equal(/not a valid email address/i.test(result.stderr), true, `refusal for ${JSON.stringify(value)}`);
  }
});

cli("an existing account gets the URL on stdout and one audit line on stderr", async () => {
  const email = `owner-${randomUUID()}@example.test`;
  const ownerId = await seedCredentialUser(email, `owner-password-${randomUUID()}`);

  const result = runReset([email]);
  const { token, audit } = assertSingleUrlOutput(result);
  assert.equal(result.stdout.includes(email), false, "the URL carries no email");
  assert.equal(result.stdout.includes(sha256Hex(token)), false, "the URL never carries the stored digest");
  assert.equal(audit.subjectId, ownerId, "the record names the account the link was issued for");
  assert.equal(result.stderr.includes(email), false, "the audit record carries no address");
  assert.equal(result.stderr.includes(sha256Hex(token)), false, "the audit record carries no stored digest");

  const stored = await storedTokens(ownerId);
  assert.equal(stored.length, 1, "exactly one link is pending");
  assert.equal(stored[0]?.tokenHash, sha256Hex(token), "only the digest of the printed token is stored");
  assert.equal(/^[0-9a-f]{64}$/.test(stored[0]?.tokenHash ?? ""), true, "the stored digest is lowercase hex");
  const lifetimeSeconds = ((stored[0]?.expiresAt.getTime() ?? 0) - (stored[0]?.createdAt.getTime() ?? 0)) / 1000;
  assert.equal(lifetimeSeconds > 3500 && lifetimeSeconds < 3700, true, `the link lives one hour: ${lifetimeSeconds}s`);
});

cli("a nonexistent account is refused clearly and nothing is written", async () => {
  const before = await db().pool.query<{ count: string }>('SELECT count(*)::text AS count FROM "passwordResetToken"');
  const missing = `nobody-${randomUUID()}@example.test`;

  const result = runReset([missing]);
  assertBoundedFailure(result);
  assert.equal(/no account/i.test(result.stderr), true, `the refusal names the reason: ${result.stderr}`);
  assert.equal(result.stderr.includes(missing), false, "the refusal never echoes the address");

  const rows = await db().pool.query<{ count: string }>('SELECT count(*)::text AS count FROM "passwordResetToken"');
  assert.equal(rows.rows[0]?.count, before.rows[0]?.count, "a refused request writes no token");
});

cli("a padded, mixed-case address matches the one canonical account", async () => {
  const local = `canonical-${randomUUID()}`;
  const email = `${local}@example.test`;
  const ownerId = await seedCredentialUser(email, `canonical-password-${randomUUID()}`);

  const token = assertSingleUrlOutput(runReset([`  ${local.toUpperCase()}@Example.TEST  `])).token;
  const stored = await storedTokens(ownerId);
  assert.equal(stored.length, 1, "the canonical account owns the single pending link");
  assert.equal(stored[0]?.tokenHash, sha256Hex(token));
});

cli("a second link invalidates the previous pending link of that account", async () => {
  const email = `rotate-${randomUUID()}@example.test`;
  const ownerId = await seedCredentialUser(email, `rotate-password-${randomUUID()}`);

  const first = assertSingleUrlOutput(runReset([email])).token;
  const second = assertSingleUrlOutput(runReset([email.toUpperCase()])).token;
  assert.notEqual(first, second);

  const stored = await storedTokens(ownerId);
  assert.equal(stored.length, 1, "the previous pending link is deleted, not carried");
  assert.equal(stored[0]?.tokenHash, sha256Hex(second));
  assert.equal(stored[0]?.tokenHash === sha256Hex(first), false);
});

cli("the command never changes a password or creates an account", async () => {
  const email = `untouched-${randomUUID()}@example.test`;
  const password = `untouched-password-${randomUUID()}`;
  const ownerId = await seedCredentialUser(email, password);

  assertSingleUrlOutput(runReset([email]));

  const signInResponse = await signIn(email, password);
  assert.equal(signInResponse.status, 200, "the existing password still signs in");
  assert.deepEqual(await providerIds(ownerId), ["credential"], "no extra credential row was created");
});

cli("a database failure exits non-zero without leaking connection details", () => {
  const secret = `reset-cli-${randomUUID()}`;
  const result = runReset([`unreachable-${randomUUID()}@example.test`], {
    DATABASE_URL: `postgres://artiflow_test:${secret}@127.0.0.1:1/artiflow`,
  });
  assertBoundedFailure(result);
  assert.equal(/database/i.test(result.stderr), true);
  assert.equal(result.stderr.includes(secret), false);
});
