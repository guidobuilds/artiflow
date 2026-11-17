import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";

import { createDatabase, type Database } from "../../apps/api/src/adapters/postgres/db/client.ts";
import { createAuth, createAuthApp, type AuthConfig } from "../../apps/api/src/auth.ts";
import { issuePasswordReset } from "../../apps/api/src/password-reset/service.ts";
import { seedTrustedAccount } from "./trusted-accounts.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS_FOLDER = join(PROJECT_ROOT, "drizzle");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TOKEN_MARKER = "#token=";
const SIGN_IN_PATH = "/api/auth/sign-in/email";
const SESSION_PATH = "/api/auth/get-session";
const REQUEST_TIMEOUT_MS = 10_000;

export const PREVIEW_PATH = "/api/auth/registration/preview";
export const COMPLETE_PATH = "/api/auth/registration/complete";
export const RESET_PREVIEW_PATH = "/api/auth/password-reset/preview";
export const RESET_COMPLETE_PATH = "/api/auth/password-reset/complete";

export type IssuedInvitation = { email: string; token: string; url: string };
export type Credential = { name: string; password: string };
export type SessionUser = { email?: string; name?: string; emailVerified?: boolean };

export type InvitationHarness = {
  baseUrl: string;
  config: AuthConfig;
  database: Database;
  issue(rawEmail: string): IssuedInvitation;
  expire(email: string): Promise<void>;
  close(): Promise<void>;
};

function bunBinary(): string {
  const explicit = process.env.ARTIFLOW_TEST_BUN?.trim();
  const found = [explicit, join("/toolchain", "bun")].find(
    (candidate): candidate is string => candidate !== undefined && candidate !== "" && existsSync(candidate),
  );
  return found ?? "bun";
}

export type InvitationHarnessOptions = { migrationsFolder?: string };

export async function startInvitationHarness(
  config: AuthConfig,
  options: InvitationHarnessOptions = {},
): Promise<InvitationHarness> {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error("the test database must be a loopback PostgreSQL instance");
  if (decodeURIComponent(url.pathname.replace(/^\//, "")) !== "artiflow") {
    throw new Error("the test database must be the artiflow fixture database");
  }

  const admin = new Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  await admin.query("SELECT 1");
  const name = `artiflow_invite_http_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query("CREATE DATABASE " + escapeIdentifier(name));

  const testUrl = new URL(raw);
  testUrl.pathname = `/${name}`;
  const database = createDatabase(testUrl.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER });

  const app = new Hono();
  app.route("/", createAuthApp(createAuth(config, database), config));
  const started = await new Promise<{ server: ReturnType<typeof serve>; baseUrl: string }>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
      resolve({ server, baseUrl: `http://127.0.0.1:${info.port}` }),
    );
    server.once("error", reject);
  });

  const bun = bunBinary();
  const childPath = [dirname(bun) === "." ? "" : dirname(bun), process.env.PATH ?? ""]
    .filter((part) => part !== "")
    .join(":");

  return {
    baseUrl: started.baseUrl,
    config,
    database,
    issue(rawEmail) {
      const email = rawEmail.trim().toLowerCase();
      const result = spawnSync(bun, ["run", "--silent", "user:invite", rawEmail], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: childPath,
          DATABASE_URL: testUrl.toString(),
          ARTIFLOW_PUBLIC_ORIGIN: config.publicOrigin,
        },
      });
      if (result.status !== 0) throw new Error(`user:invite failed: ${result.stderr ?? ""}`);
      const url = (result.stdout ?? "").trimEnd();
      const marker = url.indexOf(TOKEN_MARKER);
      if (marker < 0) throw new Error("user:invite printed no invitation URL");
      return { email, token: url.slice(marker + TOKEN_MARKER.length), url };
    },
    async expire(email) {
      await database.pool.query(
        `UPDATE "registrationInvite" SET "expiresAt" = now() - interval '1 minute' WHERE "email" = $1`,
        [email],
      );
    },
    async close() {
      (started.server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve, reject) =>
        started.server.close((error) => (error ? reject(error) : resolve())),
      );
      await database.close().catch(() => undefined);
      await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(name)).catch(() => undefined);
      await admin.end().catch(() => undefined);
    },
  };
}

export function invitationCredential(name = "Invited Person"): Credential {
  return { name, password: `invited-password-${randomUUID()}` };
}

export function inviteRequest(
  target: InvitationHarness,
  path: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(`${target.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

export function invitePost(
  target: InvitationHarness,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return inviteRequest(target, path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: target.config.publicOrigin, ...headers },
    body: JSON.stringify(body),
  });
}

export function inviteGet(target: InvitationHarness, path: string): Promise<Response> {
  return inviteRequest(target, path, { method: "GET" });
}

export function sessionCookie(response: Response): string {
  return (
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.includes("session_token")) ?? ""
  );
}

export function assertNoSession(response: Response): void {
  assert.equal(
    response.headers.getSetCookie().some((value) => value.includes("session_token")),
    false,
    "no session may be issued",
  );
}

export function assertNoLeak(text: string, secrets: string[]): void {
  for (const secret of secrets) assert.equal(text.includes(secret), false, "response echoes a secret");
  assert.equal(/"stack"|^\s+at\s/m.test(text), false, "response carries an internal stack");
}

export function signInEmail(target: InvitationHarness, email: string, password: string): Promise<Response> {
  return invitePost(target, SIGN_IN_PATH, { email, password });
}

export async function sessionUser(target: InvitationHarness, response: Response): Promise<SessionUser | null> {
  const cookie = sessionCookie(response);
  assert.equal(cookie.length > 0, true, "a successful sign-in sets a session cookie");
  const lookup = await inviteRequest(target, SESSION_PATH, { headers: { cookie } });
  assert.equal(lookup.status, 200);
  const payload = (await lookup.json()) as { user?: SessionUser } | null;
  return payload?.user ?? null;
}

export async function issueResetToken(target: InvitationHarness, rawEmail: string): Promise<string> {
  const issued = await issuePasswordReset(target.database.db, rawEmail);
  if (issued.kind !== "issued") throw new Error("a reset link is issued only for an existing account");
  return issued.token;
}

export async function expireResetToken(target: InvitationHarness, userId: string): Promise<void> {
  await target.database.pool.query(
    `UPDATE "passwordResetToken" SET "expiresAt" = now() - interval '1 minute'
     WHERE "userId" = $1 AND "consumedAt" IS NULL`,
    [userId],
  );
}

export async function seedCredentialUser(
  target: InvitationHarness,
  email: string,
  password: string,
): Promise<void> {
  await seedTrustedAccount(target.database, { email, password, name: "Existing Owner" });
}
