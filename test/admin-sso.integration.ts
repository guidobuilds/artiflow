import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { loadConfig } from "../apps/api/src/config.ts";
import { instanceSecret, instanceSetting } from "../apps/api/src/adapters/postgres/db/settings-schema.ts";
import { decodeSecretKey } from "../apps/api/src/settings/secrets.ts";
import { ssoSecretName } from "../apps/api/src/settings/sso-connection.ts";
import { readRawSetting } from "../apps/api/src/settings/store.ts";
import { ACCEPT_ANY_ACCOUNT_WARNING } from "@artiflow/contracts/settings";
import { trustedSession, type TrustedFixture, type TrustedSession } from "./helpers/trusted-accounts.ts";
import { adminGet, adminRequest, assertStatus, startAdminHarness, type AdminHarness } from "./helpers/admin-harness.ts";

const TEST_TIMEOUT_MS = 20_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

const SSO_PATH = "/api/admin/sso";
const ISSUER = `https://idp-${randomUUID().slice(0, 8)}.example.test/tenant-a`;
const TEMPLATED_AUTHORITY = "https://login.microsoftonline.com/common/v2.0";
const TENANT_ISSUER = "https://login.microsoftonline.com/tenant-a/v2.0";
const TEMPLATED_ISSUER = "https://login.microsoftonline.com/{tenantid}/v2.0";
const CLIENT_ID = `artiflow-client-${randomUUID()}`;
const CLIENT_SECRET = `oidc-client-secret-${randomUUID()}`;
const REPLACEMENT_SECRET = `oidc-client-secret-${randomUUID()}`;
const KEY = decodeSecretKey(randomBytes(32).toString("base64"));

type ConnectionView = {
  enabled: boolean;
  displayName: string;
  issuer: string;
  clientId: string;
  credentialConfigured: boolean;
  scopes: string[];
  jitProvisioning: boolean;
  allowedDomains: string[];
  acceptAnyAccount: boolean;
  acceptAnyAccountWarning: string;
};

type SsoView = {
  revision: number | null;
  connection: ConnectionView;
  redirectUri: string;
  readiness: { signInAvailable: boolean };
  provenance: { source: string; at: string } | null;
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

function publicOrigin(): string {
  return target().config.publicOrigin;
}

function connectionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: null,
    enabled: false,
    displayName: "Acme Workforce",
    issuer: ISSUER,
    clientId: CLIENT_ID,
    scopes: ["openid", "profile", "email"],
    jitProvisioning: false,
    allowedDomains: [],
    acceptAnyAccount: false,
    ...overrides,
  };
}

