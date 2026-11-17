import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import * as client from "../apps/dashboard/src/auth-client.ts";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
type ResetApi = {
  tokenFromFragment: (hash: string) => string | null;
  resetPasswordError: (password: string, confirmation: string) => string | null;
  previewPasswordReset: (token: string) => Promise<Result<{ email: string }>>;
  completePasswordReset: (token: string, newPassword: string) => Promise<Result<{ reset: true }>>;
  RESET_REFUSED: string;
  RESET_PASSWORD: string;
  RESET_PASSWORD_MISMATCH: string;
};

function resetApi(): ResetApi {
  const candidate = client as unknown as Partial<ResetApi>;
  for (const name of [
    "tokenFromFragment",
    "previewPasswordReset",
    "completePasswordReset",
    "resetPasswordError",
  ] as const) {
    assert.equal(typeof candidate[name], "function", `auth-client.ts must export ${name}`);
  }
  for (const name of ["RESET_REFUSED", "RESET_PASSWORD", "RESET_PASSWORD_MISMATCH"] as const) {
    assert.equal(typeof candidate[name], "string", `auth-client.ts must export ${name}`);
  }
  return candidate as ResetApi;
}

const TOKEN = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK";
const SECRET = "chosen-password-42";
const RESET_REFUSED = "This password reset link is invalid, expired or already used. Ask the operator for a new one.";
const RESET_PASSWORD = "Passwords have at least 8 characters and at most 128.";
const RESET_PASSWORD_MISMATCH = "The two passwords do not match.";
const NETWORK = "Cannot reach the auth service. Check that the API is running, then retry.";
const UNEXPECTED = "The auth service answered unexpectedly. Nothing was changed.";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;

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

const header = (call: Call, name: string): string =>
  String((call.init.headers as Record<string, string> | undefined)?.[name] ?? "");

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the reset client exposes one generic refusal and a bounded password policy", () => {
  const api = resetApi();
  assert.equal(api.RESET_REFUSED, RESET_REFUSED);
  assert.equal(api.RESET_PASSWORD, RESET_PASSWORD);
  assert.equal(api.RESET_PASSWORD_MISMATCH, RESET_PASSWORD_MISMATCH);
});

test("the reset token is read only from the URL fragment and must be 43 base64url characters", () => {
  const api = resetApi();
  assert.equal(TOKEN.length, 43);
  assert.equal(api.tokenFromFragment(`#token=${TOKEN}`), TOKEN);
  assert.equal(api.tokenFromFragment(`#token=${TOKEN}&other=1`), TOKEN);
  assert.equal(api.tokenFromFragment(`token=${TOKEN}`), null);
  assert.equal(api.tokenFromFragment(`?token=${TOKEN}`), null);
  assert.equal(api.tokenFromFragment("#token="), null);
  assert.equal(api.tokenFromFragment("#"), null);
  assert.equal(api.tokenFromFragment(""), null);
  assert.equal(api.tokenFromFragment(`#access_token=${TOKEN}`), null);
  assert.equal(api.tokenFromFragment(`#token=${TOKEN.slice(0, 42)}`), null);
  assert.equal(api.tokenFromFragment(`#token=${TOKEN.slice(0, 42)}=`), null);
  assert.equal(api.tokenFromFragment(`#token=${"a".repeat(44)}`), null);
  assert.equal(api.tokenFromFragment(`#token=${TOKEN.replace(/K$/, "+")}`), null);
  assert.equal(api.tokenFromFragment(`#token=${TOKEN.replace(/K$/, "/")}`), null);
});

