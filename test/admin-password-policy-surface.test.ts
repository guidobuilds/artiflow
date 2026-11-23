import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { ADMIN_SECTIONS, adminSectionPath } from "../apps/dashboard/src/admin-entry.ts";
import {
  MINIMUM_LENGTH_CEILING,
  MINIMUM_LENGTH_FLOOR,
  POLICY_RULES,
  buildUpdatePasswordPolicyPayload,
  draftFromPolicy,
  parsePasswordPolicyConfiguration,
  parsePublicPasswordPolicy,
  passwordPolicyRefusalMessage,
  policySummary,
  readPasswordPolicyConfiguration,
  savePasswordPolicy,
  type PasswordPolicy,
  type PasswordPolicyConfiguration,
  type PasswordPolicyDraft,
} from "../apps/dashboard/src/admin-password-policy-client.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
const PAGE = "../apps/dashboard/src/AdminPasswordPolicyPage.tsx";
const CLIENT = "../apps/dashboard/src/admin-password-policy-client.ts";
const ROUTER = "../apps/dashboard/src/router.tsx";
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

const STORED: PasswordPolicy = {
  minLength: 16,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: false,
  requireSymbol: true,
};

const storedBody = (overrides: Record<string, unknown> = {}): unknown => ({
  revision: 2,
  policy: { ...STORED },
  ...overrides,
});

function draft(overrides: Partial<PasswordPolicyDraft> = {}): PasswordPolicyDraft {
  return { ...draftFromPolicy(STORED), ...overrides };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the policy page has its own route before the 404, its own navigation entry and the administration shell", () => {
  const router = read(ROUTER);
  assert.match(router, /from "\.\/AdminPasswordPolicyPage\.tsx"/);
  assert.match(router, /path: "\/admin\/password-policy"/);
  assert.match(
    router,
    /component: AdminPasswordPolicyPage/,
    "the router must mount <AdminPasswordPolicyPage /> at its own route",
  );
  assert.match(router, /notFoundComponent: NotFoundPage/, "unknown paths still render the not-found page");

  assert.deepEqual(
    ADMIN_SECTIONS.map((section) => [section.label, section.href]),
    [
      ["Users", "/admin/users"],
      ["Invitations", "/admin/invitations"],
      ["Sign-in methods", "/admin/access"],
      ["Enterprise SSO", "/admin/sso"],
      ["Password policy", "/admin/password-policy"],
    ],
  );
  assert.equal(adminSectionPath("password-policy"), "/admin/password-policy");

  const page = read(PAGE);
  assert.match(page, /<AdminShell section="password-policy" gate=\{load\}/);
  assert.doesNotMatch(page, /BareShell/);
  assert.doesNotMatch(page, /AppShell|LIBRARY_LINKS|NavItem/);
  assert.match(read(ADMIN_SHELL), /ADMIN_SECTIONS/);
  assert.doesNotMatch(read(SHELL), /\/admin/);
});

test("a non-administrator is refused by the shell and never sees the form", async () => {
  useFetch(() => json({ error: "administrator_required" }, 403));
  const result = await readPasswordPolicyConfiguration();
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "administrator_required");
  assert.equal(result.ok === false && result.signInRequired, false);
  assert.match(result.ok === false ? result.error : "", /administrator/i);

  const page = read(PAGE);
  assert.match(
    page,
    /useAdminConfiguration\(queryKeys\.admin\.passwordPolicy, \(\) => readPasswordPolicyConfiguration\(\)\)/,
  );
  assert.match(
    read("../apps/dashboard/src/query/held.ts"),
    /setGate\(\{ kind: "refused", message: query\.data\.error, signInRequired: query\.data\.signInRequired \}\)/,
  );
  assert.equal((page.match(/<form/g) ?? []).length, 0, "the page never renders a bare form");
});

test("a sessionless visitor is sent to sign in and returns to the policy page", async () => {
  useFetch(() => json({ error: "sign_in_required" }, 401));
  const result = await readPasswordPolicyConfiguration();
  assert.equal(result.ok === false && result.code, "unauthorized");
  assert.equal(result.ok === false && result.signInRequired, true);
  assert.match(result.ok === false ? result.error : "", /sign in/i);
  assert.equal(
    `/login?return=${encodeURIComponent(adminSectionPath("password-policy"))}`,
    "/login?return=%2Fadmin%2Fpassword-policy",
  );
});

test("the stored policy parses, the draft starts from it and an unreadable answer is refused", async () => {
  const parsed = parsePasswordPolicyConfiguration(storedBody());
  assert.deepEqual(parsed, { revision: 2, policy: STORED });
  assert.deepEqual(draftFromPolicy(STORED), {
    minLength: "16",
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: false,
    requireSymbol: true,
  });

  for (const unusable of [
    { revision: 2 },
    { revision: 0, policy: STORED },
    { revision: 2, policy: { ...STORED, minLength: "16" } },
    { revision: 2, policy: { ...STORED, requireUppercase: "yes" } },
    { revision: 2, policy: { ...STORED, minLength: 16.5 } },
  ]) {
    assert.equal(parsePasswordPolicyConfiguration(unusable), null);
  }

  useFetch(() => json({ revision: 2, policy: { ...STORED, requireNumber: undefined } }));
  const result = await readPasswordPolicyConfiguration();
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "unreadable_answer");
});

test("the public read keeps the rules a form renders before a password is chosen", () => {
  const view = parsePublicPasswordPolicy({
    ...STORED,
    maxLength: 128,
    requirements: [
      { requirement: "minLength", message: "The password must be at least 16 characters." },
      { requirement: "uppercase", message: "The password must include an uppercase letter." },
    ],
  });
  assert.deepEqual(view, {
    ...STORED,
    requirements: [
      { requirement: "minLength", message: "The password must be at least 16 characters." },
      { requirement: "uppercase", message: "The password must include an uppercase letter." },
    ],
  });
  assert.equal(parsePublicPasswordPolicy({ ...STORED, requirements: [{ requirement: "minLength" }] }), null);
  assert.equal(parsePublicPasswordPolicy({ ...STORED }), null, "the rules are required");
});

