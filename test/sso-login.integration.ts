import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";

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
import { SSO_CONNECTION_PROVIDER_ID, ssoRedirectUri, ssoSecretName } from "../apps/api/src/settings/sso-connection.ts";
import { adminRequest, assertStatus, startAdminHarness, type AdminHarness } from "./helpers/admin-harness.ts";
import {
  beginSsoSignIn,
  completeSsoCallback,
  failureOf,
  startFakeIdentityProvider,
  type FakeIdentityProvider,
  type IdpProfile,
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

async function setConnection(overrides: Record<string, unknown> = {}): Promise<SsoView> {
  const current = await readConnection();
  return putConnection(connectionBody({ revision: current.revision, enabled: true, ...overrides }));
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

type StoredUser = { id: string; email: string; name: string; role: string; status: string };

async function userRow(email: string): Promise<StoredUser | null> {
  const rows = await target()
    .database.db.select({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
    })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.trim().toLowerCase()}`);
  return rows[0] ?? null;
}

async function identityRows(accountId: string): Promise<{ userId: string }[]> {
  return await target()
    .database.db.select({ userId: account.userId })
    .from(account)
    .where(and(eq(account.providerId, SSO_CONNECTION_PROVIDER_ID), eq(account.accountId, accountId)));
}

async function sessionRole(cookie: string): Promise<string | null> {
  const response = await adminRequest(target(), "/api/auth/get-session", { method: "GET", headers: { cookie } });
  assertStatus(response, 200, "the session read answers");
  const body = (await response.json()) as { user?: { role?: string } } | null;
  return body?.user?.role ?? null;
}

async function signIn(subject: IdpProfile): Promise<{ status: number; location: string; sessionCookie: string }> {
  identity().setProfile(subject);
  const start = await beginSsoSignIn(baseUrl(), publicOrigin(), { callbackURL: "/", errorCallbackURL: "/login" });
  statusIs(start.status, 200, "the flow starts");
  return await completeSsoCallback(baseUrl(), { state: start.state, cookie: start.cookie });
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
  administratorCookie = (await trustedSession(fixtureOf(), { role: "administrator", name: "SSO Administrator" }))
    .cookie;
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
  assert.ok(
    (await target().auth.snapshot()).sso.provider,
    "the provider is back with the document, still without a restart",
  );
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
  assert.equal(
    (await accountOf(memberUserId)).includes(subject),
    true,
    "the enterprise identity is linked to the account",
  );
  assert.equal(await sessionRows(memberUserId), 1, "exactly one session is created");
  assert.equal(await providerRows(), 0, "the library's provider table stays empty: the document is the only source");
});

integration("a first sign-in is refused while just-in-time provisioning is off", async () => {
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
  assert.equal(await userRow(unknown), null, "the allowed domain does not create an account by itself");
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

integration("just-in-time provisioning creates an active member account on an allowed domain", async () => {
  await setConnection({ jitProvisioning: true, acceptAnyAccount: false });
  const users = await userCount();
  const email = `newcomer-${randomUUID()}@acme.example.test`;
  const subject = `idp-newcomer-${randomUUID()}`;

  const done = await signIn({ subject, email, emailVerified: true, name: "New Comer" });
  const failure = failureOf(done.location);
  assert.equal(failure.error, "", `the authorized first sign-in is accepted: ${done.location}`);
  assert.equal(done.location, "/");
  assert.equal(done.location.includes(CLIENT_SECRET), false, "the answer carries no credential");

  const created = await userRow(email);
  assert.ok(created, "the authorized first sign-in creates the account");
  assert.equal(created.role, "member", "a provisioned account is never an administrator");
  assert.equal(created.status, "active");
  assert.equal(created.email, email);
  assert.equal(await userCount(), users + 1, "exactly one account is created");
  assert.deepEqual(await identityRows(subject), [{ userId: created.id }], "the enterprise identity is bound to it");
  assert.equal(await sessionUserId(done.sessionCookie), created.id, "the new account receives its session");
  assert.equal(await sessionRows(created.id), 1);
  assert.equal(await providerRows(), 0, "the library's provider table stays empty");
  assert.equal(JSON.stringify(await readConnection()).includes(CLIENT_SECRET), false);
});

integration("just-in-time provisioning refuses a domain the administrator did not allow", async () => {
  await setConnection({ jitProvisioning: true, acceptAnyAccount: false, allowedDomains: ["acme.example.test"] });
  const users = await userCount();
  const email = `outsider-${randomUUID()}@other.example.test`;
  const subject = `idp-outsider-${randomUUID()}`;

  const done = await signIn({ subject, email, emailVerified: true });
  const failure = failureOf(done.location);
  assert.equal(failure.error, "sso_domain_not_allowed");
  assert.match(failure.description, /accept any account/i, "the refusal names the explicit acceptance it needs");
  assert.equal(done.sessionCookie, "", "a refused sign-in issues no session");
  assert.equal(await userRow(email), null, "an unauthorized first sign-in creates no account");
  assert.equal(await userCount(), users);
  assert.deepEqual(await identityRows(subject), [], "no identity is bound for a refused first sign-in");
});

integration("accepting any account needs the explicit flag and then creates the first account", async () => {
  await setConnection({ jitProvisioning: true, acceptAnyAccount: true });
  const email = `partner-${randomUUID()}@partner.example.test`;
  const subject = `idp-partner-${randomUUID()}`;

  const done = await signIn({ subject, email, emailVerified: false, name: "Partner Person" });
  assert.equal(failureOf(done.location).error, "", `the accepted first sign-in creates the account: ${done.location}`);

  const created = await userRow(email);
  assert.ok(created, "the explicitly accepted account is created");
  assert.equal(created.role, "member");
  assert.equal(created.status, "active");
  assert.deepEqual(await identityRows(subject), [{ userId: created.id }]);

  await setConnection({ jitProvisioning: false, acceptAnyAccount: false });
});

integration("a token from another tenant is refused even on an allowed domain", async () => {
  await setConnection({ jitProvisioning: true, acceptAnyAccount: false, allowedDomains: ["acme.example.test"] });
  const users = await userCount();
  const refusedEmail = `tenant-b-${randomUUID()}@acme.example.test`;

  const refused = await signIn({
    subject: `idp-tenant-b-${randomUUID()}`,
    email: refusedEmail,
    emailVerified: true,
    claims: { tid: "tenant-b" },
  });
  const failure = failureOf(refused.location);
  assert.equal(failure.error, "sso_tenant_mismatch");
  assert.match(failure.description, /tenant/i, "the refusal names the tenant");
  assert.equal(refused.sessionCookie, "");
  assert.equal(await userRow(refusedEmail), null, "a token from another tenant creates no account");
  assert.equal(await userCount(), users);

  const email = `tenant-a-${randomUUID()}@acme.example.test`;
  const subject = `idp-tenant-a-${randomUUID()}`;
  const accepted = await signIn({ subject, email, emailVerified: true, claims: { tid: "tenant-a" } });
  assert.equal(failureOf(accepted.location).error, "", `the pinned tenant is accepted: ${accepted.location}`);
  const created = await userRow(email);
  assert.ok(created, "the pinned tenant signs its own account in");
  assert.deepEqual(await identityRows(subject), [{ userId: created.id }]);
});

integration("a linked account keeps the address it had", async () => {
  await setConnection({ jitProvisioning: false, acceptAnyAccount: false });
  const owner = await seedTrustedAccount(target().database, { name: "Address Owner" });
  const subject = `idp-address-${randomUUID()}`;

  const done = await signIn({
    subject,
    email: owner.email.replace(/^[^@]+/, (local) => local.toUpperCase()),
    emailVerified: true,
    name: "Renamed By The Provider",
  });
  assert.equal(failureOf(done.location).error, "", `the existing account signs in: ${done.location}`);
  assert.equal(await sessionUserId(done.sessionCookie), owner.userId);

  const rows = await target()
    .database.db.select({ email: user.email, name: user.name, status: user.status })
    .from(user)
    .where(eq(user.id, owner.userId));
  assert.equal(rows[0]?.email, owner.email, "the provider never rewrites the stored address");
  assert.equal(rows[0]?.name, owner.name, "the provider never rewrites the stored profile");
  assert.equal(rows[0]?.status, "active");
});

integration("an account created this way is never an administrator", async () => {
  await setConnection({ jitProvisioning: true, acceptAnyAccount: false });
  const email = `privileged-${randomUUID()}@acme.example.test`;
  const subject = `idp-privileged-${randomUUID()}`;

  const done = await signIn({
    subject,
    email,
    emailVerified: true,
    name: "Privileged Person",
    claims: { groups: ["administrators"], roles: ["administrator"], role: "administrator", isAdmin: true },
  });
  assert.equal(failureOf(done.location).error, "", `the first sign-in is accepted: ${done.location}`);

  const created = await userRow(email);
  assert.ok(created);
  assert.equal(created.role, "member", "the provider cannot grant the administrator role");
  assert.equal(created.status, "active");
  assert.equal(await sessionRole(done.sessionCookie), "member", "the session carries the member role");
  assert.deepEqual(await identityRows(subject), [{ userId: created.id }]);
});

integration("two simultaneous first sign-ins end with one account and one identity", async () => {
  await setConnection({ jitProvisioning: true, acceptAnyAccount: false, allowedDomains: ["acme.example.test"] });
  const users = await userCount();
  const email = `race-${randomUUID()}@acme.example.test`;
  const subject = `idp-race-${randomUUID()}`;
  identity().setProfile({ subject, email, emailVerified: true, name: "Race Person" });

  const [first, second] = await Promise.all([
    beginSsoSignIn(baseUrl(), publicOrigin(), { callbackURL: "/", errorCallbackURL: "/login" }),
    beginSsoSignIn(baseUrl(), publicOrigin(), { callbackURL: "/", errorCallbackURL: "/login" }),
  ]);
  statusIs(first.status, 200, "the first flow starts");
  statusIs(second.status, 200, "the second flow starts");

  const [a, b] = await Promise.all([
    completeSsoCallback(baseUrl(), { state: first.state, cookie: first.cookie }),
    completeSsoCallback(baseUrl(), { state: second.state, cookie: second.cookie }),
  ]);
  assert.deepEqual(
    [failureOf(a.location).error, failureOf(b.location).error],
    ["", ""],
    "both simultaneous first sign-ins are accepted",
  );

  const rows = await target()
    .database.db.select({ id: user.id, role: user.role, status: user.status })
    .from(user)
    .where(sql`lower(${user.email}) = ${email}`);
  assert.equal(rows.length, 1, "one account, never two");
  const created = rows[0];
  assert.ok(created);
  assert.equal(created.role, "member");
  assert.equal(created.status, "active");
  assert.equal(await userCount(), users + 1, "no second account is created");
  assert.deepEqual(await identityRows(subject), [{ userId: created.id }], "one identity, never two");
  assert.equal(await sessionUserId(a.sessionCookie), created.id);
  assert.equal(await sessionUserId(b.sessionCookie), created.id);
});

integration("an unverified claim outside the allowed domains is refused, never bound", async () => {
  await setConnection({ jitProvisioning: false, acceptAnyAccount: false });
  const person = await seedTrustedAccount(target().database, { name: "Unconfirmed Member" });

  const done = await signIn({ subject: `idp-unconfirmed-${randomUUID()}`, email: person.email, emailVerified: false });
  assert.equal(failureOf(done.location).error, "sso_email_unverified");
  assert.equal(done.sessionCookie, "", "an unverifiable claim receives no session");
  assert.equal(await sessionRows(person.userId), 0);
});

integration("an enterprise identity bound to one account is never reused or duplicated", async () => {
  await setConnection({ jitProvisioning: true, acceptAnyAccount: false, allowedDomains: ["acme.example.test"] });
  const bound = `idp-bound-${randomUUID()}`;
  await target().database.db.insert(account).values({
    id: randomUUID(),
    userId: memberUserId,
    providerId: SSO_CONNECTION_PROVIDER_ID,
    accountId: bound,
  });

  const users = await userCount();
  const strangerEmail = `stranger-${randomUUID()}@acme.example.test`;
  const reused = await signIn({ subject: bound, email: strangerEmail, emailVerified: true });
  assert.equal(
    failureOf(reused.location).error,
    "sso_identity_conflict",
    "an identity bound elsewhere creates nothing",
  );
  assert.equal(reused.sessionCookie, "");
  assert.equal(await userRow(strangerEmail), null, "no account is created for a bound identity");
  assert.equal(await userCount(), users);

  const impostorSubject = `idp-impostor-${randomUUID()}`;
  const impostor = await signIn({ subject: impostorSubject, email: memberEmail, emailVerified: true });
  assert.equal(failureOf(impostor.location).error, "sso_identity_conflict");
  assert.equal(impostor.sessionCookie, "");
  assert.deepEqual(await identityRows(impostorSubject), [], "no second identity is bound to the account");
  assert.deepEqual(await identityRows(bound), [{ userId: memberUserId }], "the account keeps its one identity");
});