test("preview posts only the token and returns the fixed account address", async () => {
  const api = resetApi();
  const calls = useFetch(() => json({ email: "owner@example.test" }));
  assert.deepEqual(await api.previewPasswordReset(TOKEN), { ok: true, value: { email: "owner@example.test" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/auth/password-reset/preview");
  assert.equal(String(calls[0]?.url).includes(TOKEN), false);
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.credentials, "same-origin");
  assert.equal(header(calls[0]!, "content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { token: TOKEN });

  useFetch(() => json({ email: "" }));
  assert.deepEqual(await api.previewPasswordReset(TOKEN), { ok: false, error: UNEXPECTED });
  useFetch(() => json({ user: { id: "u1" } }));
  assert.deepEqual(await api.previewPasswordReset(TOKEN), { ok: false, error: UNEXPECTED });
});

test("every refused reset link gives the one generic error and the token never leaks", async () => {
  const api = resetApi();
  for (const code of ["INVALID_RESET", "expired", "already_used", "replaced", "unknown"]) {
    useFetch(() => json({ code, message: `no reset for ${TOKEN}` }, 400));
    assert.deepEqual(await api.previewPasswordReset(TOKEN), { ok: false, error: RESET_REFUSED });
    useFetch(() => json({ code, message: `no reset for ${TOKEN}` }, 400));
    assert.deepEqual(await api.completePasswordReset(TOKEN, SECRET), { ok: false, error: RESET_REFUSED });
  }

  useFetch(() => json({ message: `database secret ${TOKEN} failed` }, 500));
  assert.deepEqual(await api.previewPasswordReset(TOKEN), { ok: false, error: UNEXPECTED });
  useFetch(() => json({ message: `database secret ${TOKEN} failed` }, 500));
  assert.deepEqual(await api.completePasswordReset(TOKEN, SECRET), { ok: false, error: UNEXPECTED });

  offline();
  assert.deepEqual(await api.previewPasswordReset(TOKEN), { ok: false, error: NETWORK });
  assert.deepEqual(await api.completePasswordReset(TOKEN, SECRET), { ok: false, error: NETWORK });

  assert.equal(RESET_REFUSED.includes(TOKEN), false);
});

test("completion posts token and new password only, needs no session and maps a rejected password", async () => {
  const api = resetApi();
  const calls = useFetch(() => json({ status: "ok" }));
  assert.deepEqual(await api.completePasswordReset(TOKEN, SECRET), { ok: true, value: { reset: true } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/auth/password-reset/complete");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.credentials, "same-origin");
  assert.equal(header(calls[0]!, "content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { token: TOKEN, newPassword: SECRET });

  useFetch(() => json({ ok: true }));
  assert.deepEqual(await api.completePasswordReset(TOKEN, SECRET), { ok: false, error: UNEXPECTED });
  useFetch(() => json({ user: { id: "u1", name: "Owner", email: "owner@example.test" } }));
  assert.deepEqual(await api.completePasswordReset(TOKEN, SECRET), { ok: false, error: UNEXPECTED });

  useFetch(() =>
    json({ code: "PASSWORD_INVALID", message: "The password must be between 8 and 128 characters." }, 400),
  );
  assert.deepEqual(await api.completePasswordReset(TOKEN, "short"), { ok: false, error: RESET_PASSWORD });

  useFetch(() => json({ code: "INVALID_RESET", message: "gone" }, 400));
  assert.deepEqual(await api.completePasswordReset(TOKEN, SECRET), { ok: false, error: RESET_REFUSED });
});

test("the reset form refuses a short, oversized or mismatched password", () => {
  const api = resetApi();
  assert.equal(api.resetPasswordError(SECRET, SECRET), null);
  assert.equal(api.resetPasswordError("a".repeat(8), "a".repeat(8)), null);
  assert.equal(api.resetPasswordError("a".repeat(128), "a".repeat(128)), null);

  assert.equal(api.resetPasswordError("a".repeat(7), "a".repeat(7)), RESET_PASSWORD);
  assert.equal(api.resetPasswordError("", ""), RESET_PASSWORD);
  assert.equal(api.resetPasswordError("a".repeat(129), "a".repeat(129)), RESET_PASSWORD);
  assert.equal(api.resetPasswordError(SECRET, `${SECRET}x`), RESET_PASSWORD_MISMATCH);
  assert.equal(api.resetPasswordError("a".repeat(129), SECRET), RESET_PASSWORD);
});

test("the chosen password is never stored, logged or returned", async () => {
  const api = resetApi();
  const written: unknown[][] = [];
  const saved = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const record = (...args: unknown[]): void => {
    written.push(args);
  };
  console.log = record;
  console.info = record;
  console.warn = record;
  console.error = record;
  console.debug = record;
  try {
    const calls = useFetch(() => json({ status: "ok" }));
    const result = await api.completePasswordReset(TOKEN, SECRET);
    assert.deepEqual(result, { ok: true, value: { reset: true } });
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(JSON.stringify(calls.map((call) => call.url)).includes(SECRET), false);
    assert.equal(written.length, 0, "the reset client must not log anything");
  } finally {
    console.log = saved.log;
    console.info = saved.info;
    console.warn = saved.warn;
    console.error = saved.error;
    console.debug = saved.debug;
  }

  const source = readFileSync(new URL("../apps/dashboard/src/auth-client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(source, /console\./);
});

test("the invitation client functions stay exported and unchanged in behaviour", async () => {
  const invitation = client as unknown as {
    previewInvitation: (token: string) => Promise<Result<{ email: string }>>;
    completeInvitation: (input: {
      token: string;
      name: string;
      password: string;
    }) => Promise<Result<{ created: true }>>;
    INVITE_REFUSED: string;
  };
  useFetch(() => json({ email: "invited@example.test" }));
  assert.deepEqual(await invitation.previewInvitation(TOKEN), { ok: true, value: { email: "invited@example.test" } });
  useFetch(() => json({ ok: true }));
  assert.deepEqual(
    await invitation.completeInvitation({ token: TOKEN, name: "New Owner", password: "local-password" }),
    { ok: true, value: { created: true } },
  );
});
