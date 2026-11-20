import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier, Pool } from "pg";

import { createApiApp, type ApiAppDeps } from "../../apps/api/src/app.ts";
import { createDatabase, type Database } from "../../apps/api/src/adapters/postgres/db/client.ts";
import type { AppConfig } from "../../apps/api/src/config.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS_FOLDER = join(PROJECT_ROOT, "drizzle");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const REQUEST_TIMEOUT_MS = 10_000;

export type CommandResult = { status: number | null; stdout: string; stderr: string };

export type AdminHarness = {
  baseUrl: string;
  config: AppConfig;
  database: Database;
  command(script: string, args: string[]): CommandResult;
  close(): Promise<void>;
};

function bunBinary(): string {
  const explicit = process.env.ARTIFLOW_TEST_BUN?.trim();
  const found = [explicit, join("/toolchain", "bun")].find(
    (candidate): candidate is string => candidate !== undefined && candidate !== "" && existsSync(candidate),
  );
  return found ?? "bun";
}

function unusedStorage(): ApiAppDeps["storage"] {
  return {
    client: {} as ApiAppDeps["storage"]["client"],
    bucket: "unused-by-administration-routes",
    checkBucket: async () => undefined,
    destroy: () => undefined,
  };
}

export async function startAdminHarness(config: AppConfig): Promise<AdminHarness> {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error("the test database must be a loopback PostgreSQL instance");
  if (decodeURIComponent(url.pathname.replace(/^\//, "")) !== "artiflow") {
    throw new Error("the test database must be the artiflow fixture database");
  }

  const admin = new Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  await admin.query("SELECT 1");
  const name = `artiflow_admin_http_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query("CREATE DATABASE " + escapeIdentifier(name));

  const testUrl = new URL(raw);
  testUrl.pathname = `/${name}`;
  const database = createDatabase(testUrl.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: MIGRATIONS_FOLDER });

  const app = createApiApp({ config, database, storage: unusedStorage() });

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
    command(script, args) {
      const result = spawnSync(bun, ["run", "--silent", script, ...args], {
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
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

export function adminRequest(target: AdminHarness, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${target.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

export function adminGet(target: AdminHarness, path: string, cookie: string): Promise<Response> {
  return adminRequest(target, path, { method: "GET", headers: { cookie } });
}

export function adminPost(target: AdminHarness, path: string, body: unknown, cookie: string): Promise<Response> {
  return adminRequest(target, path, {
    method: "POST",
    headers: { cookie, origin: target.config.publicOrigin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function assertStatus(response: Response, expected: number, detail: string): void {
  assert.equal(response.status, expected, detail);
}
