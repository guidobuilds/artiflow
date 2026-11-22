import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier, Pool } from "pg";

import type { AccessMethodsDocument } from "@artiflow/contracts/settings";

import { loadConfig, type AppConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { instanceSecret, instanceSetting } from "../apps/api/src/adapters/postgres/db/settings-schema.ts";
import {
  SettingRevisionConflictError,
  SettingValidationError,
  accessMethodsSetting,
  readSetting,
  writeSetting,
} from "../apps/api/src/settings/store.ts";
import { SecretError, readSecret, secretConfigured } from "../apps/api/src/settings/secrets.ts";
import { providerSecretName, seedAccessMethods } from "../apps/api/src/settings/seed.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_FOLDER = join(PROJECT_ROOT, "drizzle");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const GOOGLE_SECRET = "google-client-secret-8d2f";
const GITHUB_SECRET = "github-client-secret-71ab";
const NOW = new Date("2026-11-20T10:00:00.000Z");

const integration = (name: string, run: () => Promise<void>) => test(name, { timeout: 30_000 }, run);

function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: "development",
    ARTIFLOW_API_HOST: "127.0.0.1",
    ARTIFLOW_API_PORT: "8787",
    ARTIFLOW_PUBLIC_ORIGIN: "http://127.0.0.1:5173",
    ARTIFLOW_DEMO_AUTH: "1",
    ARTIFLOW_AUTH_SECRET: "artiflow-integration-only-not-a-production-secret",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    ARTIFLOW_S3_ENDPOINT: "http://127.0.0.1:9001",
    ARTIFLOW_S3_REGION: "us-east-1",
    ARTIFLOW_S3_BUCKET: "artiflow-integration",
    ARTIFLOW_S3_ACCESS_KEY_ID: "GK0123456789abcdef0123456789",
    ARTIFLOW_S3_SECRET_ACCESS_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ARTIFLOW_S3_FORCE_PATH_STYLE: "1",
  };
}

function configFor(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({ ...baseEnv(), ...overrides });
}

function encryptionKey(): string {
  return randomBytes(32).toString("base64");
}

function document(): AccessMethodsDocument {
  return {
    password: { enabled: true },
    providers: {
      google: { enabled: false, clientId: "", secretName: "" },
      github: { enabled: false, clientId: "", secretName: "" },
    },
    provenance: { source: "environment", at: NOW.toISOString() },
  };
}

let database: Database;
let admin: Pool;
let databaseName: string;

