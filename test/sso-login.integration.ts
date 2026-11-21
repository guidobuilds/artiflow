import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import type { SsoConnectionDocument } from "@artiflow/contracts/settings";

import { loadConfig } from "../apps/api/src/config.ts";
import { account, session, ssoProvider, user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { instanceSecret } from "../apps/api/src/adapters/postgres/db/settings-schema.ts";
import { decodeSecretKey } from "../apps/api/src/settings/secrets.ts";
import {
  SSO_CONNECTION_KEY,
  readRawSetting,
  ssoConnectionSetting,
  writeSetting,
} from "../apps/api/src/settings/store.ts";
import { ssoRedirectUri, ssoSecretName } from "../apps/api/src/settings/sso-connection.ts";
import {
  adminRequest,
  assertStatus,
  startAdminHarness,
  type AdminHarness,
} from "./helpers/admin-harness.ts";
import {
  beginSsoSignIn,
  completeSsoCallback,
  failureOf,
  startFakeIdentityProvider,
  type FakeIdentityProvider,
} from "./helpers/oidc.ts";
import { seedTrustedAccount, trustedSession, type TrustedFixture } from "./helpers/trusted-accounts.ts";

const TEST_TIMEOUT_MS = 30_000;
const integration = (name: string, run: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, run);

const SSO_PATH = "/api/admin/sso";
const DISPLAY_NAME = "Acme Workforce";
const CLIENT_ID = `artiflow-sso-client-${randomUUID()}`;
const CLIENT_SECRET = `oidc-client-secret-${randomUUID()}`;
const KEY = decodeSecretKey(randomBytes(32).toString("base64"));
const TEMPLATED_ISSUER = "https://login.microsoftonline.com/common/v2.0";

type ConnectionView = {
  enabled: boolean;
  credentialConfigured: boolean;
  issuer: string;
  clientId: string;
};

type SsoView = {
  revision: number | null;
  connection: ConnectionView;
  redirectUri: string;
  readiness: { signInAvailable: boolean };
};

let harness: AdminHarness | null = null;
let idp: FakeIdentityProvider | null = null;
let fixture: TrustedFixture | null = null;
let administratorCookie = "";
let memberUserId = "";
let memberEmail = "";

function target(): AdminHarness {
  assert.ok(harness, "the harness started");
  return harness;
}

function identity(): FakeIdentityProvider {
  assert.ok(idp, "the fake identity provider started");
  return idp;
}

function fixtureOf(): TrustedFixture {
  assert.ok(fixture, "the fixture started");
  return fixture;
}

function statusIs(status: number, expected: number, detail: string): void {
  assert.equal(status, expected, detail);
}

function baseUrl(): string {
  return target().baseUrl;
}

function publicOrigin(): string {
  return target().config.publicOrigin;
}

function connectionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: null,
    enabled: false,
    displayName: DISPLAY_NAME,
    issuer: identity().issuer,
    clientId: CLIENT_ID,
    scopes: ["openid", "profile", "email"],
    jitProvisioning: false,
    allowedDomains: ["acme.example.test"],
    acceptAnyAccount: false,
    ...overrides,
  };
}

