import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const TEST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const PUBLIC_ORIGIN = "http://127.0.0.1:5399";
const URL_PREFIX = `${PUBLIC_ORIGIN}/register#token=`;
const USAGE_LINE = "usage: bun run user:invite EMAIL";
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

function runInvite(args: string[], env: Record<string, string> = {}): CliResult {
  const result = spawnSync(BUN_BIN, ["run", "--silent", "user:invite", ...args], {
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

function assertNoInvitationUrl(output: string): void {
  assert.equal(output.includes("#token="), false, "no token may appear in this output");
  assert.equal(output.includes("/register"), false, "no registration URL may appear in this output");
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
  assertNoInvitationUrl(result.stderr);
  assert.equal(/postgres(ql)?:\/\//.test(result.stderr), false, "never echo the connection string");
}

function assertSingleUseUrl(line: string): string {
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
  assert.equal(line.event, "invitation.created", "the record names the operation");
  assert.equal(line.actorId, "console", "the record names the console as the actor");
  assert.equal(line.actorRole, "console", "the record names the console role");
  assert.equal(line.outcome, "applied", "the record names the outcome");
  assert.equal(typeof line.ts, "string", "the record carries a timestamp");
  assert.equal(typeof line.subjectId === "string" && line.subjectId !== "", true, "the record names the invitation");
  assert.equal("email" in line || "address" in line, false, "the record carries no address field");
  assertNoSensitiveContent([line], []);
  assertNoInvitationUrl(result.stderr);
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
  const token = assertSingleUseUrl(line);
  const audit = assertIssuanceRecorded(result);
  assert.equal(result.stderr.includes(token), false, "the audit record carries no token");
  return { token, audit };
}

function request(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function post(path: string, body: unknown): Promise<Response> {
  return request(`${authBaseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseConfig.publicOrigin },
    body: JSON.stringify(body),
  });
}

async function seedCredentialUser(email: string, password: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db()
    .db.insert(user)
    .values({ id, name: "Invite Test Owner", email, emailVerified: false, createdAt: now, updatedAt: now });
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
  assert.equal(decodeURIComponent(url.pathname.replace(/^\//, "")) === "artiflow", true);

  adminPool = new Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  await adminPool.query("SELECT 1");
  testDatabaseName = `artiflow_invite_cli_test_${randomUUID().replaceAll("-", "")}`;
  assert.equal(/^artiflow_invite_cli_test_[0-9a-f]{32}$/.test(testDatabaseName), true);
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
  const result = runInvite(["--help"]);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(USAGE_LINE), true);
  assert.equal(result.stdout.includes(PUBLIC_ORIGIN), false, "help never prints a usable invitation");
  assert.equal(/token=[A-Za-z0-9_-]{43}/.test(result.stdout), false);
});

cli("exactly one EMAIL argument: zero, extra and --force are refused", () => {
  const email = `arity-${randomUUID()}@example.test`;
  const cases: string[][] = [[], [email, `extra-${randomUUID()}@example.test`], [email, "--force"]];
  for (const args of cases) {
    const result = runInvite(args);
    assertBoundedFailure(result);
    assert.equal(
      result.stderr.includes(USAGE_LINE),
      true,
      `usage is printed for ${JSON.stringify(args)}: ${result.stderr}`,
    );
  }
});

cli("a malformed email is refused instead of producing an invitation", () => {
  for (const value of ["not-an-email", "alice@", "@example.test", `two words ${randomUUID()}@example.test`]) {
    const result = runInvite([value]);
    assertBoundedFailure(result);
    assert.equal(/not a valid email address/i.test(result.stderr), true, `refusal for ${JSON.stringify(value)}`);
  }
});

cli("a successful invitation prints the URL on stdout and one audit line on stderr", async () => {
  const email = `invite-${randomUUID()}@example.test`;
  const result = runInvite([email]);
  const { token, audit } = assertSingleUrlOutput(result);
  const line = result.stdout.trimEnd();
  assert.equal(line.includes(email), false, "the URL carries no email");
  assert.equal(line.includes("@"), false, "the URL carries no address");
  assert.equal(result.stderr.includes(email), false, "the audit record carries no address");
  assert.equal(result.stderr.includes(token), false, "the audit record carries no token");

  const stored = await db().pool.query<{ id: string }>(
    'SELECT "id" FROM "registrationInvite" WHERE "email" = $1 AND "consumedAt" IS NULL',
    [email],
  );
  assert.equal(stored.rows.length, 1, "the invitation is pending");
  assert.equal(audit.subjectId, stored.rows[0]?.id, "the record names the invitation it issued");
});

cli("two invitations produce two distinct single-use URLs", () => {
  const first = runInvite([`entropy-a-${randomUUID()}@example.test`]);
  const second = runInvite([`entropy-b-${randomUUID()}@example.test`]);
  const firstToken = assertSingleUrlOutput(first).token;
  const secondToken = assertSingleUrlOutput(second).token;
  assert.notEqual(firstToken, secondToken);
  assert.notEqual(first.stdout, second.stdout);
});

cli("a padded, mixed-case address is accepted as one canonical email", () => {
  const local = `canonical-${randomUUID()}`;
  const result = runInvite([`  ${local.toUpperCase()}@Example.TEST  `]);
  assertSingleUrlOutput(result);
});

cli("an existing account is refused and keeps its credentials", async () => {
  const email = `owner-${randomUUID()}@example.test`;
  const password = `existing-password-${randomUUID()}`;
  const ownerId = await seedCredentialUser(email, password);

  const refusal = runInvite([email]);
  assertBoundedFailure(refusal);
  assert.equal(/already exists/i.test(refusal.stderr), true);

  assertBoundedFailure(runInvite([email.toUpperCase()]));

  const response = await post("/api/auth/sign-in/email", { email, password });
  assert.equal(response.status, 200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .find((value) => value.includes("session_token"));
  assert.equal(typeof cookie === "string" && cookie.length > 0, true);

  const session = await request(`${authBaseUrl}/api/auth/get-session`, { headers: { cookie: cookie as string } });
  assert.equal(session.status, 200);
  const payload = (await session.json()) as { user?: { id?: string; email?: string } } | null;
  assert.equal(payload?.user?.id, ownerId);
  assert.equal(payload?.user?.email, email);
});

cli("a database failure exits non-zero without leaking connection details", () => {
  const secret = `invite-cli-${randomUUID()}`;
  const result = runInvite([`unreachable-${randomUUID()}@example.test`], {
    DATABASE_URL: `postgres://artiflow_test:${secret}@127.0.0.1:1/artiflow`,
  });
  assertBoundedFailure(result);
  assert.equal(/database/i.test(result.stderr), true);
  assert.equal(result.stderr.includes(secret), false);
});
