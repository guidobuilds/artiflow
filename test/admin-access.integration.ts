import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { loadConfig, type AppConfig } from "../apps/api/src/config.ts";
import { instanceSecret } from "../apps/api/src/adapters/postgres/db/settings-schema.ts";
import { decodeSecretKey } from "../apps/api/src/settings/secrets.ts";
import { providerSecretName } from "../apps/api/src/settings/seed.ts";
import { accessMethodsSetting, readSetting } from "../apps/api/src/settings/store.ts";
import { trustedSession, type TrustedFixture, type TrustedSession } from "./helpers/trusted-accounts.ts";
import {
  adminGet,
  adminRequest,
  assertStatus,
  startAdminHarness,
  type AdminHarness,
} from "./helpers/admin-harness.ts";

const TEST_TIMEOUT_MS = 20_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

const ACCESS_PATH = "/api/admin/access";
const CAPABILITIES_PATH = "/api/auth/capabilities";
const GITHUB_CLIENT_ID = `github-client-id-${randomUUID()}`;
const GITHUB_SECRET = `github-client-secret-${randomUUID()}`;
const GOOGLE_CLIENT_ID = `google-client-id-${randomUUID()}`;
const GOOGLE_SECRET = `google-client-secret-${randomUUID()}`;
const KEY = decodeSecretKey(randomBytes(32).toString("base64"));

type ProviderView = { enabled: boolean; clientId: string; credentialConfigured: boolean };
type RegistrationView = { origin: string; redirectUris: { google: string; github: string } };
type AccessView = {
  revision: number | null;
  passwordEnabled: boolean;
  providers: { google: ProviderView; github: ProviderView };
  registration: RegistrationView;
  provenance: { source: string; at: string };
};

let harness: AdminHarness | null = null;
let fixture: TrustedFixture | null = null;
let administrator: TrustedSession | null = null;
let member: TrustedSession | null = null;

function target(): AdminHarness {
  assert.ok(harness, "the harness started");
  return harness;
}

function fixtureOf(): TrustedFixture {
  assert.ok(fixture, "the fixture started");
  return fixture;
}

function actor(session: TrustedSession | null): TrustedSession {
  assert.ok(session, "the account exists");
  return session;
}

function config(): AppConfig {
  assert.ok(harness, "the harness started");
  return harness.config;
}

function expectedRegistration(): RegistrationView {
  const origin = config().publicOrigin;
  return {
    origin,
    redirectUris: {
      google: `${origin}/api/auth/callback/google`,
      github: `${origin}/api/auth/callback/github`,
    },
  };
}

