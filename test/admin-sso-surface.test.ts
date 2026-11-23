import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { ADMIN_SECTIONS, adminSectionPath } from "../apps/dashboard/src/admin-entry.ts";
import {
  SSO_REFUSAL_CODES,
  addDomain,
  buildUpdateSsoPayload,
  draftFromConfiguration,
  parseScopes,
  parseSsoConnectionConfiguration,
  readinessStatement,
  readSsoConnectionConfiguration,
  removeDomain,
  saveSsoConnection,
  scopesText,
  ssoRefusalMessage,
  updateDomain,
  type SsoConnectionConfiguration,
  type SsoConnectionDraft,
} from "../apps/dashboard/src/admin-sso-client.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
const MUTATION_ORIGIN = "http://127.0.0.1:5173";
const WARNING = "Every account the identity provider authenticates will be able to sign in.";
const PAGE = "../apps/dashboard/src/AdminSsoPage.tsx";
const CLIENT = "../apps/dashboard/src/admin-sso-client.ts";
const MAIN = "../apps/dashboard/src/main.tsx";
const ACCESS_PAGE = "../apps/dashboard/src/AdminAccessPage.tsx";
const ADMIN_SHELL = "../apps/dashboard/src/components/app/admin-shell.tsx";

const read = (path: string): string => {
  const file = new URL(path, import.meta.url);
  assert.ok(existsSync(file), `missing ${path}`);
  return readFileSync(file, "utf8");
};

function useFetch(reply: (call: Call, index: number) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return reply(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const headers = (call: Call | undefined): Record<string, string> =>
  (call?.init.headers ?? {}) as Record<string, string>;

const CONNECTION = {
  enabled: false,
  displayName: "Acme Workforce",
  issuer: "https://idp.example.test/tenant-a",
  clientId: "artiflow-client",
  credentialConfigured: true,
  scopes: ["openid", "profile", "email"],
  jitProvisioning: true,
  allowedDomains: ["acme.example.test", "second.example.test"],
  acceptAnyAccount: false,
  acceptAnyAccountWarning: WARNING,
};

const storedBody = (overrides: Record<string, unknown> = {}): unknown => ({
  revision: 3,
  connection: { ...CONNECTION },
  redirectUri: "https://artiflow.example.test/api/auth/sso/callback/artiflow",
  readiness: { signInAvailable: false },
  provenance: { source: "administrator", at: "2026-11-20T10:00:00.000Z" },
  ...overrides,
});

function draft(overrides: Partial<SsoConnectionDraft> = {}): SsoConnectionDraft {
  return { ...draftFromConfiguration(storedBody() as SsoConnectionConfiguration), ...overrides };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the connection page has its own route before the 404 and lives inside the administration shell", () => {
  const main = read(MAIN);
  assert.match(main, /from "\.\/AdminSsoPage\.tsx"/);
  assert.match(main, /path === "\/admin\/sso"/);
  const page = main.indexOf("<AdminSsoPage />");
  const notFound = main.indexOf("<NotFoundPage />");
  assert.ok(page > 0, "main.tsx must render <AdminSsoPage />");
  assert.ok(notFound > page, "the /admin/sso branch must precede the NotFoundPage fallback");

  const rendered = read(PAGE);
  assert.match(rendered, /<AdminShell section="sso" gate=\{load\}/);
  assert.doesNotMatch(rendered, /BareShell/);
  assert.doesNotMatch(rendered, /AppShell|LIBRARY_LINKS|NavItem/);

  assert.equal(adminSectionPath("sso"), "/admin/sso");
  assert.ok(
    ADMIN_SECTIONS.some((section) => section.key === "sso" && section.href === "/admin/sso"),
    "the connection has its own entry in the administration navigation",
  );
  assert.match(read(ACCESS_PAGE), /href="\/admin\/sso"/);
  assert.match(read(ADMIN_SHELL), /ADMIN_SECTIONS/);
});

test("a non-administrator is refused by the shell and never sees the form", async () => {
  useFetch(() => json({ error: "administrator_required" }, 403));
  const result = await readSsoConnectionConfiguration();
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "administrator_required");
  assert.equal(result.ok === false && result.signInRequired, false);
  assert.match(result.ok === false ? result.error : "", /administrator/i);

  const page = read(PAGE);
  assert.match(page, /useAdminConfiguration\(queryKeys\.adminSso, \(\) => readSsoConnectionConfiguration\(\)\)/);
  assert.match(
    read("../apps/dashboard/src/query/held.ts"),
    /setGate\(\{ kind: "refused", message: query\.data\.error, signInRequired: query\.data\.signInRequired \}\)/,
  );
  assert.equal((page.match(/<form/g) ?? []).length, 0, "the page never renders a bare form");
});

