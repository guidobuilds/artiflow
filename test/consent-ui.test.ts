import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import {
  describeScopes,
  followConsent,
  getPublicClient,
  parseConsentSearch,
  submitConsent,
} from "../apps/dashboard/src/auth-client.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
const SIGNED =
  "client_id=local-agent&scope=artifacts%3Aread+artifacts%3Awrite+offline_access" +
  "&resource=http%3A%2F%2F127.0.0.1%3A5173%2Fmcp&state=state-1&exp=1790000000&ba_iat=1789999500&sig=abc123";
const DENY_URL = "http://127.0.0.1:9999/callback?error=access_denied&state=state-1";
const ACCEPT_URL = "http://127.0.0.1:9999/callback?code=one-time-code&state=state-1";

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

test("consent centers one card with client identity and prominent decisions", () => {
  const page = readFileSync(new URL("../apps/dashboard/src/ConsentPage.tsx", import.meta.url), "utf8");
  assert.match(page, /<div className="[^"]*flex-1[^"]*place-items-center/);
  const card = page.match(/<section\b[^>]*data-consent-card=""[\s\S]*?<\/section>/)?.[0];
  assert.ok(card, "client identity and decisions must share the centered consent card");
  assert.match(card, /className="[^"]*w-full[^"]*max-w-\[440px\]/);
  assert.doesNotMatch(page, /<Stag\b/);
  assert.doesNotMatch(page, /<Section\b|\babsolute\b|<PageHeadline\b/);
  assert.match(card, /<Logo\b/);
  assert.match(card, /<h1\b[^>]*id="consent-heading"[\s\S]*?state\.client\.clientName[\s\S]*?<\/h1>/);
  assert.match(card, /<ul\b[\s\S]*?scope\.label[\s\S]*?<\/ul>/);
  const decisions = card.match(/<div data-consent-decisions=""[\s\S]*?<\/div>/)?.[0];
  assert.ok(decisions);
  assert.match(decisions, /variant="primary"[^\n]*disabled=\{busy\}[\s\S]*?"Approve"/);
  assert.match(decisions, /variant="secondary"[^\n]*disabled=\{busy\}>\s*Deny\s*</);
  const details = card.match(/<details\b[\s\S]*?<\/details>/)?.[0];
  assert.ok(details, "technical information is collapsed by default");
  assert.doesNotMatch(details, /<details[^>]*\bopen\b/);
  assert.match(details, /Client ID[\s\S]*Resource[\s\S]*scope\.token/);
  assert.ok(card.indexOf(decisions) < card.indexOf(details), "decisions precede secondary technical information");
  assert.match(card, /aria-busy=\{busy \|\| state\.kind === "fetching"\}/);
  assert.match(card, /role="alert"/);
  assert.match(card, /ref=\{heading\}\s+tabIndex=\{-1\}/);
  assert.doesNotMatch(page, /<Tag\b/);
});

test("the signed consent query is parsed once and passed through verbatim", () => {
  const request = parseConsentSearch(`?${SIGNED}`);
  assert.equal(request?.clientId, "local-agent");
  assert.deepEqual(request?.scopes, ["artifacts:read", "artifacts:write", "offline_access"]);
  assert.equal(request?.resource, "http://127.0.0.1:5173/mcp");
  assert.equal(request?.oauthQuery, SIGNED);
  assert.ok(request);
  assert.equal(request.oauthQuery.includes("sig=abc123"), true);
  assert.equal(parseConsentSearch(""), null);
  assert.equal(parseConsentSearch("?scope=artifacts%3Aread"), null);
});

test("requested scopes are shown in plain language, offline_access included", () => {
  const shown = describeScopes(["artifacts:read", "offline_access", "future:scope"]);
  assert.deepEqual(shown[0], { token: "artifacts:read", label: "Read the artifacts you own" });
  assert.deepEqual(shown[1], { token: "offline_access", label: "Keep access without re-signing in" });
  assert.deepEqual(shown[2], { token: "future:scope", label: "Use the future:scope permission" });
});

test("approval posts accept with no narrowed scope and follows the returned url", async () => {
  const calls = useFetch(() => json({ redirect: true, url: ACCEPT_URL }));
  const result = await submitConsent(true, SIGNED);
  assert.deepEqual(result, { ok: true, url: ACCEPT_URL });
  assert.equal(calls[0]?.url, "/api/auth/oauth2/consent");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.credentials, "same-origin");
  assert.ok(calls[0]);
  assert.equal((calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { accept: true, oauth_query: SIGNED });

  const redirect = target();
  assert.equal(followConsent(ACCEPT_URL, redirect.target), true);
  assert.deepEqual(redirect.assigned, [ACCEPT_URL]);
});

test("denial posts accept false and yields the access_denied redirect", async () => {
  const calls = useFetch(() => json({ redirect: true, url: DENY_URL }));
  const result = await submitConsent(false, SIGNED);
  assert.deepEqual(result, { ok: true, url: DENY_URL });
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { accept: false, oauth_query: SIGNED });
});

test("following a redirect refuses anything that is not http", () => {
  const redirect = target();
  assert.equal(followConsent("javascript:alert(1)", redirect.target), false);
  assert.deepEqual(redirect.assigned, []);
});

test("no session asks for a real sign-in instead of inventing client data", async () => {
  useFetch(() => json({ error: "unauthorized" }, 401));
  const result = await getPublicClient("local-agent");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.signInRequired, true);
  assert.equal(result.ok === false && /sign in/i.test(result.error), true);
});

test("a public-client failure is a generic error, never server text", async () => {
  const calls = useFetch(() => json({ message: "db password secret-value" }, 500));
  const failed = await getPublicClient("local-agent");
  assert.equal(failed.ok, false);
  assert.equal(failed.ok === false && failed.error.includes("secret-value"), false);
  assert.equal(calls[0]?.url, "/api/auth/oauth2/public-client?client_id=local-agent");
  assert.equal(calls[0]?.init.cache, "no-store");

  useFetch(() => json({ client_id: "local-agent", client_name: "", scope: "artifacts:read" }));
  assert.deepEqual(await getPublicClient("local-agent"), {
    ok: true,
    value: { clientId: "local-agent", clientName: "local-agent", clientUri: "" },
  });
});