test("a save sends the revision with every requirement and no password material", async () => {
  const calls = useFetch(() => json(storedBody({ revision: 3 })));
  const saved = await savePasswordPolicy(draft({ minLength: " 20 " }), 2);
  assert.equal(saved.ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call?.url, "/api/admin/password-policy");
  assert.equal(call?.init.method, "PUT");
  assert.equal(headers(call)["content-type"], "application/json");
  assert.equal(headers(call)["origin"] !== undefined, true, "a cookie mutation carries the origin");
  assert.deepEqual(JSON.parse(String(call?.init.body)), {
    revision: 2,
    policy: {
      minLength: 20,
      requireUppercase: true,
      requireLowercase: true,
      requireNumber: false,
      requireSymbol: true,
    },
  });
  const sent = String(call?.init.body);
  for (const forbidden of ["clientSecret", "password", "newPassword", "currentPassword", "token"]) {
    assert.equal(sent.includes(forbidden), false, `the change carries no ${forbidden}`);
  }
  assert.match(read(PAGE), /savePasswordPolicy\(draft, configuration\.revision\)/);
});

test("a length outside the allowed range is refused before anything is sent", async () => {
  for (const value of ["", "7", "129", "twelve", "12.5"]) {
    const calls = useFetch(() => json(storedBody()));
    const result = await savePasswordPolicy(draft({ minLength: value }), 2);
    assert.equal(calls.length, 0, `${value} never reaches the server`);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.conflict, false);
    assert.match(
      result.ok === false ? result.error : "",
      new RegExp(`${MINIMUM_LENGTH_FLOOR}|${MINIMUM_LENGTH_CEILING}`),
    );
    assert.equal(result.ok === false && result.error.includes(value === "" ? "never" : value), false);
  }
  const accepted = buildUpdatePasswordPolicyPayload(draft({ minLength: String(MINIMUM_LENGTH_FLOOR) }), 2);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.ok ? accepted.value.policy.minLength : null, MINIMUM_LENGTH_FLOOR);
  assert.equal(buildUpdatePasswordPolicyPayload(draft({ minLength: String(MINIMUM_LENGTH_CEILING) }), 2).ok, true);
});

test("every named refusal is rendered in its own words and never as the raw code", async () => {
  const cases: [number, string, RegExp][] = [
    [403, "administrator_required", /administrator/i],
    [400, "invalid_body", /incomplete/i],
  ];
  for (const [status, code, message] of cases) {
    useFetch(() => json({ error: code }, status));
    const result = await savePasswordPolicy(draft(), 2);
    assert.equal(result.ok === false && result.code, code);
    assert.match(result.ok === false ? result.error : "", message);
    assert.equal(result.ok === false && result.error.includes(code), false);
    assert.equal(passwordPolicyRefusalMessage(code).includes(code), false);
  }
  assert.match(passwordPolicyRefusalMessage("anonymous"), /recognizes/);
  assert.match(read(PAGE), /role="alert"/);
  assert.match(read(PAGE), /setError\(result\.error\)/);
  assert.doesNotMatch(read(CLIENT), /console\.|localStorage|sessionStorage|document\.cookie/);
});

test("a revision conflict reloads what was stored and asks for a reviewed retry", async () => {
  const calls = useFetch((_call, index) =>
    index === 0
      ? json({ error: "revision_conflict" }, 409)
      : json(storedBody({ revision: 4, policy: { ...STORED, minLength: 24 } })),
  );
  const result = await savePasswordPolicy(draft(), 2);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "revision_conflict");
  assert.equal(result.ok === false && result.conflict, true);
  assert.match(result.ok === false ? result.error : "", /save again/i);
  assert.equal(calls.length, 2, "the conflict retries by reading the stored document");
  assert.equal(calls[1]?.url, "/api/admin/password-policy");
  assert.equal(calls[1]?.init.method, "GET");
  const refreshed = result.ok === false ? result.refreshed : null;
  assert.equal(refreshed?.revision, 4);
  assert.equal(refreshed?.policy.minLength, 24);

  const page = read(PAGE);
  assert.match(page, /result\.conflict && result\.refreshed !== null/);
  assert.match(page, /setConfiguration\(result\.refreshed\)/);
  assert.match(page, /setDraft\(draftFromPolicy\(result\.refreshed\.policy\)\)/);
});

test("the page shows what is in effect and every requirement it offers", () => {
  const configuration = parsePasswordPolicyConfiguration(storedBody()) as PasswordPolicyConfiguration;
  assert.equal(
    policySummary(configuration.policy),
    "At least 16 characters, with an uppercase letter, a lowercase letter and a symbol.",
  );
  assert.equal(
    policySummary({ ...STORED, requireUppercase: false, requireLowercase: false, requireSymbol: false }),
    "At least 16 characters, with no further requirement.",
  );
  assert.deepEqual(
    POLICY_RULES.map((rule) => rule.label),
    ["Uppercase letter", "Lowercase letter", "Number", "Symbol"],
  );
  const page = read(PAGE);
  assert.match(page, /policySummary\(configuration\.policy\)/);
  assert.match(page, /POLICY_RULES\.map/);
  assert.match(page, /type="number"/);
  assert.match(page, /min=\{MINIMUM_LENGTH_FLOOR\}/);
  assert.match(page, /max=\{MINIMUM_LENGTH_CEILING\}/);
  assert.match(page, /Changing it never touches stored passwords\./);
});
