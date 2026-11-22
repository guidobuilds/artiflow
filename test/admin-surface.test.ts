import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { adminSectionPath } from "../apps/dashboard/src/admin-entry.ts";
import {
  ACCESS_PROVIDERS,
  REGISTRATION_NOTES,
  accessRefusalMessage,
  buildUpdateAccessPayload,
  credentialStateLabel,
  draftFromConfiguration,
  enabledMethodsLabel,
  parseAccessConfiguration,
  provenanceLabel,
  readAccessConfiguration,
  registrationEntries,
  saveAccessConfiguration,
  type AccessConfiguration,
  type AccessDraft,
} from "../apps/dashboard/src/admin-access-client.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
const MUTATION_ORIGIN = "http://127.0.0.1:5173";
const TYPED_INPUT = "replacement-input";
const PAGE = "../apps/dashboard/src/AdminAccessPage.tsx";
const CLIENT = "../apps/dashboard/src/admin-access-client.ts";
const MAIN = "../apps/dashboard/src/main.tsx";
const SHELL = "../apps/dashboard/src/components/app/app-shell.tsx";
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

const PROVIDER = { enabled: false, clientId: "", credentialConfigured: false };
const PUBLIC_ORIGIN = "http://127.0.0.1:5173";
const REGISTRATION = {
  origin: PUBLIC_ORIGIN,
  redirectUris: {
    google: `${PUBLIC_ORIGIN}/api/auth/callback/google`,
    github: `${PUBLIC_ORIGIN}/api/auth/callback/github`,
  },
};

const storedBody = (overrides: Record<string, unknown> = {}): unknown => ({
  revision: 3,
  passwordEnabled: true,
  providers: {
    google: { ...PROVIDER },
    github: { enabled: true, clientId: "github-client-id", credentialConfigured: true },
  },
  registration: { ...REGISTRATION, redirectUris: { ...REGISTRATION.redirectUris } },
  provenance: { source: "administrator", at: "2026-11-20T10:00:00.000Z" },
  ...overrides,
});

function draft(secret = ""): AccessDraft {
  return {
    passwordEnabled: true,
    providers: {
      google: { enabled: false, clientId: "", clientSecret: "" },
      github: { enabled: true, clientId: "  github-client-id  ", clientSecret: secret },
    },
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the administration surface has its own route, before the 404, and stays out of member navigation", () => {
  const main = read(MAIN);
  assert.match(main, /from "\.\/AdminAccessPage\.tsx"/);
  assert.match(main, /path === "\/admin\/access"/);
  const admin = main.indexOf("<AdminAccessPage />");
  const notFound = main.indexOf("<NotFoundPage />");
  assert.ok(admin > 0, "main.tsx must render <AdminAccessPage />");
  assert.ok(notFound > admin, "the /admin/access branch must precede the NotFoundPage fallback");

  const page = read(PAGE);
  const adminShell = read(ADMIN_SHELL);
  assert.doesNotMatch(adminShell, /BareShell/);
  assert.doesNotMatch(adminShell, /<AppShell|LIBRARY_LINKS/);
  assert.match(adminShell, />Administration</);
  assert.match(adminShell, /aria-label="Administration"/);
  assert.doesNotMatch(page, /BareShell/);
  assert.match(page, /<AdminShell section="access" gate=\{load\}/);
  assert.doesNotMatch(page, /AppShell|LIBRARY_LINKS/);
  assert.doesNotMatch(page, /NavItem/);
  assert.doesNotMatch(read(SHELL), /\/admin/);
});

test("a non-administrator sees a refusal with a way back to the product, never the form", async () => {
  useFetch(() => json({ error: "administrator_required" }, 403));
  const result = await readAccessConfiguration();
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "administrator_required");
  assert.equal(result.ok === false && result.signInRequired, false);
  assert.match(result.ok === false ? result.error : "", /administrator/i);

  const page = read(PAGE);
  const adminShell = read(ADMIN_SHELL);
  const refusedAt = adminShell.indexOf('gate.kind !== "ready"');
  assert.ok(refusedAt > 0, "the shell answers a gate that is not ready instead of rendering the page");
  assert.ok(
    refusedAt < adminShell.indexOf("<AdminFrame section={section}>"),
    "the refusal is decided before the administration navigation or any page content renders",
  );
  assert.match(adminShell, /<p role="alert"/);
  assert.match(adminShell, /This area is for administrators\./);
  assert.match(adminShell, /Back to your library/);
  assert.match(adminShell, /href="\/"/);
  assert.equal((page.match(/<form/g) ?? []).length, 0, "the refusal path must not render the configuration form");
  assert.match(page, /<AdminShell section="access" gate=\{load\}/);
});