async function putConnection(body: unknown): Promise<SsoView> {
  const response = await adminRequest(target(), SSO_PATH, {
    method: "PUT",
    headers: { cookie: administratorCookie, origin: publicOrigin(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assertStatus(response, 200, "an administrator saves the connection");
  return (await response.json()) as SsoView;
}

async function readConnection(): Promise<SsoView> {
  const response = await adminRequest(target(), SSO_PATH, {
    method: "GET",
    headers: { cookie: administratorCookie },
  });
  assertStatus(response, 200, "an administrator reads the connection");
  return (await response.json()) as SsoView;
}

async function storedRevision(): Promise<number | null> {
  const stored = await readRawSetting(target().database.db, SSO_CONNECTION_KEY);
  return stored?.revision ?? null;
}

async function writeRawConnection(overrides: Partial<SsoConnectionDocument> = {}): Promise<void> {
  const document: SsoConnectionDocument = {
    enabled: true,
    displayName: DISPLAY_NAME,
    issuer: identity().issuer,
    clientId: CLIENT_ID,
    clientSecretName: ssoSecretName(),
    scopes: ["openid", "profile", "email"],
    jitProvisioning: false,
    allowedDomains: ["acme.example.test"],
    acceptAnyAccount: false,
    provenance: { source: "administrator", at: new Date().toISOString() },
    ...overrides,
  };
  await writeSetting(target().database.db, ssoConnectionSetting, {
    value: document,
    expectedRevision: await storedRevision(),
  });
}

async function storedSecretRows(): Promise<number> {
  const rows = await target()
    .database.db.select({ name: instanceSecret.name })
    .from(instanceSecret)
    .where(eq(instanceSecret.name, ssoSecretName()));
  return rows.length;
}

async function userCount(): Promise<number> {
  const rows = await target().database.db.select({ id: user.id }).from(user);
  return rows.length;
}

async function accountOf(userId: string): Promise<string[]> {
  const rows = await target()
    .database.db.select({ accountId: account.accountId })
    .from(account)
    .where(eq(account.userId, userId));
  return rows.map((row) => row.accountId);
}

async function providerRows(): Promise<number> {
  const rows = await target().database.db.select({ id: ssoProvider.id }).from(ssoProvider);
  return rows.length;
}

async function sessionRows(userId: string): Promise<number> {
  const rows = await target().database.db.select({ id: session.id }).from(session).where(eq(session.userId, userId));
  return rows.length;
}

async function deactivate(userId: string): Promise<void> {
  await target().database.db.update(user).set({ status: "deactivated" }).where(eq(user.id, userId));
}

async function sessionUserId(cookie: string): Promise<string | null> {
  const response = await adminRequest(target(), "/api/auth/get-session", { method: "GET", headers: { cookie } });
  assertStatus(response, 200, "the session read answers");
  const body = (await response.json()) as { user?: { id?: string } } | null;
  return body?.user?.id ?? null;
}

before(async () => {
  const base = loadConfig(process.env);
  idp = await startFakeIdentityProvider({ clientId: CLIENT_ID });
  harness = await startAdminHarness({ ...base, secretEncryptionKey: KEY });
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
  administratorCookie = (
    await trustedSession(fixtureOf(), { role: "administrator", name: "SSO Administrator" })
  ).cookie;
  const member = await seedTrustedAccount(target().database, { name: "Enterprise Member" });
  memberUserId = member.userId;
  memberEmail = member.email;
});

after(async () => {
  await harness?.close();
  harness = null;
  await idp?.close();
  idp = null;
});

integration("the provider registers from the stored document and disappears without a restart", async () => {
  const before = await target().auth.snapshot();
  assert.equal(before.sso.provider, null, "nothing is registered before a document exists");
  assert.equal(before.sso.enabled, false, "the connection is off");

  const disabled = await putConnection(connectionBody({ enabled: false }));
  assert.equal((await target().auth.snapshot()).sso.provider, null, "a stored disabled document registers nothing");

  const enabled = await putConnection(
    connectionBody({ revision: disabled.revision, enabled: true, clientSecret: CLIENT_SECRET }),
  );
  assert.deepEqual(enabled.readiness, { signInAvailable: true }, "the build now publishes the sign-in route");
  assert.equal(enabled.redirectUri, ssoRedirectUri(publicOrigin()), "the published redirect URI is unchanged");

  const registered = (await target().auth.snapshot()).sso.provider;
  assert.ok(registered, "the stored document registers exactly one provider");
  assert.equal(registered.issuer, identity().issuer, "the provider pins the stored issuer");
  assert.equal(registered.discoveryUrl, `${identity().issuer}/.well-known/openid-configuration`);
  assert.equal(registered.clientId, CLIENT_ID);
  assert.equal(registered.clientSecret, CLIENT_SECRET, "the provider carries the decrypted credential");
  assert.deepEqual([...registered.scopes], ["openid", "profile", "email"]);
  assert.deepEqual([...registered.allowedDomains], ["acme.example.test"]);

  const start = await beginSsoSignIn(baseUrl(), publicOrigin(), { callbackURL: "/" });
  statusIs(start.status, 200, "the connection starts a sign-in without an email");
  assert.ok(start.url.startsWith(`${identity().issuer}/authorize`), "the sign-in goes to the stored issuer");
  assert.equal(start.state !== "", true, "the sign-in carries a state");
  assert.equal(start.body.includes(CLIENT_SECRET), false, "the start answer carries no credential");

  const off = await putConnection(connectionBody({ revision: enabled.revision, enabled: false }));
  assert.equal((await target().auth.snapshot()).sso.provider, null, "a disabled document removes the provider");
  assert.deepEqual(off.readiness, { signInAvailable: true });

  const refused = await beginSsoSignIn(baseUrl(), publicOrigin(), { callbackURL: "/" });
  assert.equal(refused.status, 404, "a disabled connection has no sign-in route");
  assert.equal(refused.url, "");

  const restored = await putConnection(
    connectionBody({ revision: off.revision, enabled: true, clientSecret: CLIENT_SECRET }),
  );
  assert.equal(restored.revision !== null, true);
  assert.ok((await target().auth.snapshot()).sso.provider, "the provider is back with the document, still without a restart");
});

integration("an existing active account signs in through the connection", async () => {
  const users = await userCount();
  const subject = `idp-member-${randomUUID()}`;
  identity().setProfile({ subject, email: memberEmail, emailVerified: true, name: "Enterprise Member" });

  const start = await beginSsoSignIn(baseUrl(), publicOrigin(), { callbackURL: "/", errorCallbackURL: "/login" });
  statusIs(start.status, 200, "the flow starts");
  const done = await completeSsoCallback(baseUrl(), { state: start.state, cookie: start.cookie });
  assert.equal(done.status, 302, "the callback redirects back to the application");
  const failure = failureOf(done.location);
  assert.equal(failure.error, "", `no error is reported: ${done.location}`);
  assert.equal(done.location, "/", "a successful sign-in lands on the answered callback");
  assert.equal(done.location.includes(CLIENT_SECRET), false);
  assert.equal(done.sessionCookie.length > 0, true, "a successful sign-in issues a session");

  assert.equal(await sessionUserId(done.sessionCookie), memberUserId, "the session belongs to the existing account");
  assert.equal(await userCount(), users, "no account is created for an existing address");
  assert.equal((await accountOf(memberUserId)).includes(subject), true, "the enterprise identity is linked to the account");
  assert.equal(await sessionRows(memberUserId), 1, "exactly one session is created");
  assert.equal(await providerRows(), 0, "the library's provider table stays empty: the document is the only source");
});

integration("an unknown address is refused and told to ask the administrator", async () => {
  const users = await userCount();
  const unknown = `unknown-${randomUUID()}@acme.example.test`;
  identity().setProfile({ subject: `idp-unknown-${randomUUID()}`, email: unknown, emailVerified: true });

  const start = await beginSsoSignIn(baseUrl(), publicOrigin(), { callbackURL: "/", errorCallbackURL: "/login" });
  statusIs(start.status, 200, "the flow starts for an unknown address");
  const done = await completeSsoCallback(baseUrl(), { state: start.state, cookie: start.cookie });
  assert.equal(done.status, 302, "the refusal redirects to the answered error callback");
  const failure = failureOf(done.location);
  assert.equal(failure.error, "sso_account_unknown");
  assert.match(failure.description, /Ask the administrator/i, "the refusal points at the administrator");
  assert.equal(done.sessionCookie, "", "a refused sign-in issues no session");
  assert.equal(await userCount(), users, "a refused sign-in creates no account");
  assert.equal(await sessionRows(memberUserId), 1, "a refused sign-in leaves stored sessions untouched");
});

integration("a deactivated account is refused and never reactivated", async () => {
  const dormant = await seedTrustedAccount(target().database, { name: "Dormant Member" });
  await deactivate(dormant.userId);
  const users = await userCount();
  identity().setProfile({ subject: `idp-dormant-${randomUUID()}`, email: dormant.email, emailVerified: true });

  const start = await beginSsoSignIn(baseUrl(), publicOrigin(), { callbackURL: "/", errorCallbackURL: "/login" });
  const done = await completeSsoCallback(baseUrl(), { state: start.state, cookie: start.cookie });
  const failure = failureOf(done.location);
  assert.equal(failure.error, "sso_account_deactivated");
  assert.match(failure.description, /Ask the administrator/i);
  assert.equal(done.sessionCookie, "", "a deactivated account receives no session");
  assert.equal(await sessionRows(dormant.userId), 0, "no session is stored for a deactivated account");
  assert.equal(await userCount(), users, "a refusal creates no account");

  const rows = await target().database.db.select({ status: user.status }).from(user).where(eq(user.id, dormant.userId));
  assert.equal(rows[0]?.status, "deactivated", "the account is never reactivated");
});

integration("an issuer this build cannot trust never registers a provider", async () => {
  await writeRawConnection({ issuer: TEMPLATED_ISSUER });
  assert.equal((await target().auth.snapshot()).sso.provider, null, "a templated issuer registers nothing");

  const refused = await beginSsoSignIn(baseUrl(), publicOrigin(), { callbackURL: "/" });
  assert.equal(refused.status, 404, "the sign-in route is not published for an unusable issuer");
  assert.equal(refused.url, "");

  await writeRawConnection({ issuer: `http://${new URL(identity().issuer).host}/tenant-a` });
  assert.equal((await target().auth.snapshot()).sso.provider, null, "a non-HTTPS issuer registers nothing");

  await writeRawConnection({});
  const restored = (await target().auth.snapshot()).sso.provider;
  assert.equal(restored?.issuer, identity().issuer, "the good document registers again");
});

integration("a broken or contradictory discovery refuses the sign-in instead of guessing", async () => {
  identity().setDiscovery("broken");
  const broken = await beginSsoSignIn(baseUrl(), publicOrigin(), { callbackURL: "/" });
  assert.equal(broken.status, 502, "an unreachable discovery is a refusal, never a success");
  const brokenBody = broken.body;
  assert.equal(brokenBody.includes("token_endpoint"), false, "no discovery document is returned");
  assert.equal(brokenBody.includes(CLIENT_SECRET), false, "no credential is returned");
  assert.equal(broken.url, "", "a refusal is never a redirect to the identity provider");
  assert.equal(broken.state, "", "a refusal never starts a flow");

  identity().setDiscovery("mismatched_issuer");
  const mismatched = await beginSsoSignIn(baseUrl(), publicOrigin(), { callbackURL: "/" });
  assert.equal(mismatched.status, 400, "a discovery that advertises another issuer is a refusal");
  assert.equal(mismatched.url, "");

  identity().setDiscovery("ok");
  const start = await beginSsoSignIn(baseUrl(), publicOrigin(), { callbackURL: "/" });
  statusIs(start.status, 200, "a reachable discovery starts the flow again");
});

integration("the published configuration stays readable while the route is live", async () => {
  const view = await readConnection();
  assert.deepEqual(view.readiness, { signInAvailable: true });
  assert.equal(view.connection.enabled, true);
  assert.equal(view.connection.credentialConfigured, true);
  assert.equal(view.connection.issuer, identity().issuer);
  assert.equal(JSON.stringify(view).includes(CLIENT_SECRET), false, "the read carries no credential");
  assert.equal(await storedSecretRows(), 1);
  assert.notEqual(await storedRevision(), null);
});