before(async () => {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  assert.equal(LOOPBACK_HOSTS.has(url.hostname), true, "the test database must be a loopback PostgreSQL instance");
  assert.equal(
    decodeURIComponent(url.pathname.replace(/^\//, "")),
    "artiflow",
    "the test database must be the fixture",
  );

  admin = new Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  await admin.query("SELECT 1");
  databaseName = `artiflow_settings_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  const testUrl = new URL(raw);
  testUrl.pathname = `/${databaseName}`;
  database = createDatabase(testUrl.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: MIGRATIONS_FOLDER });
});

after(async () => {
  await database?.close().catch(() => undefined);
  await admin?.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName)).catch(() => undefined);
  await admin?.end().catch(() => undefined);
});

beforeEach(async () => {
  await database.pool.query('truncate table "instanceSetting", "instanceSecret"');
});

integration("reading a setting that was never written returns null", async () => {
  assert.equal(await readSetting(database.db, accessMethodsSetting), null);
});

integration("a document is written under its revision and replaced only at the revision it holds", async () => {
  const created = await writeSetting(database.db, accessMethodsSetting, {
    value: document(),
    expectedRevision: null,
    updatedBy: "administrator-1",
  });
  assert.equal(created.revision, 1);
  assert.equal(created.updatedBy, "administrator-1");

  const stored = await readSetting(database.db, accessMethodsSetting);
  assert.equal(stored?.revision, 1);
  assert.deepEqual(stored?.value, document());

  const changed = document();
  changed.providers.github = { enabled: true, clientId: "github-id", secretName: providerSecretName("github") };
  const updated = await writeSetting(database.db, accessMethodsSetting, {
    value: changed,
    expectedRevision: 1,
    updatedBy: "administrator-2",
  });

  assert.equal(updated.revision, 2);
  const reread = await readSetting(database.db, accessMethodsSetting);
  assert.equal(reread?.revision, 2);
  assert.equal(reread?.updatedBy, "administrator-2");
  assert.equal(reread?.value.providers.github.enabled, true);
});

integration("a stale revision is refused and the stored document is left untouched", async () => {
  await writeSetting(database.db, accessMethodsSetting, { value: document(), expectedRevision: null });
  const changed = document();
  changed.password = { enabled: false };
  await writeSetting(database.db, accessMethodsSetting, { value: changed, expectedRevision: 1 });

  await assert.rejects(
    writeSetting(database.db, accessMethodsSetting, { value: document(), expectedRevision: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof SettingRevisionConflictError);
      assert.equal(error.expectedRevision, 1);
      assert.equal(error.actualRevision, 2);
      return true;
    },
  );

  const stored = await readSetting(database.db, accessMethodsSetting);
  assert.equal(stored?.revision, 2);
  assert.deepEqual(stored?.value, changed);
});

integration("a second create on an existing key is refused", async () => {
  await writeSetting(database.db, accessMethodsSetting, { value: document(), expectedRevision: null });

  await assert.rejects(
    writeSetting(database.db, accessMethodsSetting, { value: document(), expectedRevision: null }),
    (error: unknown) => {
      assert.ok(error instanceof SettingRevisionConflictError);
      assert.equal(error.expectedRevision, null);
      assert.equal(error.actualRevision, 1);
      return true;
    },
  );
});

integration("the writer rejects unknown keys and stores nothing", async () => {
  const topLevel = { ...document(), unknownOption: true };
  await assert.rejects(
    writeSetting(database.db, accessMethodsSetting, { value: topLevel, expectedRevision: null }),
    SettingValidationError,
  );

  const nested = document();
  const provider = { ...nested.providers.google, redirectUri: "https://example.test/callback" };
  await assert.rejects(
    writeSetting(database.db, accessMethodsSetting, {
      value: { ...nested, providers: { ...nested.providers, google: provider } },
      expectedRevision: null,
    }),
    SettingValidationError,
  );

  assert.equal(await readSetting(database.db, accessMethodsSetting), null);
});

integration("the reader tolerates keys a newer application added", async () => {
  const value = {
    ...document(),
    futureOption: { anything: 1 },
    providers: {
      ...document().providers,
      google: { ...document().providers.google, tenantHint: "future" },
    },
  };
  await database.db.insert(instanceSetting).values({ key: accessMethodsSetting.key, value, revision: 4 });

  const stored = await readSetting(database.db, accessMethodsSetting);
  assert.equal(stored?.revision, 4);
  assert.deepEqual(stored?.value, document());
});

integration("the first boot seeds access.methods from a provider pair and encrypts its secret", async () => {
  const env = {
    ARTIFLOW_SECRET_ENCRYPTION_KEY: encryptionKey(),
    ARTIFLOW_AUTH_GOOGLE_CLIENT_ID: "google-client-id",
    ARTIFLOW_AUTH_GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
  };
  const config = configFor(env);

  const result = await seedAccessMethods({ db: database.db, config, env, now: NOW, write: () => undefined });
  assert.equal(result.seeded, true);
  assert.deepEqual(result.warnedVariables, []);

  const stored = await readSetting(database.db, accessMethodsSetting);
  assert.equal(stored?.revision, 1);
  assert.equal(stored?.value.password.enabled, true);
  assert.deepEqual(stored?.value.providers.google, {
    enabled: true,
    clientId: "google-client-id",
    secretName: providerSecretName("google"),
  });
  assert.deepEqual(stored?.value.providers.github, { enabled: false, clientId: "", secretName: "" });
  assert.deepEqual(stored?.value.provenance, { source: "environment", at: NOW.toISOString() });
  assert.equal(JSON.stringify(stored?.value).includes(GOOGLE_SECRET), false, "the document holds only the secret name");

  const secretRows = await database.db.select().from(instanceSecret);
  assert.equal(secretRows.length, 1);
  const row = secretRows[0];
  assert.equal(row?.name, providerSecretName("google"));
  assert.equal(row?.ciphertext.includes(GOOGLE_SECRET), false);
  assert.equal(row?.ciphertext.startsWith("v1:"), true);

  assert.equal(await secretConfigured(database.db, providerSecretName("google")), true);
  assert.equal(await secretConfigured(database.db, providerSecretName("github")), false);
  assert.equal(
    await readSecret(database.db, providerSecretName("google"), config.secretEncryptionKey ?? null),
    GOOGLE_SECRET,
  );
  assert.equal(await readSecret(database.db, providerSecretName("github"), config.secretEncryptionKey ?? null), null);
});

integration("an existing document is never reseeded and one warning names the variables still set", async () => {
  const env = {
    ARTIFLOW_SECRET_ENCRYPTION_KEY: encryptionKey(),
    ARTIFLOW_AUTH_GOOGLE_CLIENT_ID: "google-client-id",
    ARTIFLOW_AUTH_GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
    ARTIFLOW_AUTH_GITHUB_CLIENT_ID: "github-client-id",
    ARTIFLOW_AUTH_GITHUB_CLIENT_SECRET: GITHUB_SECRET,
  };
  const config = configFor(env);
  await seedAccessMethods({ db: database.db, config, env, now: NOW, write: () => undefined });

  const administrable = document();
  administrable.providers.google = {
    enabled: false,
    clientId: "google-client-id",
    secretName: providerSecretName("google"),
  };
  await writeSetting(database.db, accessMethodsSetting, { value: administrable, expectedRevision: 1 });

  const lines: string[] = [];
  const second = await seedAccessMethods({
    db: database.db,
    config,
    env,
    now: new Date("2026-11-21T10:00:00.000Z"),
    write: (line) => lines.push(line),
  });

  assert.equal(second.seeded, false);
  assert.deepEqual(second.warnedVariables, [
    "ARTIFLOW_AUTH_GOOGLE_CLIENT_ID",
    "ARTIFLOW_AUTH_GOOGLE_CLIENT_SECRET",
    "ARTIFLOW_AUTH_GITHUB_CLIENT_ID",
    "ARTIFLOW_AUTH_GITHUB_CLIENT_SECRET",
  ]);
  assert.equal(lines.length, 1);
  const warning = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.equal(warning.level, "warn");
  assert.equal(warning.event, "access.seed.skipped");
  assert.deepEqual(warning.variables, second.warnedVariables);
  for (const value of [GOOGLE_SECRET, GITHUB_SECRET, "google-client-id", "github-client-id"]) {
    assert.equal((lines[0] ?? "").includes(value), false, "the warning never carries a value");
  }

  const stored = await readSetting(database.db, accessMethodsSetting);
  assert.equal(stored?.revision, 2, "the administrator's revision is untouched");
  assert.deepEqual(stored?.value, administrable);
});

integration("configured providers without an encryption key fail closed and store nothing", async () => {
  const env = {
    ARTIFLOW_AUTH_GOOGLE_CLIENT_ID: "google-client-id",
    ARTIFLOW_AUTH_GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
  };
  const config = configFor(env);

  await assert.rejects(
    seedAccessMethods({ db: database.db, config, env, now: NOW, write: () => undefined }),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "key_missing");
      assert.equal(error.message.includes(GOOGLE_SECRET), false);
      return true;
    },
  );

  assert.equal(await readSetting(database.db, accessMethodsSetting), null);
  assert.equal((await database.db.select().from(instanceSecret)).length, 0);
});

integration("an installation with no variables seeds password access and no providers", async () => {
  const result = await seedAccessMethods({
    db: database.db,
    config: configFor(),
    env: {},
    now: NOW,
    write: () => undefined,
  });

  assert.equal(result.seeded, true);
  const stored = await readSetting(database.db, accessMethodsSetting);
  assert.equal(stored?.value.password.enabled, true);
  assert.deepEqual(stored?.value.providers, {
    google: { enabled: false, clientId: "", secretName: "" },
    github: { enabled: false, clientId: "", secretName: "" },
  });
  assert.equal((await database.db.select().from(instanceSecret)).length, 0);
});
