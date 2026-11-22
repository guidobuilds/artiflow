import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";

import { eq, sql } from "drizzle-orm";

import type { AccessMethodsDocument } from "@artiflow/contracts/settings";

import { loadConfig, type AppConfig } from "../apps/api/src/config.ts";
import { account, session, user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { instanceSetting } from "../apps/api/src/adapters/postgres/db/settings-schema.ts";
import { decodeSecretKey, writeSecret } from "../apps/api/src/settings/secrets.ts";
import { providerSecretName } from "../apps/api/src/settings/seed.ts";
import { accessMethodsSetting, writeSetting } from "../apps/api/src/settings/store.ts";
import { adminRequest, assertStatus, startAdminHarness, type AdminHarness } from "./helpers/admin-harness.ts";
import { seedTrustedAccount, type TrustedAccount } from "./helpers/trusted-accounts.ts";

const TEST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const integration = (name: string, run: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, run);

const CAPABILITIES_PATH = "/api/auth/capabilities";
const SIGN_IN_PATH = "/api/auth/sign-in/email";
const SESSION_VALUE_MARKER = "artiflow.session_token=";
const GITHUB_CLIENT_ID = `github-client-id-${randomUUID()}`;
const GITHUB_SECRET = `github-client-secret-${randomUUID()}`;
const SSO_DISPLAY_NAME = "Acme Identity";
const KEY = decodeSecretKey(randomBytes(32).toString("base64"));

type SeededSocialAccount = { id: string; email: string; providerAccountId: string };
type SignInAttempt = { status: number; body: string; cookie: string };
type LoginCapabilities = {
  emailPassword: boolean;
  registration: boolean;
  socialProviders: string[];
  sso?: { displayName: string | null; fallbackAvailable: boolean; fallbackAdministratorsOnly: boolean };
};

let harness: AdminHarness | null = null;
let administrator: TrustedAccount | null = null;
let member: TrustedAccount | null = null;

function target(): AdminHarness {
  assert.ok(harness, "the harness started");
  return harness;
}

function config(): AppConfig {
  return target().config;
}

function actor(value: TrustedAccount | null): TrustedAccount {
  assert.ok(value, "the account exists");
  return value;
}

function accessDocument(): AccessMethodsDocument {
  return {
    password: { enabled: true },
    providers: {
      google: { enabled: false, clientId: "", secretName: "" },
      github: { enabled: true, clientId: GITHUB_CLIENT_ID, secretName: providerSecretName("github") },
    },
    provenance: { source: "environment", at: "2026-11-20T10:00:00.000Z" },
  };
}

async function storeSsoConnection(value: Record<string, unknown>): Promise<void> {
  const existing = await target()
    .database.db.select({ key: instanceSetting.key })
    .from(instanceSetting)
    .where(eq(instanceSetting.key, "access.sso"));
  if (existing.length === 0) {
    await target().database.db.insert(instanceSetting).values({
      key: "access.sso",
      value,
      revision: 1,
      updatedAt: new Date(),
    });
    return;
  }
  await target()
    .database.db.update(instanceSetting)
    .set({ value, revision: sql`${instanceSetting.revision} + 1`, updatedAt: new Date() })
    .where(eq(instanceSetting.key, "access.sso"));
}

async function seedSocialAccount(role: "member" | "administrator"): Promise<SeededSocialAccount> {
  const id = randomUUID();
  const providerAccountId = `gh-${id}`;
  const now = new Date();
  const email = `social-${id}@example.test`;
  await target()
    .database.db.insert(user)
    .values({ id, name: `Social ${role}`, email, emailVerified: true, role, createdAt: now, updatedAt: now });
  await target().database.db.insert(account).values({
    id: randomUUID(),
    userId: id,
    providerId: "github",
    accountId: providerAccountId,
    createdAt: now,
    updatedAt: now,
  });
  return { id, email, providerAccountId };
}

async function capabilities(query = ""): Promise<LoginCapabilities> {
  const response = await adminRequest(target(), `${CAPABILITIES_PATH}${query}`, { method: "GET" });
  assertStatus(response, 200, "the capabilities endpoint answers");
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as LoginCapabilities;
}

function sessionPair(response: Response): string {
  const pair = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .find((value) => value.startsWith(SESSION_VALUE_MARKER) && value.length > SESSION_VALUE_MARKER.length);
  return pair ?? "";
}

async function signIn(email: string, password: string, path = SIGN_IN_PATH): Promise<SignInAttempt> {
  const response = await adminRequest(target(), path, {
    method: "POST",
    headers: { origin: config().publicOrigin, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: response.status, body: await response.text(), cookie: sessionPair(response) };
}

async function accountWith(credentials: { email: string; password: string }): Promise<string | null> {
  const attempt = await signIn(credentials.email, credentials.password);
  assert.equal(attempt.status, 200, "the seeded identity signs in");
  const response = await adminRequest(target(), "/api/auth/get-session", {
    method: "GET",
    headers: { cookie: attempt.cookie },
  });
  assertStatus(response, 200, "the session read answers");
  const body = (await response.json()) as { user?: { id?: string } } | null;
  return body?.user?.id ?? null;
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await target().database.db.select({ id: session.id }).from(session).where(eq(session.userId, userId));
  return rows.length;
}

type FakeProfile = { id: string; name: string; email: string };
type FakeIdp = { origin: string; close: () => Promise<void> };

function startFakeIdp(profile: FakeProfile): Promise<FakeIdp> {
  const server: Server = createServer((incoming, response) => {
    incoming.resume();
    const url = incoming.url ?? "";
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (incoming.method === "POST" && url.startsWith("/login/oauth/access_token")) {
      send(200, { access_token: "fake-provider-token", token_type: "bearer", scope: "read:user,user:email" });
      return;
    }
    if (incoming.method === "GET" && url === "/user") {
      send(200, { id: profile.id, login: "fake-octo", name: profile.name, email: profile.email, avatar_url: "" });
      return;
    }
    if (incoming.method === "GET" && url === "/user/emails") {
      send(200, [{ email: profile.email, primary: true, verified: true }]);
      return;
    }
    send(404, { error: "not_found" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.equal(typeof address === "object" && address !== null && "port" in address, true);
      const origin = `http://127.0.0.1:${(address as { port: number }).port}`;
      resolve({
        origin,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function routeProviderToIdp(origin: string): () => void {
  const real = globalThis.fetch;
  const realFetch = real.bind(globalThis);
  const routes: Record<string, string> = {
    "https://github.com/login/oauth/access_token": "/login/oauth/access_token",
    "https://api.github.com/user": "/user",
    "https://api.github.com/user/emails": "/user/emails",
  };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: unknown }).url ?? "");
    const route = routes[url];
    return realFetch((route === undefined ? input : `${origin}${route}`) as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .filter((value) => value !== "")
    .join("; ");
}

async function beginSocial(): Promise<{ state: string; cookie: string }> {
  const response = await adminRequest(target(), "/api/auth/sign-in/social", {
    method: "POST",
    headers: { origin: config().publicOrigin, "content-type": "application/json" },
    body: JSON.stringify({ provider: "github", callbackURL: "/dashboard", disableRedirect: true }),
  });
  assertStatus(response, 200, "the social sign-in begins");
  const payload = (await response.json()) as { url?: string };
  const state = new URL(String(payload.url)).searchParams.get("state");
  assert.equal(typeof state === "string" && state.length > 0, true, "the authorization URL carries a state");
  return { state: state as string, cookie: cookieHeader(response) };
}

type SocialOutcome = { location: string; cookie: string; sessionPairs: string[] };

async function finishSocial(account: SeededSocialAccount): Promise<SocialOutcome> {
  const idp = await startFakeIdp({ id: account.providerAccountId, name: "Social Login", email: account.email });
  const restore = routeProviderToIdp(idp.origin);
  try {
    const begun = await beginSocial();
    const query = new URLSearchParams({ code: "fake-authorization-code", state: begun.state });
    const response = await fetch(`${target().baseUrl}/api/auth/callback/github?${query.toString()}`, {
      redirect: "manual",
      headers: { cookie: begun.cookie },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    assert.equal(response.status, 302, "the callback redirects back to the application");
    const sessionPairs = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .filter((value) => value.startsWith(SESSION_VALUE_MARKER));
    return { location: response.headers.get("location") ?? "", cookie: sessionPair(response), sessionPairs };
  } finally {
    restore();
    await idp.close();
  }
}

before(async () => {
  const base = loadConfig(process.env);
  harness = await startAdminHarness({ ...base, secretEncryptionKey: KEY });
  await writeSecret(target().database.db, {
    name: providerSecretName("github"),
    value: GITHUB_SECRET,
    key: KEY,
  });
  await writeSetting(target().database.db, accessMethodsSetting, { value: accessDocument(), expectedRevision: null });
  administrator = await seedTrustedAccount(target().database, { role: "administrator", name: "Login Administrator" });
  member = await seedTrustedAccount(target().database, { name: "Login Member" });
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("with SSO off, password and social sign-in behave as they do today", async () => {
  await storeSsoConnection({ enabled: false, displayName: SSO_DISPLAY_NAME });

  assert.equal(await accountWith(actor(administrator)), actor(administrator).userId, "an administrator signs in");
  assert.equal(await accountWith(actor(member)), actor(member).userId, "a member signs in");

  const social = await seedSocialAccount("member");
  const outcome = await finishSocial(social);
  assert.equal(outcome.location, "/dashboard");
  assert.equal(outcome.cookie.length > 0, true, "a linked social account receives a usable session");
  assert.equal(await sessionCount(social.id), 1, "the social session is stored");

  const published = await capabilities();
  assert.equal("sso" in published, false, "a disabled connection is not published");
  assert.deepEqual(published.socialProviders, ["github"]);
});

integration("an enabled connection publishes its display name and the administrator-only alternative", async () => {
  await storeSsoConnection({ enabled: true, displayName: SSO_DISPLAY_NAME });

  const published = await capabilities();
  assert.deepEqual(published, {
    emailPassword: true,
    registration: false,
    socialProviders: ["github"],
    sso: {
      displayName: SSO_DISPLAY_NAME,
      fallbackAvailable: true,
      fallbackAdministratorsOnly: true,
    },
  });
  assert.deepEqual(Object.keys(published.sso ?? {}).sort(), [
    "displayName",
    "fallbackAdministratorsOnly",
    "fallbackAvailable",
  ]);

  const payload = JSON.stringify(published);
  for (const forbidden of [GITHUB_SECRET, GITHUB_CLIENT_ID, providerSecretName("github")]) {
    assert.equal(payload.includes(forbidden), false, "the login read never carries a credential");
  }
});

integration("with SSO on, an administrator signs in with a password and a member is refused generically", async () => {
  assert.equal(await sessionCount(actor(member).userId), 1, "the member keeps the session created before the change");

  const administratorAttempt = await signIn(actor(administrator).email, actor(administrator).password);
  assert.equal(administratorAttempt.status, 200, "an administrator still signs in with a password");
  assert.equal(
    await accountWith(actor(administrator)),
    actor(administrator).userId,
    "the administrator session is usable",
  );

  const before = await sessionCount(actor(member).userId);
  const refused = await signIn(actor(member).email, actor(member).password);
  assert.equal(refused.status, 401, "a member password sign-in is refused while SSO is on");
  assert.equal(refused.cookie, "", "a refused sign-in leaves no session cookie");
  assert.equal(await sessionCount(actor(member).userId), before, "a refused sign-in creates no session");

  const unknown = await signIn(`unknown-${randomUUID()}@example.test`, `unknown-password-${randomUUID()}`);
  assert.equal(unknown.status, 401, "an unknown address is refused");
  assert.deepEqual(
    { status: refused.status, body: refused.body },
    { status: unknown.status, body: unknown.body },
    "the refusal does not reveal whether the address exists",
  );

  const wrongPassword = await signIn(actor(member).email, `wrong-${randomUUID()}`);
  assert.deepEqual(
    { status: wrongPassword.status, body: wrongPassword.body },
    { status: refused.status, body: refused.body },
    "an existing member is refused exactly like an unknown address and a wrong password",
  );

  const administratorWrongPassword = await signIn(actor(administrator).email, `wrong-${randomUUID()}`);
  assert.deepEqual(
    { status: administratorWrongPassword.status, body: administratorWrongPassword.body },
    { status: refused.status, body: refused.body },
    "the refusal is indistinguishable from the library's own failed password check",
  );
});

integration("with SSO on, a social sign-in that ends at a member leaves no usable session", async () => {
  const socialMember = await seedSocialAccount("member");
  const memberOutcome = await finishSocial(socialMember);
  assert.equal(memberOutcome.location, "/dashboard");
  for (const pair of memberOutcome.sessionPairs) {
    assert.equal(pair, SESSION_VALUE_MARKER, "the destroyed session leaves only an expiring cookie");
  }
  assert.equal(memberOutcome.cookie, "", "no usable session cookie leaves the callback");
  assert.equal(await sessionCount(socialMember.id), 0, "the session created by the callback is destroyed");

  const socialAdministrator = await seedSocialAccount("administrator");
  const administratorOutcome = await finishSocial(socialAdministrator);
  assert.equal(administratorOutcome.location, "/dashboard");
  assert.equal(administratorOutcome.cookie.length > 0, true, "an administrator keeps the social session");
  assert.equal(await sessionCount(socialAdministrator.id), 1);

  const sessionRead = await adminRequest(target(), "/api/auth/get-session", {
    method: "GET",
    headers: { cookie: administratorOutcome.cookie },
  });
  assertStatus(sessionRead, 200, "the administrator session is usable");
  const body = (await sessionRead.json()) as { user?: { id?: string } } | null;
  assert.equal(body?.user?.id, socialAdministrator.id);
});

integration("the fallback parameter changes nothing the server enforces", async () => {
  const plain = await signIn(actor(member).email, actor(member).password);
  const parameter = await signIn(actor(member).email, actor(member).password, `${SIGN_IN_PATH}?fallback=1`);
  assert.deepEqual(
    { status: parameter.status, body: parameter.body, cookie: parameter.cookie },
    { status: plain.status, body: plain.body, cookie: plain.cookie },
    "a member is refused with or without the parameter",
  );

  const administratorPlain = await signIn(actor(administrator).email, actor(administrator).password);
  const administratorParameter = await signIn(
    actor(administrator).email,
    actor(administrator).password,
    `${SIGN_IN_PATH}?fallback=1`,
  );
  assert.equal(administratorParameter.status, 200, "the parameter does not block an administrator");
  assert.equal(administratorPlain.status, 200);

  const authenticated = await adminRequest(target(), "/api/auth/get-session", {
    method: "GET",
    headers: { cookie: administratorPlain.cookie },
  });
  const authenticatedParameter = await adminRequest(target(), "/api/auth/get-session?fallback=1", {
    method: "GET",
    headers: { cookie: administratorPlain.cookie },
  });
  assertStatus(authenticated, 200, "the authenticated read answers");
  assertStatus(authenticatedParameter, 200, "the authenticated read answers with the parameter");
  assert.deepEqual(await authenticatedParameter.json(), await authenticated.json());

  assert.deepEqual(await capabilities("?fallback=1"), await capabilities(), "the login read ignores the parameter");
});
