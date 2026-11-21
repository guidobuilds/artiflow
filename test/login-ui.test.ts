import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import {
  authorizeUrlFromQuery,
  continueAuthorization,
  followAuthorize,
  getSession,
  signInWithOAuthQuery,
} from "../apps/dashboard/src/auth-client.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
const SIGNED =
  "response_type=code&client_id=local-agent&redirect_uri=http%3A%2F%2F127.0.0.1%3A5173%2Foauth%2Fcallback" +
  "&state=state-1&code_challenge=challenge-1&code_challenge_method=S256&resource=http%3A%2F%2F127.0.0.1%3A5173%2Fmcp" +
  "&exp=1790000000&ba_iat=1789999500&ba_param=client_id&ba_param=sig&sig=abc123";
const CREDENTIALS = { email: "owner@example.test", password: "local-password" };
const CONSENT_URL = "/consent?response_type=code&client_id=local-agent&sig=fresh";
const AUTHORIZE = "/api/auth/oauth2/authorize?";

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

function target() {
  const assigned: string[] = [];
  return { assigned, target: { assign: (url: string) => assigned.push(url) } };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the unsigned authorize URL keeps real parameters and drops provider signatures", () => {
  const url = authorizeUrlFromQuery(`?${SIGNED}`) ?? "";
  assert.equal(url.startsWith(AUTHORIZE), true);
  const params = new URLSearchParams(url.slice(AUTHORIZE.length));
  for (const key of ["sig", "exp", "ba_iat", "ba_param", "ba_pl"]) assert.equal(params.has(key), false);
  assert.equal(params.get("resource"), "http://127.0.0.1:5173/mcp");
  assert.equal(authorizeUrlFromQuery(""), null);
  assert.equal(authorizeUrlFromQuery("?scope=artifacts%3Aread&sig=abc123"), null);
});
test("sign-in posts the signed oauth_query verbatim and returns the provider redirect", async () => {
  const calls = useFetch(() => json({ redirect: true, url: CONSENT_URL }));
  const result = await signInWithOAuthQuery(CREDENTIALS, `?${SIGNED}`);
  assert.deepEqual(result, { ok: true, url: CONSENT_URL });
  assert.equal(calls[0]?.url, "/api/auth/sign-in/email");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { ...CREDENTIALS, oauth_query: SIGNED });
  const redirect = target();
  assert.equal(followAuthorize(CONSENT_URL, redirect.target), true);
  assert.deepEqual(redirect.assigned, [CONSENT_URL]);
});
test("an expired signed query restarts from the rebuilt unsigned authorize URL", async () => {
  const calls = useFetch((_call, index) =>
    index === 0 ? json({ error: "invalid_signature" }, 400) : json({ redirect: true, url: "/login?fresh-signed" }),
  );
  const expired = await signInWithOAuthQuery(CREDENTIALS, `?${SIGNED}`);
  assert.equal(expired.ok, false);
  assert.equal(expired.ok === false && expired.restartable, true);
  assert.equal(expired.ok === false && /restart/i.test(expired.error), true);

  const restarted = await continueAuthorization(`?${SIGNED}`);
  assert.deepEqual(restarted, { ok: true, url: "/login?fresh-signed" });
  assert.equal(calls[1]?.url, authorizeUrlFromQuery(`?${SIGNED}`));
  assert.equal(calls[1]?.init.method, "GET");
});
test("an already-signed-in visitor resumes authorize without posting credentials", async () => {
  const calls = useFetch((_call, index) =>
    index === 0
      ? json({ user: { id: "u1", name: "Ada", email: "ada@example.test" } })
      : json({ redirect: true, url: CONSENT_URL }),
  );
  const session = await getSession();
  assert.deepEqual(session, { ok: true, value: { id: "u1", name: "Ada", email: "ada@example.test", image: null } });
  const resumed = await continueAuthorization(`?${SIGNED}`);
  assert.deepEqual(resumed, { ok: true, url: CONSENT_URL });
  assert.equal(calls[1]?.url, authorizeUrlFromQuery(`?${SIGNED}`));
});
test("rejected credentials and an outage stay honest static errors", async () => {
  useFetch(() => json({ message: "no user owner@example.test, secret-value" }, 401));
  const rejected = await signInWithOAuthQuery(CREDENTIALS, `?${SIGNED}`);
  assert.equal(rejected.ok === false && rejected.error.includes("secret-value"), false);
  assert.equal(rejected.ok === false && rejected.restartable, false);

  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
  }) as typeof fetch;
  const offline = await signInWithOAuthQuery(CREDENTIALS, `?${SIGNED}`);
  assert.equal(offline.ok === false && offline.error.includes("ECONNREFUSED"), false);

  const redirect = target();
  assert.equal(followAuthorize("//evil.test/consent", redirect.target), false);
  assert.equal(followAuthorize("javascript:alert(1)", redirect.target), false);
  assert.deepEqual(redirect.assigned, []);
});

test("the sign-in panel shows a terminal sample with the real tool name and no client marks", () => {
  const screen = readFileSync(new URL("../apps/dashboard/src/AuthScreen.tsx", import.meta.url), "utf8");
  assert.match(screen, /<Terminal>/);
  assert.match(screen, /artifact_commit/);
  assert.doesNotMatch(screen, /agent-icons|AGENT_MARKS|"Terms"|Privacy/);
});

test("the public account entry follows the registration flag while the sign-up form stays", () => {
  const screen = readFileSync(new URL("../apps/dashboard/src/AuthScreen.tsx", import.meta.url), "utf8");
  assert.match(screen, /value\.registration === true/);
  assert.match(screen, /registrationAvailable && invitation === undefined \?/);
  assert.doesNotMatch(screen, /emailPassword/);
  assert.match(screen, /const newAccount = signup \|\| invitation !== undefined;/);
  assert.match(screen, /id="auth-name"/);
  assert.match(screen, /await signUp\(/);
  assert.match(screen, /"Create an account"/);
});