test("a sessionless visitor is sent to sign in and returns to the page afterwards", async () => {
  useFetch(() => json({ error: "sign_in_required" }, 401));
  const result = await readAccessConfiguration();
  assert.equal(result.ok === false && result.code, "unauthorized");
  assert.equal(result.ok === false && result.signInRequired, true);
  assert.match(result.ok === false ? result.error : "", /sign in/i);

  const adminShell = read(ADMIN_SHELL);
  assert.match(adminShell, /gate\.kind === "refused" && gate\.signInRequired/);
  assert.match(adminShell, /"Sign in to open this page\."/);
  assert.match(adminShell, /href=\{signInHref\}/);
  assert.match(
    adminShell,
    /const signInHref = `\/login\?return=\$\{encodeURIComponent\(adminSectionPath\(section\)\)\}`;/,
  );
  assert.equal(adminSectionPath("access"), "/admin/access");
  assert.equal(
    `/login?return=${encodeURIComponent(adminSectionPath("access"))}`,
    "/login?return=%2Fadmin%2Faccess",
    "the sign-in link must carry the encoded administration return path",
  );
});

test("the stored configuration renders credential presence and never a credential value", () => {
  const parsed = parseAccessConfiguration(storedBody());
  assert.ok(parsed !== null, "a stored answer parses");
  assert.deepEqual(parsed?.providers.github, {
    enabled: true,
    clientId: "github-client-id",
    credentialConfigured: true,
  });
  for (const provider of ["google", "github"] as const) {
    assert.deepEqual(Object.keys(parsed?.providers[provider] ?? {}).sort(), [
      "clientId",
      "credentialConfigured",
      "enabled",
    ]);
    assert.equal(draftFromConfiguration(parsed as AccessConfiguration).providers[provider].clientSecret, "");
  }
  assert.equal(credentialStateLabel(true), "Configured");
  assert.equal(credentialStateLabel(false), "Not configured");
  assert.equal(
    provenanceLabel({ source: "administrator", at: "2026-11-20T10:00:00.000Z" }),
    "Set by an administrator on 2026-11-20.",
  );
  assert.equal(
    provenanceLabel({ source: "environment", at: "2026-11-20T10:00:00.000Z" }),
    "Adopted from the environment on 2026-11-20.",
  );

  const page = read(PAGE);
  assert.match(page, /credentialStateLabel\(/);
  assert.match(page, /<Tag on=\{configuration\.providers\[provider\.name\]\.credentialConfigured\}>/);
  assert.match(page, /type="password"/);
  assert.match(page, /Leave empty to keep the stored credential/);
  assert.match(page, /provenanceLabel\(configuration\.provenance\)/);
  assert.match(page, /value=\{draft\.providers\[provider\.name\]\.clientSecret\}/);
  assert.doesNotMatch(page, /configuration\.providers\[provider\.name\]\.clientSecret/);
  assert.doesNotMatch(page, /console\.|localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(read(CLIENT), /console\.|localStorage|sessionStorage|document\.cookie/);
});

test("a save sends the revision, both providers and only the credential the administrator typed", async () => {
  const calls = useFetch(() => json(storedBody({ revision: 4 })));
  const saved = await saveAccessConfiguration(draft(TYPED_INPUT), 3);
  assert.equal(saved.ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call?.url, "/api/admin/access");
  assert.equal(call?.init.method, "PUT");
  assert.equal(headers(call)["origin"], MUTATION_ORIGIN);
  assert.equal(headers(call)["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(call?.init.body)), {
    revision: 3,
    passwordEnabled: true,
    providers: {
      google: { enabled: false, clientId: "" },
      github: { enabled: true, clientId: "github-client-id", clientSecret: TYPED_INPUT },
    },
  });
  assert.deepEqual(buildUpdateAccessPayload(draft(), 3).providers.github, {
    enabled: true,
    clientId: "github-client-id",
  });
  assert.ok(saved.ok);
  assert.equal(
    JSON.stringify(saved.ok ? saved.value : null).includes(TYPED_INPUT),
    false,
    "a save never echoes the credential",
  );
  assert.equal(draftFromConfiguration(saved.ok ? saved.value : parsedOfTest()).providers.github.clientSecret, "");
  assert.equal(
    enabledMethodsLabel(saved.ok ? saved.value : parsedOfTest()),
    "Password and GitHub sign-in are enabled.",
  );
  assert.deepEqual(
    ACCESS_PROVIDERS.map((provider) => provider.label),
    ["Google", "GitHub"],
  );
  assert.match(read(PAGE), /Saved\. \$\{enabledMethodsLabel\(result\.value\)\}/);
});

test("an answer that cannot be read leaves the page empty of assumptions", async () => {
  useFetch(() => json({ revision: 3, passwordEnabled: true, providers: { google: PROVIDER } }));
  const result = await readAccessConfiguration();
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "unreadable_answer");
});

test("every named refusal is rendered in its own words, without the raw code", async () => {
  const cases: [number, string, RegExp][] = [
    [400, "provider_client_id_required", /client id/i],
    [400, "provider_credential_required", /client secret/i],
    [400, "secret_encryption_unconfigured", /encryption key/i],
    [403, "administrator_required", /administrator/i],
    [400, "invalid_body", /incomplete/i],
  ];
  for (const [status, code, message] of cases) {
    useFetch(() => json({ error: code }, status));
    const result = await saveAccessConfiguration(draft(TYPED_INPUT), 3);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, code);
    assert.match(result.ok === false ? result.error : "", message);
    assert.equal(result.ok === false && result.error.includes(code), false);
    assert.equal(accessRefusalMessage(code).includes(code), false);
  }

  const page = read(PAGE);
  assert.match(page, /role="alert"/);
  assert.match(page, /\{error\}/);
  assert.match(page, /setError\(result\.error\)/);
});