test("a sessionless visitor is sent to sign in and returns to the connection page", async () => {
  useFetch(() => json({ error: "sign_in_required" }, 401));
  const result = await readSsoConnectionConfiguration();
  assert.equal(result.ok === false && result.code, "unauthorized");
  assert.equal(result.ok === false && result.signInRequired, true);
  assert.match(result.ok === false ? result.error : "", /sign in/i);
  assert.equal(`/login?return=${encodeURIComponent(adminSectionPath("sso"))}`, "/login?return=%2Fadmin%2Fsso");
});

test("the stored connection parses, the draft starts from it and the credential is never prefilled", () => {
  const parsed = parseSsoConnectionConfiguration(storedBody());
  assert.deepEqual(parsed?.connection, CONNECTION);
  assert.equal(parsed?.redirectUri, "https://artiflow.example.test/api/auth/sso/callback/artiflow");
  assert.deepEqual(parsed?.readiness, { signInAvailable: false });

  const empty = parseSsoConnectionConfiguration(
    storedBody({
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
        acceptAnyAccountWarning: WARNING,
      },
      provenance: null,
    }),
  );
  assert.equal(empty?.revision, null, "an absent document parses");
  assert.equal(empty?.provenance, null);

  const parsedDraft = draftFromConfiguration(parsed as SsoConnectionConfiguration);
  assert.deepEqual(parsedDraft, {
    enabled: false,
    displayName: "Acme Workforce",
    issuer: "https://idp.example.test/tenant-a",
    clientId: "artiflow-client",
    clientSecret: "",
    scopes: "openid profile email",
    jitProvisioning: true,
    allowedDomains: ["acme.example.test", "second.example.test"],
    acceptAnyAccount: false,
  });
  assert.equal(JSON.stringify(parsedDraft).includes("credentialConfigured"), false);

  for (const unusable of [
    storedBody({ revision: 0 }),
    storedBody({ redirectUri: "" }),
    storedBody({ readiness: {} }),
    storedBody({ connection: { ...CONNECTION, clientId: undefined } }),
    storedBody({ connection: { ...CONNECTION, scopes: "openid" } }),
    storedBody({ connection: { ...CONNECTION, allowedDomains: [7] } }),
    storedBody({ connection: { ...CONNECTION, acceptAnyAccountWarning: "" } }),
  ]) {
    assert.equal(parseSsoConnectionConfiguration(unusable), null);
  }

  useFetch(() => json(storedBody({ connection: { ...CONNECTION, issuer: undefined } })));
  return readSsoConnectionConfiguration().then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "unreadable_answer");
  });
});