function ssoPut(body: unknown, cookie: string): Promise<Response> {
  return adminRequest(target(), SSO_PATH, {
    method: "PUT",
    headers: { cookie, origin: publicOrigin(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type DiscoveryAnswer = "unreachable" | { status?: number; body?: unknown };
type DiscoveryScript = (url: string) => DiscoveryAnswer;

const DISCOVERY_SUFFIX = "/.well-known/openid-configuration";

const advertisements: Record<string, unknown> = {
  [ISSUER]: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize` },
  [TENANT_ISSUER]: { issuer: TEMPLATED_ISSUER },
  "https://idp.example.test/tenant-b": { issuer: ISSUER },
  "https://broken.example.test/tenant-a": { authorization_endpoint: "https://broken.example.test/authorize" },
};

async function withDiscovery<T>(script: DiscoveryScript, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith(DISCOVERY_SUFFIX)) return await real(input as Parameters<typeof real>[0], init);
    const answer = script(url);
    if (answer === "unreachable") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const advertisedIssuer: DiscoveryScript = (url) => {
  const issuer = url.slice(0, -DISCOVERY_SUFFIX.length);
  const body = advertisements[issuer];
  return body === undefined ? { status: 404, body: {} } : { body };
};

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
  for (const secret of [CLIENT_SECRET, REPLACEMENT_SECRET]) {
    assert.equal(payload.includes(secret), false, `${detail}: a credential never reaches the payload`);
  }
  assert.equal(payload.includes("v1:"), false, `${detail}: no ciphertext envelope reaches the payload`);
  for (const forbidden of ["clientSecret", "clientSecretName", "secretName", "ciphertext", "credential"]) {
    assert.equal(collectKeys(JSON.parse(payload)).includes(forbidden), false, `${detail}: no ${forbidden} field`);
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
      .filter((line) => line.event === "access.sso.updated");
    return { result, lines };
  } finally {
    process.stdout.write = original;
  }
}

async function storedConnection(): Promise<{ revision: number; value: Record<string, unknown> } | null> {
  const stored = await readRawSetting(target().database.db, "access.sso");
  if (stored === null) return null;
  return { revision: stored.revision, value: stored.value as Record<string, unknown> };
}

async function storedSecretRows(): Promise<string[]> {
  const rows = await target()
    .database.db.select({ ciphertext: instanceSecret.ciphertext })
    .from(instanceSecret)
    .where(eq(instanceSecret.name, ssoSecretName()));
  return rows.map((row) => row.ciphertext);
}

async function identityRows(): Promise<number> {
  const rows = await target().database.db.select({ key: instanceSetting.key }).from(instanceSetting);
  return rows.length;
}

type RefusalCase = {
  name: string;
  body: Record<string, unknown>;
  code: string;
  discovery?: DiscoveryScript;
};

const REFUSALS: RefusalCase[] = [
  {
    name: "a multi-tenant authority names the tenant-scoped fix",
    body: connectionBody({ enabled: true, issuer: TEMPLATED_AUTHORITY, clientSecret: CLIENT_SECRET }),
    code: "sso_issuer_templated",
  },
  {
    name: "a discovery document that advertises a templated issuer is refused",
    body: connectionBody({ enabled: true, issuer: TENANT_ISSUER, clientSecret: CLIENT_SECRET }),
    code: "sso_issuer_templated",
    discovery: advertisedIssuer,
  },
  {
    name: "an issuer that is not HTTPS is refused",
    body: connectionBody({ enabled: true, issuer: "http://idp.example.test/tenant-a", clientSecret: CLIENT_SECRET }),
    code: "sso_issuer_insecure",
  },
  {
    name: "an issuer that is not a URL is refused",
    body: connectionBody({ enabled: true, issuer: "idp.example.test", clientSecret: CLIENT_SECRET }),
    code: "sso_issuer_invalid",
  },
  {
    name: "an unreachable discovery document is a refusal",
    body: connectionBody({ enabled: true, issuer: ISSUER, clientSecret: CLIENT_SECRET }),
    code: "sso_discovery_unreachable",
    discovery: () => "unreachable",
  },
  {
    name: "a discovery document that answers an error status is a refusal",
    body: connectionBody({ enabled: true, issuer: ISSUER, clientSecret: CLIENT_SECRET }),
    code: "sso_discovery_unreachable",
    discovery: () => ({ status: 503, body: {} }),
  },
  {
    name: "a discovery document without an issuer is refused",
    body: connectionBody({
      enabled: true,
      issuer: "https://broken.example.test/tenant-a",
      clientSecret: CLIENT_SECRET,
    }),
    code: "sso_discovery_invalid",
    discovery: advertisedIssuer,
  },
  {
    name: "an advertised issuer that differs from the saved one is refused",
    body: connectionBody({ enabled: true, issuer: "https://idp.example.test/tenant-b", clientSecret: CLIENT_SECRET }),
    code: "sso_issuer_mismatch",
    discovery: advertisedIssuer,
  },
  {
    name: "just-in-time provisioning without an allowed domain is refused",
    body: connectionBody({ jitProvisioning: true }),
    code: "sso_domain_required",
  },
  {
    name: "accepting any account does not lift the allowed-domain requirement",
    body: connectionBody({ jitProvisioning: true, acceptAnyAccount: true }),
    code: "sso_domain_required",
  },
  {
    name: "a domain that is not a bare hostname is refused",
    body: connectionBody({ allowedDomains: ["https://acme.example.test"] }),
    code: "sso_domain_invalid",
  },
  {
    name: "a wildcard domain is refused",
    body: connectionBody({ allowedDomains: ["*"] }),
    code: "sso_domain_invalid",
  },
  {
    name: "an address in the domain list is refused",
    body: connectionBody({ allowedDomains: ["ada@acme.example.test"] }),
    code: "sso_domain_invalid",
  },
  {
    name: "a display name is required to enable the connection",
    body: connectionBody({ enabled: true, displayName: "  ", clientSecret: CLIENT_SECRET }),
    code: "sso_display_name_required",
  },
  {
    name: "a client id is required to enable the connection",
    body: connectionBody({ enabled: true, clientId: "", clientSecret: CLIENT_SECRET }),
    code: "sso_client_id_required",
  },
  {
    name: "a credential is required to enable the connection",
    body: connectionBody({ enabled: true }),
    code: "sso_credential_required",
  },
];

before(async () => {
  const base = loadConfig(process.env);
  harness = await startAdminHarness({ ...base, secretEncryptionKey: KEY });
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
  administrator = await trustedSession(fixtureOf(), { role: "administrator", name: "Connection Administrator" });
  member = await trustedSession(fixtureOf(), { name: "Ordinary Member" });
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("a member can neither read nor change the enterprise connection", async () => {
  const read = await adminGet(target(), SSO_PATH, actor(member).cookie);
  assertStatus(read, 403, "reading the connection is an administration action");
  assert.deepEqual(await read.json(), { error: "administrator_required" });

  const write = await ssoPut(connectionBody(), actor(member).cookie);
  assertStatus(write, 403, "changing the connection is an administration action");
  assert.deepEqual(await write.json(), { error: "administrator_required" });

  assert.equal(await storedConnection(), null, "a member writes nothing");
});

integration("an administrator reads the empty connection with its redirect URI and readiness", async () => {
  const response = await adminGet(target(), SSO_PATH, actor(administrator).cookie);
  assertStatus(response, 200, "an administrator reads the connection");
  const payload = await response.text();
  assertNoCredentialMaterial(payload, "the empty connection");
  const body = JSON.parse(payload) as SsoView;
  assert.deepEqual(body, {
    revision: null,
    connection: {
      enabled: false,
      displayName: "",
      issuer: "",
      clientId: "",
      credentialConfigured: false,
      scopes: ["openid", "profile", "email"],
      jitProvisioning: false,
      allowedDomains: [],
      acceptAnyAccount: false,
      acceptAnyAccountWarning: ACCEPT_ANY_ACCOUNT_WARNING,
    },
    redirectUri: `${publicOrigin()}/api/auth/sso/callback/artiflow`,
    readiness: { signInAvailable: true },
    provenance: null,
  });
});

integration("every refused save answers its own code, writes nothing and records nothing", async () => {
  const rowsBefore = await identityRows();
  for (const refusal of REFUSALS) {
    const captured = await withAuditCapture(() =>
      withDiscovery(refusal.discovery ?? advertisedIssuer, () =>
        ssoPut({ ...refusal.body, revision: null }, actor(administrator).cookie),
      ),
    );
    assertStatus(captured.result, 400, `${refusal.name} is refused`);
    assert.deepEqual(await captured.result.json(), { error: refusal.code }, refusal.name);
    assert.deepEqual(captured.lines, [], `${refusal.name}: a refused save records nothing`);
  }
  assert.equal(await identityRows(), rowsBefore, "a refused save stores no setting document");
  assert.equal(await storedConnection(), null);
  assert.deepEqual(await storedSecretRows(), [], "a refused save stores no credential");
});

integration("a valid connection is stored with its credential, and a read reports presence only", async () => {
  const { result: response, lines } = await withAuditCapture(() =>
    ssoPut(
      connectionBody({
        clientSecret: CLIENT_SECRET,
        jitProvisioning: true,
        allowedDomains: [" Acme.Example.Test ", "second.example.test"],
        acceptAnyAccount: true,
      }),
      actor(administrator).cookie,
    ),
  );
  assertStatus(response, 200, "an administrator saves a valid connection");
  const payload = await response.text();
  assertNoCredentialMaterial(payload, "the save response");
  const body = JSON.parse(payload) as SsoView;
  assert.equal(body.revision, 1);
  assert.deepEqual(body.connection, {
    enabled: false,
    displayName: "Acme Workforce",
    issuer: ISSUER,
    clientId: CLIENT_ID,
    credentialConfigured: true,
    scopes: ["openid", "profile", "email"],
    jitProvisioning: true,
    allowedDomains: ["acme.example.test", "second.example.test"],
    acceptAnyAccount: true,
    acceptAnyAccountWarning: ACCEPT_ANY_ACCOUNT_WARNING,
  });
  assert.deepEqual(body.provenance?.source, "administrator");
  assert.equal(Number.isNaN(Date.parse(body.provenance?.at ?? "")), false, "the provenance carries the save time");

  assert.equal(lines.length, 1, "the applied change records exactly one event");
  assert.equal(lines[0]?.event, "access.sso.updated");
  assert.equal(lines[0]?.actorId, actor(administrator).userId);
  assert.equal(lines[0]?.actorRole, "administrator");
  assert.equal(lines[0]?.settingKey, "access.sso");
  assert.equal(lines[0]?.outcome, "applied");
  assert.equal(JSON.stringify(lines[0]).includes(CLIENT_SECRET), false, "the event carries no credential");

  const stored = await storedConnection();
  assert.ok(stored, "the document is stored");
  assert.equal(stored.revision, 1);
  assert.equal(stored.value.clientSecretName, ssoSecretName(), "the document references the credential by name");
  assert.equal(
    JSON.stringify(stored.value).includes(CLIENT_SECRET),
    false,
    "the document never carries the credential",
  );

  const secretRows = await storedSecretRows();
  assert.equal(secretRows.length, 1, "the supplied credential is stored once");
  const ciphertext = secretRows[0] ?? "";
  assert.equal(ciphertext.startsWith("v1:"), true, "the stored credential is an encrypted envelope");

  const reread = await adminGet(target(), SSO_PATH, actor(administrator).cookie);
  assertStatus(reread, 200, "the stored connection is readable");
  const rereadPayload = await reread.text();
  assertNoCredentialMaterial(rereadPayload, "the stored connection");
  assert.equal(rereadPayload.includes(ciphertext), false, "the ciphertext never reaches the payload");
  assert.deepEqual(JSON.parse(rereadPayload), body, "the read answers what was stored");

  const replaced = await ssoPut(
    connectionBody({ revision: 1, clientSecret: REPLACEMENT_SECRET, allowedDomains: ["acme.example.test"] }),
    actor(administrator).cookie,
  );
  assertStatus(replaced, 200, "a supplied credential replaces the stored one");
  const replacedPayload = await replaced.text();
  assertNoCredentialMaterial(replacedPayload, "the replacement response");
  assert.equal((JSON.parse(replacedPayload) as SsoView).revision, 2);
});

integration("an administrator enables the connection once the sign-in route exists", async () => {
  const before = await storedConnection();
  assert.ok(before, "the connection was stored by the previous case");
  const captured = await withAuditCapture(() =>
    withDiscovery(advertisedIssuer, () =>
      ssoPut(
        connectionBody({
          revision: before.revision,
          enabled: true,
          jitProvisioning: true,
          allowedDomains: ["acme.example.test"],
        }),
        actor(administrator).cookie,
      ),
    ),
  );
  assertStatus(captured.result, 200, "an enable with a sign-in route behind it is accepted");
  const payload = await captured.result.text();
  assertNoCredentialMaterial(payload, "the enable response");
  const body = JSON.parse(payload) as SsoView;
  assert.equal(body.connection.enabled, true, "the stored connection is published");
  assert.equal(body.revision, before.revision + 1, "the enable is one stored revision");
  assert.deepEqual(body.readiness, { signInAvailable: true });
  assert.equal(captured.lines.length, 1, "the applied enable records exactly one event");
  assert.equal(captured.lines[0]?.event, "access.sso.updated");
  assert.equal(captured.lines[0]?.outcome, "applied");
  assert.equal(JSON.stringify(captured.lines[0]).includes(CLIENT_SECRET), false, "the event carries no credential");

  const stored = await storedConnection();
  assert.ok(stored, "the enabled document is stored");
  assert.equal(stored.value.enabled, true, "the stored document is enabled");
  assert.equal(stored.value.clientSecretName, ssoSecretName());

  const readiness = await adminGet(target(), SSO_PATH, actor(administrator).cookie);
  assertStatus(readiness, 200, "the readiness state is readable");
  assert.deepEqual(((await readiness.json()) as SsoView).readiness, { signInAvailable: true });
});

integration("a stale revision answers the conflict and changes nothing", async () => {
  const before = await storedConnection();
  const captured = await withAuditCapture(() =>
    ssoPut(connectionBody({ revision: 1, displayName: "Renamed" }), actor(administrator).cookie),
  );
  assertStatus(captured.result, 409, "a write against an old revision is refused");
  assert.deepEqual(await captured.result.json(), { error: "revision_conflict" });
  assert.deepEqual(captured.lines, [], "a conflict records nothing");
  assert.deepEqual(await storedConnection(), before, "the stored document is unchanged");
});

integration("a change without the public origin is refused before it is applied", async () => {
  const before = await storedConnection();
  assert.ok(before, "the connection is stored");
  const response = await adminRequest(target(), SSO_PATH, {
    method: "PUT",
    headers: { cookie: actor(administrator).cookie, "content-type": "application/json" },
    body: JSON.stringify(connectionBody({ revision: before.revision, displayName: "Renamed" })),
  });
  assertStatus(response, 403, "a cookie mutation requires the public origin");
  assert.deepEqual(await response.json(), { error: "origin_not_allowed" });
  const stored = await storedConnection();
  assert.equal(stored?.revision, before.revision, "the stored revision is unchanged");
  assert.equal(stored?.value.displayName, "Acme Workforce");
});
