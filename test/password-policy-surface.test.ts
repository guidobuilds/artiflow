import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import {
  completeInvitation,
  completePasswordReset,
  INVITE_PASSWORD,
  RESET_PASSWORD,
} from "../apps/dashboard/src/auth-client.ts";
import { parsePublicPasswordPolicy } from "../apps/dashboard/src/admin-password-policy-client.ts";
import {
  PASSWORD_POLICY_UNAVAILABLE,
  passwordPolicyStatements,
  readPasswordPolicyInForce,
} from "../apps/dashboard/src/password-policy-client.ts";

type Call = { url: string; init: RequestInit };

const realFetch = globalThis.fetch;

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

function offline(): void {
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const REGISTER = "../apps/dashboard/src/RegisterPage.tsx";
const RESET = "../apps/dashboard/src/ResetPage.tsx";
const SCREEN = "../apps/dashboard/src/AuthScreen.tsx";
const NOTICE = "../apps/dashboard/src/components/ui/password-policy-notice.tsx";
const POLICY_CLIENT = "../apps/dashboard/src/password-policy-client.ts";

const TOKEN = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK";
const MIN_LENGTH = "The password must be at least 14 characters.";
const UPPERCASE = "The password must include an uppercase letter.";
const SYMBOL = "The password must include a symbol.";

function policyBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    minLength: 14,
    requireUppercase: true,
    requireLowercase: false,
    requireNumber: false,
    requireSymbol: true,
    maxLength: 128,
    requirements: [
      { requirement: "minLength", message: MIN_LENGTH },
      { requirement: "uppercase", message: UPPERCASE },
      { requirement: "symbol", message: SYMBOL },
    ],
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("both member forms ask the sessionless public read before a password is chosen", async () => {
  const calls = useFetch(() => json(policyBody()));
  const result = await readPasswordPolicyInForce();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/auth/password-policy");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.credentials, "same-origin");
  assert.equal(calls[0]?.init.cache, "no-store");
  assert.equal(calls[0]?.init.body, undefined, "the read carries no credential");
  const sent = JSON.stringify(calls[0]?.init.headers ?? {});
  assert.equal(sent.includes("authorization"), false);

  const register = read(REGISTER);
  assert.match(register, /usePasswordPolicyReading\(\)/);
  assert.match(register, /policy/);
  assert.match(register, /<AuthScreen/);

  const reset = read(RESET);
  assert.match(reset, /usePasswordPolicyReading\(\)/);
  assert.match(reset, /<PasswordPolicyNotice reading=\{policy\} \/>/);

  const screen = read(SCREEN);
  assert.match(screen, /<PasswordPolicyNotice reading=\{invitation\.policy\} \/>/);
  assert.match(screen, /invitation\?:/);
});

test("the requirement list states the minimum length and omits every rule that is off", () => {
  const shown = parsePublicPasswordPolicy(policyBody());
  assert.ok(shown, "the answered view parses");
  assert.deepEqual(passwordPolicyStatements(shown), [MIN_LENGTH, UPPERCASE, SYMBOL]);
  assert.equal(
    passwordPolicyStatements(shown).filter((statement) => statement === MIN_LENGTH).length,
    1,
    "the minimum length is stated once",
  );
  for (const statement of passwordPolicyStatements(shown)) {
    assert.doesNotMatch(statement, /number|lowercase/i, `${statement} is not a rule in force`);
  }

  const everything = parsePublicPasswordPolicy(
    policyBody({
      requireLowercase: true,
      requireNumber: true,
      requirements: [
        { requirement: "minLength", message: MIN_LENGTH },
        { requirement: "maxLength", message: "The password must be at most 128 characters." },
        { requirement: "uppercase", message: UPPERCASE },
        { requirement: "lowercase", message: "The password must include a lowercase letter." },
        { requirement: "number", message: "The password must include a number." },
        { requirement: "symbol", message: SYMBOL },
      ],
    }),
  );
  assert.ok(everything);
  assert.deepEqual(
    passwordPolicyStatements(everything).map((statement) => statement),
    [
      MIN_LENGTH,
      "The password must be at most 128 characters.",
      UPPERCASE,
      "The password must include a lowercase letter.",
      "The password must include a number.",
      SYMBOL,
    ],
    "the answer renders in the order the server sends it",
  );

  const notice = read(NOTICE);
  assert.match(notice, /statements\.map\(/);
  assert.match(notice, /reading\.message/);
  assert.match(notice, /role="status"/);
});

test("a failed read says the policy could not be shown and never blocks the form", async () => {
  for (const fail of [
    offline,
    () => useFetch(() => json({ error: "unexpected" }, 500)),
    () => useFetch(() => json({})),
  ]) {
    fail();
    const result = await readPasswordPolicyInForce();
    assert.equal(result.ok, false, "an unreachable or unusable answer is a failed read");
    assert.equal(result.ok === false ? result.error : "", PASSWORD_POLICY_UNAVAILABLE);
    assert.match(PASSWORD_POLICY_UNAVAILABLE, /could not be shown/);
  }

  const notice = read(NOTICE);
  assert.match(notice, /reading\.kind === "unavailable"/);
  assert.match(notice, /reading\.message/);

  for (const page of [read(REGISTER), read(RESET)]) {
    assert.doesNotMatch(page, /kind: "unavailable"/, "the page keeps its own state and never adds a policy gate");
    assert.doesNotMatch(page, /if \(policy\.kind/);
    assert.doesNotMatch(page, /reading\.kind/);
  }
  assert.match(read(NOTICE), /kind: "reading"/);
});

test("a completion refused for a missed requirement names each one in the words the read uses", async () => {
  const missing = [
    { requirement: "uppercase", message: UPPERCASE },
    { requirement: "symbol", message: SYMBOL },
  ];
  useFetch(() =>
    json(
      { code: "INVALID_PASSWORD", message: "The password is missing an uppercase letter and a symbol.", missing },
      400,
    ),
  );
  const refused = await completeInvitation({ token: TOKEN, name: "New Owner", password: "password1234" });
  assert.equal(refused.ok, false);
  const invitationMessage = refused.ok === false ? refused.error : "";
  assert.notEqual(invitationMessage, INVITE_PASSWORD, "the refusal is never the old generic sentence");
  assert.doesNotMatch(invitationMessage, /at least 8 characters/);
  for (const rule of missing) {
    assert.ok(invitationMessage.includes(rule.message), `${rule.requirement} is named`);
  }
  assert.equal(invitationMessage.includes("password1234"), false, "the refusal never echoes the password");

  const readAgain = parsePublicPasswordPolicy(policyBody({ requirements: missing }));
  assert.ok(readAgain);
  for (const statement of passwordPolicyStatements(readAgain)) {
    assert.ok(invitationMessage.includes(statement), "the refusal repeats the wording the policy read produces");
  }

  useFetch(() =>
    json(
      { code: "PASSWORD_INVALID", message: "The password is missing an uppercase letter.", missing: [missing[0]] },
      400,
    ),
  );
  const reset = await completePasswordReset(TOKEN, "password1234");
  assert.equal(reset.ok, false);
  const resetMessage = reset.ok === false ? reset.error : "";
  assert.notEqual(resetMessage, RESET_PASSWORD, "the refusal is never the old generic sentence");
  assert.doesNotMatch(resetMessage, /at least 8 characters/);
  assert.ok(resetMessage.includes(UPPERCASE), "the missed requirement is named");
  assert.equal(resetMessage.includes("password1234"), false);

  assert.match(read(REGISTER), /\{ error: completed\.error \}|error: completed\.error/);
  assert.match(read(RESET), /setError\(completed\.error\)/);
  assert.match(read(SCREEN), /role="alert"/);
  assert.match(
    read(SCREEN),
    /newAccount && invitation === undefined && values\.password\.length < 8/,
    "the invitation form never applies the old fixed-length gate before the server answers",
  );
  assert.match(
    read(RESET),
    /problem === RESET_PASSWORD_MISMATCH/,
    "the reset page lets the server name a missed length",
  );
  assert.doesNotMatch(read(POLICY_CLIENT), /console\.|localStorage|sessionStorage|document\.cookie/);
});
