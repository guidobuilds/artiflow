import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import * as client from "../apps/dashboard/src/auth-client.ts";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
type InvitationApi = {
  tokenFromFragment: (hash: string) => string | null;
  previewInvitation: (token: string) => Promise<Result<{ email: string }>>;
  completeInvitation: (input: { token: string; name: string; password: string }) => Promise<Result<{ created: true }>>;
};

function invitationApi(): InvitationApi {
  const candidate = client as unknown as Partial<InvitationApi>;
  for (const name of ["tokenFromFragment", "previewInvitation", "completeInvitation"] as const) {
    assert.equal(typeof candidate[name], "function", `auth-client.ts must export ${name}`);
  }
  return candidate as InvitationApi;
}

const TOKEN = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK";
const INVITE_REFUSED = "This invitation is invalid, expired or already used. Ask the operator for a new one.";
const INVITE_NAME = "Enter your name before creating the account.";
const INVITE_PASSWORD = "Passwords have at least 8 characters and at most 128.";
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

test("the invitation token is read only from the URL fragment", () => {
  const api = invitationApi();
  assert.equal(TOKEN.length, 43);
  assert.equal(api.tokenFromFragment(`#token=${TOKEN}`), TOKEN);
  assert.equal(api.tokenFromFragment(`token=${TOKEN}`), null);
  assert.equal(api.tokenFromFragment(`?token=${TOKEN}`), null);
  assert.equal(api.tokenFromFragment("#token="), null);
  assert.equal(api.tokenFromFragment(`#access_token=${TOKEN}`), null);
  assert.equal(api.tokenFromFragment(`#token=${TOKEN.slice(0, 42)}`), null);
  assert.equal(api.tokenFromFragment(`#token=${TOKEN.slice(0, 42)}=`), null);
  assert.equal(api.tokenFromFragment(`#token=${"a".repeat(44)}`), null);
  assert.equal(api.tokenFromFragment(`#token=${TOKEN.replace(/K$/, "+")}`), null);
  assert.equal(api.tokenFromFragment(""), null);
});

test("preview posts only the token and returns the address fixed by the invitation", async () => {
  const api = invitationApi();
  const calls = useFetch(() => json({ email: "invited@example.test" }));
  assert.deepEqual(await api.previewInvitation(TOKEN), { ok: true, value: { email: "invited@example.test" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/auth/registration/preview");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.credentials, "same-origin");
  assert.equal(header(calls[0]!, "content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { token: TOKEN });

  useFetch(() => json({ email: "" }));
  assert.deepEqual(await api.previewInvitation(TOKEN), { ok: false, error: UNEXPECTED });
  useFetch(() => json({ user: { id: "u1" } }));
  assert.deepEqual(await api.previewInvitation(TOKEN), { ok: false, error: UNEXPECTED });
});

test("every refused invitation gives one generic error and the token never leaks", async () => {
  const api = invitationApi();
  useFetch(() => json({ code: "INVALID_INVITATION", message: `no invite for ${TOKEN}` }, 400));
  const refused = await api.previewInvitation(TOKEN);
  assert.deepEqual(refused, { ok: false, error: INVITE_REFUSED });

  useFetch(() => json({ code: "expired", message: "expired" }, 400));
  assert.deepEqual(await api.previewInvitation(TOKEN), { ok: false, error: INVITE_REFUSED });

  useFetch(() => json({ message: `database secret ${TOKEN} failed` }, 500));
  assert.deepEqual(await api.previewInvitation(TOKEN), { ok: false, error: UNEXPECTED });

  offline();
  assert.deepEqual(await api.previewInvitation(TOKEN), { ok: false, error: NETWORK });

  for (const error of [JSON.stringify(refused), INVITE_REFUSED]) {
    assert.equal(error.includes(TOKEN), false);
    assert.equal(error.includes("registrationInvite"), false);
  }
});

test("completion posts token, name and password only and needs no session", async () => {
  const api = invitationApi();
  const calls = useFetch(() => json({ ok: true }));
  const forged = { token: TOKEN, name: "New Owner", password: "local-password", email: "forged@example.test" };
  assert.deepEqual(await api.completeInvitation(forged), { ok: true, value: { created: true } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/auth/registration/complete");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.credentials, "same-origin");
  assert.equal(header(calls[0]!, "content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    token: TOKEN,
    name: "New Owner",
    password: "local-password",
  });

  useFetch(() => json({ user: { id: "u1", name: "New Owner", email: "invited@example.test" } }));
  assert.deepEqual(await api.completeInvitation(forged), { ok: false, error: UNEXPECTED });

  useFetch(() => json({ code: "INVALID_INVITATION", message: "consumed" }, 400));
  assert.deepEqual(await api.completeInvitation(forged), { ok: false, error: INVITE_REFUSED });

  useFetch(() => json({ code: "INVALID_NAME", message: "A name is required." }, 400));
  assert.deepEqual(await api.completeInvitation(forged), { ok: false, error: INVITE_NAME });

  useFetch(() =>
    json({ code: "INVALID_PASSWORD", message: "The password must be between 8 and 128 characters." }, 400),
  );
  assert.deepEqual(await api.completeInvitation(forged), { ok: false, error: INVITE_PASSWORD });

  offline();
  assert.deepEqual(await api.completeInvitation(forged), { ok: false, error: NETWORK });
});