test("the scopes are typed as text and the domain list is edited as a list", () => {
  assert.deepEqual(parseScopes("openid profile,email"), ["openid", "profile", "email"]);
  assert.deepEqual(parseScopes("  openid ,  "), ["openid"]);
  assert.equal(scopesText(["openid", "profile"]), "openid profile");
  assert.deepEqual(addDomain(["acme.example.test"]), ["acme.example.test", ""]);
  assert.deepEqual(updateDomain(["acme.example.test", ""], 1, " second.example.test "), [
    "acme.example.test",
    "second.example.test",
  ]);
  assert.deepEqual(removeDomain(["acme.example.test", "second.example.test"], 0), ["second.example.test"]);

  const page = read(PAGE);
  assert.match(page, /draft\.allowedDomains\.map\(/);
  assert.match(page, /addDomain\(draft\.allowedDomains\)/);
  assert.match(page, /removeDomain\(draft\.allowedDomains, index\)/);
  assert.match(page, /updateDomain\(draft\.allowedDomains, index, event\.target\.value\)/);
  assert.match(page, /Add domain/);
  assert.match(page, /Remove/);
  assert.match(page, /parseScopes\(draft\.scopes\)/);
});

test("a save sends the revision, the whole document and only the credential the administrator typed", async () => {
  const calls = useFetch(() => json(storedBody({ revision: 4 })));
  const saved = await saveSsoConnection(draft(), 3);
  assert.equal(saved.ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call?.url, "/api/admin/sso");
  assert.equal(call?.init.method, "PUT");
  assert.equal(headers(call)["content-type"], "application/json");
  assert.equal(headers(call)["origin"], MUTATION_ORIGIN, "a cookie mutation carries the origin");
  assert.deepEqual(JSON.parse(String(call?.init.body)), {
    revision: 3,
    enabled: false,
    displayName: "Acme Workforce",
    issuer: "https://idp.example.test/tenant-a",
    clientId: "artiflow-client",
    scopes: ["openid", "profile", "email"],
    jitProvisioning: true,
    allowedDomains: ["acme.example.test", "second.example.test"],
    acceptAnyAccount: false,
  });
  assert.match(read(PAGE), /saveSsoConnection\(draft, configuration\.revision\)/);

  const typed = useFetch(() => json(storedBody({ revision: 5 })));
  const withSecret = await saveSsoConnection(draft({ clientSecret: "typed-once" }), 4);
  assert.equal(withSecret.ok, true);
  assert.equal(typed.length, 1);
  const sent = String(typed[0]?.init.body);
  assert.equal(JSON.parse(sent).clientSecret, "typed-once");
  for (const forbidden of ["credentialConfigured", "clientSecretName", "secretName", "ciphertext"]) {
    assert.equal(sent.includes(forbidden), false, `the change carries no ${forbidden}`);
  }
});

test("the page states the readiness rule, shows the redirect URI with a copy action and the warning", () => {
  const blocked = readinessStatement({ signInAvailable: false });
  assert.ok(blocked !== null);
  assert.match(blocked, /lock every non-administrator out of password and social sign-in/);
  assert.match(blocked, /enabled once sign-in through it exists/);
  assert.equal(readinessStatement({ signInAvailable: true }), null);

  const page = read(PAGE);
  assert.match(page, /readinessStatement\(configuration\.readiness\)/);
  assert.match(page, /configuration\.redirectUri/);
  assert.match(page, /navigator\.clipboard\?\.writeText\(configuration\.redirectUri\)/);
  assert.match(page, /Copy address/);
  assert.match(page, /Register this address at your identity provider/);
  assert.match(page, /acceptAnyAccountWarning/);
  assert.doesNotMatch(page, /console\.|localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(read(CLIENT), /console\.|localStorage|sessionStorage|document\.cookie/);
});

test("every named refusal is rendered in its own words and never as the raw code", async () => {
  const cases: [string, RegExp][] = [
    ["administrator_required", /administrator/i],
    ["invalid_body", /incomplete/i],
    ["secret_encryption_unconfigured", /encryption key/i],
    ["sso_sign_in_unavailable", /lock every non-administrator out of password and social sign-in/i],
    ["sso_display_name_required", /display name/i],
    ["sso_client_id_required", /client id/i],
    ["sso_credential_required", /client secret/i],
    ["sso_issuer_insecure", /https/i],
    ["sso_issuer_invalid", /concrete|placeholder/i],
    ["sso_issuer_templated", /single-tenant/i],
    ["sso_issuer_mismatch", /advertis|publishes/i],
    ["sso_discovery_unreachable", /could not be reached/i],
    ["sso_discovery_invalid", /discovery/i],
    ["sso_scopes_invalid", /requested scope/i],
    ["sso_domain_required", /allowed domain/i],
    ["sso_domain_invalid", /bare hostname/i],
    ["revision_conflict", /save again/i],
  ];
  for (const [code, message] of cases) {
    const text = ssoRefusalMessage(code);
    assert.match(text, message, `${code} names what to do`);
    assert.equal(text.includes(code), false, `${code} is never rendered raw`);
  }
  assert.match(ssoRefusalMessage("sso_issuer_templated"), /tenant-scoped issuer/);
  assert.match(ssoRefusalMessage("anonymous"), /recognizes/);
  for (const [code] of cases) {
    assert.equal(SSO_REFUSAL_CODES.includes(code), true, `${code} is part of the closed refusal list`);
  }
  assert.equal(SSO_REFUSAL_CODES.includes("access.methods.updated"), false);

  useFetch(() => json({ error: "sso_sign_in_unavailable" }, 400));
  const result = await saveSsoConnection(draft({ enabled: true }), 3);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "sso_sign_in_unavailable");
  assert.match(read(PAGE), /role="alert"/);
  assert.match(read(PAGE), /setError\(result\.error\)/);
});

test("a revision conflict reloads what was stored and asks for a reviewed retry", async () => {
  const calls = useFetch((_call, index) =>
    index === 0
      ? json({ error: "revision_conflict" }, 409)
      : json(storedBody({ revision: 7, connection: { ...CONNECTION, displayName: "Renamed" } })),
  );
  const result = await saveSsoConnection(draft(), 3);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "revision_conflict");
  assert.equal(result.ok === false && result.conflict, true);
  assert.equal(calls.length, 2, "the conflict retries by reading the stored document");
  assert.equal(calls[1]?.init.method, "GET");
  const refreshed = result.ok === false ? result.refreshed : null;
  assert.equal(refreshed?.revision, 7);
  assert.equal(refreshed?.connection.displayName, "Renamed");

  const page = read(PAGE);
  assert.match(page, /result\.conflict && result\.refreshed !== null/);
  assert.match(page, /setConfiguration\(result\.refreshed\)/);
  assert.match(page, /setDraft\(draftFromConfiguration\(result\.refreshed\)\)/);
});

test("the payload keeps the stored credential absent when the field is left empty", () => {
  const payload = buildUpdateSsoPayload(draft({ clientSecret: "" }), 3);
  assert.equal("clientSecret" in payload, false);
  assert.deepEqual(payload.scopes, ["openid", "profile", "email"]);
  assert.deepEqual(buildUpdateSsoPayload(draft({ allowedDomains: [" ", "acme.example.test"] }), 3).allowedDomains, [
    "acme.example.test",
  ]);
  assert.deepEqual(buildUpdateSsoPayload(draft({ scopes: "openid  email" }), 3).scopes, ["openid", "email"]);
  assert.equal(buildUpdateSsoPayload(draft({ displayName: " Acme Workforce " }), 3).displayName, "Acme Workforce");
});