function accessPut(body: unknown, cookie: string): Promise<Response> {
  return adminRequest(target(), ACCESS_PATH, {
    method: "PUT",
    headers: { cookie, origin: config().publicOrigin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function capabilities(): Promise<{ emailPassword: boolean; registration: boolean; socialProviders: string[] }> {
  const response = await adminRequest(target(), CAPABILITIES_PATH, { method: "GET" });
  assertStatus(response, 200, "the capabilities endpoint answers");
  return (await response.json()) as { emailPassword: boolean; registration: boolean; socialProviders: string[] };
}

async function storedRevision(): Promise<number | null> {
  const stored = await readSetting(target().database.db, accessMethodsSetting);
  return stored?.revision ?? null;
}

async function storedDocument(): Promise<string> {
  const stored = await readSetting(target().database.db, accessMethodsSetting);
  return JSON.stringify(stored?.value ?? null);
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (value === null || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  for (const [key, item] of Object.entries(value)) {
    keys.push(key);
    collectKeys(item, keys);
  }
  return keys;
}

function assertNoCredentialMaterial(payload: string, detail: string): void {
  for (const secret of [GITHUB_SECRET, GOOGLE_SECRET]) {
    assert.equal(payload.includes(secret), false, `${detail}: a credential never reaches the payload`);
  }
  assert.equal(payload.includes("v1:"), false, `${detail}: no ciphertext envelope reaches the payload`);
  const keys = collectKeys(JSON.parse(payload));
  for (const forbidden of ["clientSecret", "secretName", "ciphertext", "credential"]) {
    assert.equal(keys.includes(forbidden), false, `${detail}: the payload carries no ${forbidden} field`);
  }
}

type Captured<T> = { result: T; lines: Record<string, unknown>[] };

async function withAuditCapture<T>(run: () => Promise<T>): Promise<Captured<T>> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    const result = await run();
    const lines = written
      .flatMap((line) => line.split("\n"))
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .filter((line) => line.event === "access.methods.updated");
    return { result, lines };
  } finally {
    process.stdout.write = original;
  }
}

before(async () => {
  const base = loadConfig(process.env);
  harness = await startAdminHarness({ ...base, secretEncryptionKey: KEY });
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
  administrator = await trustedSession(fixtureOf(), { role: "administrator", name: "Access Administrator" });
  member = await trustedSession(fixtureOf(), { name: "Ordinary Member" });
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("a member can neither read nor change the access configuration", async () => {
  const read = await adminGet(target(), ACCESS_PATH, actor(member).cookie);
  assertStatus(read, 403, "reading the access configuration is an administration action");
  assert.deepEqual(await read.json(), { error: "administrator_required" });

  const write = await accessPut(
    {
      revision: null,
      passwordEnabled: false,
      providers: {
        google: { enabled: false, clientId: "" },
        github: { enabled: false, clientId: "" },
      },
    },
    actor(member).cookie,
  );
  assertStatus(write, 403, "changing the access configuration is an administration action");
  assert.deepEqual(await write.json(), { error: "administrator_required" });

  assert.equal(await storedRevision(), null);
});

integration("an administrator reads the environment-adopted state before anything is stored", async () => {
  const response = await adminGet(target(), ACCESS_PATH, actor(administrator).cookie);
  assertStatus(response, 200, "an administrator reads the access configuration");
  const payload = await response.text();
  assertNoCredentialMaterial(payload, "the environment-adopted configuration");
  const body = JSON.parse(payload) as AccessView;
  assert.deepEqual(body, {
    revision: null,
    passwordEnabled: true,
    providers: {
      google: { enabled: false, clientId: "", credentialConfigured: false },
      github: { enabled: false, clientId: "", credentialConfigured: false },
    },
    registration: expectedRegistration(),
    provenance: { source: "environment", at: body.provenance.at },
  });
  assert.equal(Number.isNaN(Date.parse(body.provenance.at)), false, "the provenance carries the adoption time");
});

integration("a refused change leaves the stored document untouched and records no event", async () => {
  const missingClientId = await withAuditCapture(() =>
    accessPut(
      {
        revision: null,
        passwordEnabled: true,
        providers: {
          google: { enabled: true, clientId: "   ", clientSecret: GOOGLE_SECRET },
          github: { enabled: false, clientId: "" },
        },
      },
      actor(administrator).cookie,
    ),
  );
  assertStatus(missingClientId.result, 400, "a provider enabled without a client id is refused");
  assert.deepEqual(await missingClientId.result.json(), { error: "provider_client_id_required" });
  assert.deepEqual(missingClientId.lines, [], "a refused change records nothing");

  const missingCredential = await withAuditCapture(() =>
    accessPut(
      {
        revision: null,
        passwordEnabled: true,
        providers: {
          google: { enabled: true, clientId: GOOGLE_CLIENT_ID },
          github: { enabled: false, clientId: "" },
        },
      },
      actor(administrator).cookie,
    ),
  );
  assertStatus(missingCredential.result, 400, "a provider enabled without any credential is refused");
  assert.deepEqual(await missingCredential.result.json(), { error: "provider_credential_required" });
  assert.deepEqual(missingCredential.lines, [], "a refused change records nothing");

  assert.equal(await storedRevision(), null, "a refused change writes no document");
  const secrets = await target().database.db
    .select({ name: instanceSecret.name })
    .from(instanceSecret)
    .where(eq(instanceSecret.name, providerSecretName("google")));
  assert.deepEqual(secrets, [], "a refused change stores no credential");
});

integration("enabling a provider with a credential changes behaviour on the next request without a restart", async () => {
  assert.deepEqual(await capabilities(), { emailPassword: true, registration: false, socialProviders: [] });

  const { result: response, lines } = await withAuditCapture(() =>
    accessPut(
      {
        revision: null,
        passwordEnabled: true,
        providers: {
          google: { enabled: false, clientId: "" },
          github: { enabled: true, clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_SECRET },
        },
      },
      actor(administrator).cookie,
    ),
  );
  assertStatus(response, 200, "an administrator enables a provider");
  const payload = await response.text();
  assertNoCredentialMaterial(payload, "the change response");
  const body = JSON.parse(payload) as AccessView;
  assert.equal(body.revision, 1);
  assert.deepEqual(body.providers.github, {
    enabled: true,
    clientId: GITHUB_CLIENT_ID,
    credentialConfigured: true,
  });
  assert.deepEqual(body.providers.google, { enabled: false, clientId: "", credentialConfigured: false });
  assert.equal(body.passwordEnabled, true);
  assert.equal(body.provenance.source, "administrator");

  assert.equal(lines.length, 1, "the applied change records exactly one event");
  assert.equal(lines[0]?.actorId, actor(administrator).userId);
  assert.equal(lines[0]?.actorRole, "administrator");
  assert.equal(lines[0]?.settingKey, "access.methods");
  assert.equal(lines[0]?.outcome, "applied");
  assert.equal(JSON.stringify(lines[0]).includes(GITHUB_SECRET), false, "the event carries no credential");

  assert.deepEqual(await capabilities(), {
    emailPassword: true,
    registration: false,
    socialProviders: ["github"],
  });

  const reread = await adminGet(target(), ACCESS_PATH, actor(administrator).cookie);
  assertStatus(reread, 200, "the refreshed configuration is readable");
  const rereadPayload = await reread.text();
  assertNoCredentialMaterial(rereadPayload, "the stored configuration");
  assert.deepEqual(JSON.parse(rereadPayload), body);

  const stored = await storedDocument();
  assert.equal(stored.includes(GITHUB_SECRET), false, "the document never carries a credential");
  const secretRows = await target().database.db
    .select({ ciphertext: instanceSecret.ciphertext })
    .from(instanceSecret)
    .where(eq(instanceSecret.name, providerSecretName("github")));
  assert.equal(secretRows.length, 1, "the supplied credential is stored once");
  const ciphertext = secretRows[0]?.ciphertext ?? "";
  assert.equal(ciphertext.startsWith("v1:"), true, "the stored credential is an encrypted envelope");
  assert.equal(ciphertext.includes(GITHUB_SECRET), false, "the stored credential is not plaintext");
  assert.equal(rereadPayload.includes(ciphertext), false, "the ciphertext never reaches the payload");
});

integration("the read carries the public origin and both callbacks, without a client id or a credential", async () => {
  const response = await adminGet(target(), ACCESS_PATH, actor(administrator).cookie);
  assertStatus(response, 200, "an administrator reads the provider registration data");
  const payload = await response.text();
  const body = JSON.parse(payload) as AccessView;
  const origin = config().publicOrigin;

  assert.equal(
    payload.includes(GITHUB_CLIENT_ID),
    true,
    "the read carries the stored client id outside the registration block",
  );
  assert.deepEqual(body.registration, {
    origin,
    redirectUris: {
      google: `${origin}/api/auth/callback/google`,
      github: `${origin}/api/auth/callback/github`,
    },
  });
  assert.notEqual(origin, target().baseUrl, "the origin is the public one, not the API port");

  const registration = JSON.stringify(body.registration);
  for (const forbidden of [GITHUB_CLIENT_ID, GITHUB_SECRET, GOOGLE_CLIENT_ID, GOOGLE_SECRET]) {
    assert.equal(registration.includes(forbidden), false, "the registration data carries no client id and no credential");
  }
});

integration("disabling a provider removes it, and re-enabling reuses the stored credential", async () => {
  const disabled = await accessPut(
    {
      revision: 1,
      passwordEnabled: true,
      providers: {
        google: { enabled: false, clientId: "" },
        github: { enabled: false, clientId: GITHUB_CLIENT_ID },
      },
    },
    actor(administrator).cookie,
  );
  assertStatus(disabled, 200, "an administrator disables the provider");
  const disabledBody = (await disabled.json()) as AccessView;
  assert.equal(disabledBody.revision, 2);
  assert.deepEqual(disabledBody.providers.github, {
    enabled: false,
    clientId: GITHUB_CLIENT_ID,
    credentialConfigured: true,
  });
  assert.deepEqual(await capabilities(), { emailPassword: true, registration: false, socialProviders: [] });

  const enabled = await accessPut(
    {
      revision: 2,
      passwordEnabled: true,
      providers: {
        google: { enabled: false, clientId: "" },
        github: { enabled: true, clientId: GITHUB_CLIENT_ID },
      },
    },
    actor(administrator).cookie,
  );
  assertStatus(enabled, 200, "the stored credential satisfies the requirement to enable again");
  const enabledBody = (await enabled.json()) as AccessView;
  assert.equal(enabledBody.revision, 3);
  assert.equal(enabledBody.providers.github.credentialConfigured, true);
  assert.deepEqual(await capabilities(), {
    emailPassword: true,
    registration: false,
    socialProviders: ["github"],
  });
});

integration("a stale revision answers 409 and changes nothing", async () => {
  const before = await storedDocument();
  const { result: response, lines } = await withAuditCapture(() =>
    accessPut(
      {
        revision: 2,
        passwordEnabled: false,
        providers: {
          google: { enabled: true, clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_SECRET },
          github: { enabled: false, clientId: "" },
        },
      },
      actor(administrator).cookie,
    ),
  );
  assertStatus(response, 409, "a write against an old revision is refused");
  assert.deepEqual(await response.json(), { error: "revision_conflict" });
  assert.deepEqual(lines, [], "a conflict records nothing");
  assert.equal(await storedRevision(), 3, "the stored revision is unchanged");
  assert.equal(await storedDocument(), before, "the stored document is unchanged");

  const stored = await readSetting(target().database.db, accessMethodsSetting);
  assert.equal(stored?.value.password.enabled, true, "the conflicting password flag was not applied");
  const secretRows = await target().database.db
    .select({ name: instanceSecret.name })
    .from(instanceSecret)
    .where(eq(instanceSecret.name, providerSecretName("google")));
  assert.deepEqual(secretRows, [], "the conflicting credential was not stored");
  assert.deepEqual(await capabilities(), {
    emailPassword: true,
    registration: false,
    socialProviders: ["github"],
  });
});

integration("a change without the public origin is refused before it is applied", async () => {
  const response = await adminRequest(target(), ACCESS_PATH, {
    method: "PUT",
    headers: { cookie: actor(administrator).cookie, "content-type": "application/json" },
    body: JSON.stringify({ revision: 3, passwordEnabled: false, providers: {} }),
  });
  assertStatus(response, 403, "a cookie mutation requires the public origin");
  assert.deepEqual(await response.json(), { error: "origin_not_allowed" });
  const stored = await readSetting(target().database.db, accessMethodsSetting);
  assert.equal(stored?.value.password.enabled, true);
});
