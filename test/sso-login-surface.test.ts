import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import {
  getCapabilities,
  signIn,
  ssoSignIn,
  SSO_PROVIDER_ID,
  type Capabilities,
} from "../apps/dashboard/src/auth-client.ts";
import {
  EMERGENCY_COPY,
  EMERGENCY_TITLE,
  FALLBACK_PATH,
  loginSurface,
  SSO_DEACTIVATED_ACCOUNT,
  SSO_DOMAIN_NOT_ALLOWED,
  SSO_REFUSED,
  SSO_TENANT_MISMATCH,
  SSO_UNKNOWN_ACCOUNT,
  ssoFailure,
} from "../apps/dashboard/src/login-methods.ts";
import { SSO_CONNECTION_PROVIDER_ID, ssoPinnedTenant } from "../apps/api/src/settings/sso-connection.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
const SCREEN = "../apps/dashboard/src/AuthScreen.tsx";
const CONTINUATION = "../apps/dashboard/src/LoginPage.tsx";

function useFetch(reply: (call: Call, index: number) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return reply(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function read(path: string): string {
  const file = new URL(path, import.meta.url);
  assert.ok(existsSync(file), `missing ${path}`);
  return readFileSync(file, "utf8");
}

function section(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `the source defines ${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `${from} ends before ${to}`);
  return source.slice(start, end);
}

function methods(overrides: Partial<Capabilities> = {}): Capabilities {
  return { emailPassword: true, registration: false, socialProviders: ["github"], ...overrides };
}

const CONNECTION = { displayName: "Acme Workforce", fallbackAvailable: true };

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the connection is one action labelled with its display name, asking for no email", () => {
  const surface = loginSurface(methods({ sso: CONNECTION }), "");
  assert.ok(surface.connection, "the connection reaches the page");
  assert.equal(surface.connection.label, "Acme Workforce");
  assert.equal(surface.connection.access !== null, true, "the emergency alternative is named");
  assert.equal(surface.password, false, "no password form is offered first");
  assert.deepEqual(surface.providers, [], "no social button is offered");
  assert.equal(surface.fallbackLink, true);

  const unnamed = loginSurface(methods({ sso: { displayName: null, fallbackAvailable: false } }), "");
  assert.ok(unnamed.connection);
  assert.equal(unnamed.connection.label, "Single sign-on", "a connection without a name is still labelled");
  assert.equal(unnamed.connection.access, null, "an alternative that does not exist is never promised");

  const screen = read(SCREEN);
  const panel = section(screen, "export function ConnectionPanel", "export function EmergencyPanel");
  assert.match(panel, /<Button[^>]*type="button"/, "the connection is the page's primary action");
  assert.match(panel, /Sign in with \{notice\.label\}/, "the action carries the displayed name");
  assert.doesNotMatch(panel, /<Input|type="email"|auth-email/, "the connection asks for no email first");
  assert.match(screen, /const connectionSignIn = async \(\)[\s\S]*ssoSignIn\(/, "the action starts the flow");

  for (const path of [SCREEN, CONTINUATION, "../apps/dashboard/src/login-methods.ts"]) {
    assert.doesNotMatch(read(path), /not available yet in this build/, `${path} no longer disclaims the sign-in`);
  }
});

test("the fallback parameter reveals the conventional methods with the emergency copy", () => {
  for (const search of ["?fallback=1", "?return=%2Flibrary&fallback=1"]) {
    const surface = loginSurface(methods({ sso: CONNECTION }), search);
    assert.ok(surface.emergency, `${search} reveals the alternative`);
    assert.equal(surface.emergency.title, EMERGENCY_TITLE);
    assert.equal(surface.emergency.copy, EMERGENCY_COPY);
    assert.equal(surface.password, true);
    assert.deepEqual(surface.providers, ["github"]);
    assert.equal(surface.fallbackLink, false, "the alternative is already on screen");
  }

  assert.match(EMERGENCY_TITLE, /administrator/i);
  assert.match(EMERGENCY_COPY, /only administrator accounts/i);
  assert.match(EMERGENCY_COPY, /grants no access by itself/);

  for (const search of ["", "?", "?return=%2Flibrary", "?fallback=0", "?fallback=true", "?fallback"]) {
    const surface = loginSurface(methods({ sso: CONNECTION }), search);
    assert.equal(surface.password, false, `${search || "(none)"} hides the password form`);
    assert.deepEqual(surface.providers, [], `${search || "(none)"} hides the social buttons`);
    assert.equal(surface.emergency, null, `${search || "(none)"} states no emergency copy`);
  }
});

test("the page starts the connection flow with the provider this instance publishes", () => {
  assert.equal(SSO_PROVIDER_ID, SSO_CONNECTION_PROVIDER_ID, "the page and the server share one provider id");
  assert.equal(FALLBACK_PATH, "/login?fallback=1");
  assert.doesNotMatch(read(SCREEN), /emailPassword/, "the page reads the answered methods, not the raw payload");
});

test("starting the connection flow posts the provider, the return path and the refusal path", async () => {
  const calls = useFetch(() => json({ url: "https://idp.example.test/tenant-a/authorize?state=abc", redirect: true }));
  const started = await ssoSignIn("/library", "/login?return=%2Flibrary");
  assert.deepEqual(started, { ok: true, url: "https://idp.example.test/tenant-a/authorize?state=abc" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/auth/sign-in/sso");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    providerId: SSO_PROVIDER_ID,
    callbackURL: "/library",
    errorCallbackURL: "/login?return=%2Flibrary",
  });

  useFetch(() => json({ error: "not_found" }, 404));
  const refused = await ssoSignIn("/library", "/login");
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.restartable, false);
  assert.match(refused.ok === false ? refused.error : "", /single sign-on/i, "a refusal is stated, not guessed");

  useFetch(() => new Response("", { status: 200 }));
  const unreadable = await ssoSignIn("/library", "/login");
  assert.equal(unreadable.ok, false, "an answer without a redirect is never followed");
});

test("a refusal that came back from the identity provider names the administrator", () => {
  assert.equal(ssoFailure(""), "");
  assert.equal(ssoFailure("?return=%2Flibrary"), "", "the ordinary login page states no refusal");
  assert.equal(ssoFailure("?error=sso_account_unknown"), SSO_UNKNOWN_ACCOUNT);
  assert.equal(ssoFailure("?error=sso_account_deactivated"), SSO_DEACTIVATED_ACCOUNT);
  assert.equal(ssoFailure("?error=sso_domain_not_allowed"), SSO_DOMAIN_NOT_ALLOWED);
  assert.equal(ssoFailure("?error=sso_tenant_mismatch"), SSO_TENANT_MISMATCH);
  assert.equal(ssoFailure("?error=invalid_provider"), SSO_REFUSED);

  for (const message of [
    SSO_UNKNOWN_ACCOUNT,
    SSO_DEACTIVATED_ACCOUNT,
    SSO_DOMAIN_NOT_ALLOWED,
    SSO_TENANT_MISMATCH,
    SSO_REFUSED,
  ]) {
    assert.match(message, /administrator/i, "every refusal tells the person who can unblock them");
  }
  assert.match(SSO_DOMAIN_NOT_ALLOWED, /accept any account/i, "the domain refusal names the explicit acceptance");
  assert.doesNotMatch(SSO_REFUSED, /password|credential|token/i);

  const screen = read(SCREEN);
  assert.match(screen, /useState\(\(\) => ssoFailure\(search\)\)/, "the refusal reaches the page as a message");
  assert.match(screen, /\{error \?/, "the refusal is rendered");
});

test("the tenant pin is the tenant the saved issuer names", () => {
  const tenantId = "6f8c8f3a-1f4e-4c26-9c15-58a2a0a0b7d1";
  assert.equal(ssoPinnedTenant(`https://login.microsoftonline.com/${tenantId}/v2.0`), tenantId);
  assert.equal(ssoPinnedTenant(`https://login.microsoftonline.com/${tenantId}/v2.0/`), tenantId);
  assert.equal(ssoPinnedTenant(`https://sts.windows.net/${tenantId}/`), tenantId);
  assert.equal(ssoPinnedTenant("https://idp.example.test/tenant-a"), "tenant-a");
  assert.equal(ssoPinnedTenant("https://idp.example.test/Realm-A"), "realm-a", "the pin compares in one case");
  assert.equal(ssoPinnedTenant("https://idp.example.test"), null, "an issuer that names no tenant pins none");
  assert.equal(ssoPinnedTenant("https://idp.example.test/"), null);
  assert.equal(ssoPinnedTenant("not a url"), null);
});

test("the continuation page carries the connection action and comes back with its query", () => {
  const page = read(CONTINUATION);
  assert.match(page, /const continuation = `\$\{window\.location\.pathname\}\$\{window\.location\.search\}`/);
  assert.match(page, /ssoSignIn\(continuation/, "the authorization request survives the round trip");
  assert.match(page, /<ConnectionPanel/, "the continuation page offers the same single action");
  assert.match(page, /fallbackHref=\{fallbackHref\}/, "the emergency alternative keeps the query too");
  assert.match(page, /\{surface\.password \?/, "the credential form is gated by the answered methods");
});

test("the connection reaches the page through the existing capabilities read", async () => {
  const calls = useFetch(() =>
    json({
      emailPassword: true,
      registration: false,
      socialProviders: [],
      sso: { displayName: "Acme Workforce", fallbackAvailable: true, fallbackAdministratorsOnly: true },
    }),
  );
  assert.deepEqual(await getCapabilities(), {
    ok: true,
    value: {
      emailPassword: true,
      registration: false,
      socialProviders: [],
      sso: { displayName: "Acme Workforce", fallbackAvailable: true },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/auth/capabilities");
  assert.equal(JSON.stringify(calls[0]?.init).includes("clientSecret"), false);

  useFetch(() => json({ emailPassword: true, registration: false, socialProviders: ["github"] }));
  const plain = await getCapabilities();
  assert.equal(JSON.stringify(plain).includes("sso"), false, "an instance without a connection answers as before");
});

test("a refused administrator-only password sign-in still reads like any rejected credential", async () => {
  useFetch(() => json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, 401));
  const refused = await signIn({ email: "administrator@example.test", password: "wrong-password" });
  const message = refused.ok === false ? refused.error : "";
  assert.equal(message, "That email and password did not match an account.");
  assert.doesNotMatch(message, /administrator|emergency|fallback/i);
});