test("a revision conflict reloads what was saved and asks for a reviewed retry", async () => {
  const calls = useFetch((_call, index) =>
    index === 0
      ? json({ error: "revision_conflict" }, 409)
      : json(storedBody({ revision: 4, provenance: { source: "administrator", at: "2026-11-21T09:00:00.000Z" } })),
  );
  const result = await saveAccessConfiguration(draft(TYPED_INPUT), 3);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "revision_conflict");
  assert.equal(result.ok === false && result.conflict, true);
  assert.match(result.ok === false ? result.error : "", /save again/i);
  assert.equal(calls.length, 2, "the conflict retries by reading the stored revision");
  assert.equal(calls[1]?.url, "/api/admin/access");
  assert.equal(calls[1]?.init.method, "GET");
  const refreshed = result.ok === false ? result.refreshed : null;
  assert.equal(refreshed?.revision, 4);
  assert.equal(refreshed?.providers.github.credentialConfigured, true);

  const page = read(PAGE);
  assert.match(page, /result\.conflict && result\.refreshed !== null/);
  assert.match(page, /setConfiguration\(result\.refreshed\)/);
  assert.match(page, /setDraft\(draftFromConfiguration\(result\.refreshed\)\)/);
});

test("the registration block answers what a provider needs before any provider is enabled", () => {
  const parsed = parseAccessConfiguration(
    storedBody({ providers: { google: { ...PROVIDER }, github: { ...PROVIDER } } }),
  );
  assert.ok(parsed !== null, "an answer with both providers disabled parses");
  assert.deepEqual(parsed?.registration, REGISTRATION);

  const entries = registrationEntries(parsed as AccessConfiguration);
  assert.deepEqual(
    entries.map((entry) => entry.label),
    ["JavaScript origin", "Google redirect URI", "GitHub redirect URI"],
  );
  assert.deepEqual(
    entries.map((entry) => entry.value),
    [PUBLIC_ORIGIN, `${PUBLIC_ORIGIN}/api/auth/callback/google`, `${PUBLIC_ORIGIN}/api/auth/callback/github`],
  );
  assert.match(entries[0]?.sentence ?? "", /JavaScript origin/);
  assert.match(entries[1]?.sentence ?? "", /callback/);
  assert.match(entries[2]?.sentence ?? "", /callback/);
  assert.equal(REGISTRATION_NOTES.length, 2);
  assert.match(REGISTRATION_NOTES[0] ?? "", /GitHub/);
  assert.match(REGISTRATION_NOTES[0] ?? "", /single/);
  assert.match(REGISTRATION_NOTES[0] ?? "", /Google/);
  assert.match(REGISTRATION_NOTES[1] ?? "", /origin/i);
  assert.match(REGISTRATION_NOTES[1] ?? "", /127\.0\.0\.1/);
  assert.match(REGISTRATION_NOTES[1] ?? "", /localhost/);

  const page = read(PAGE);
  const blockStart = page.indexOf('<Panel title="Provider registration">');
  const blockEnd = page.indexOf("</Panel>", blockStart);
  assert.ok(blockStart > 0, "the page renders the registration block");
  assert.ok(blockEnd > blockStart, "the registration block is one panel");
  const block = page.slice(blockStart, blockEnd);
  assert.ok(
    blockStart < page.indexOf("ACCESS_PROVIDERS.map"),
    "the registration block precedes the provider fields and does not depend on their enablement",
  );
  assert.match(block, /\{registrationEntries\(configuration\)\.map\(/);
  assert.match(block, /<Button/);
  assert.match(block, /navigator\.clipboard\?\.writeText\(entry\.value\)/);
  assert.match(block, /\{REGISTRATION_NOTES\.map\(/);
  assert.doesNotMatch(block, /clientSecret|credential|password/, "the block renders addresses only");
  assert.doesNotMatch(page, /\/api\/auth\/callback/, "the page never builds a callback address itself");
  assert.doesNotMatch(read(CLIENT), /\/api\/auth\/callback/, "the client never builds a callback address itself");
  assert.doesNotMatch(JSON.stringify(entries), /secret|client id/i, "no registration value is a client id or a secret");
});

function parsedOfTest(): AccessConfiguration {
  const parsed = parseAccessConfiguration(storedBody());
  assert.ok(parsed !== null);
  return parsed;
}
