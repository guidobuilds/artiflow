import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  HIDDEN_REVEAL,
  MUTATION_ORIGIN,
  createLink,
  createShare,
  deleteArtifact,
  dismissToken,
  listLinks,
  listShares,
  parseLinkList,
  parseReveal,
  parseShareList,
  pressDelete,
  revealToken,
  revokeLink,
  revokeShare,
  rotateLink,
  tokenNotice,
} from "../apps/dashboard/src/auth-client.ts";

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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const headers = (call: Call | undefined): Record<string, string> =>
  (call?.init.headers ?? {}) as Record<string, string>;

const grant = (id: string, email: string) => ({
  id,
  sharedWithUserId: "u-secret-1",
  sharedWith: { email },
  createdAt: "2026-10-19T08:30:00.000Z",
});
const link = (id: string, revokedAt: string | null = null) => ({
  id,
  createdAt: "2026-10-19T08:30:00.000Z",
  revokedAt,
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a share failure is reported in the server's own words, verbatim per code", async () => {
  const cases: [number, string, RegExp][] = [
    [404, "recipient_not_found", /no user with that email/i],
    [400, "invalid_recipient", /your own account/i],
    [409, "already_shared", /already/i],
    [400, "invalid_email", /valid email/i],
  ];
  for (const [status, code, message] of cases) {
    useFetch(() => json({ error: code }, status));
    const result = await createShare("art-1", "someone@example.com");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, code);
    assert.equal(result.ok === false && message.test(result.error), true);
    assert.equal(result.ok === false && result.error.includes(code), false);
    assert.equal(result.ok === false && result.signInRequired, false);
  }
  useFetch(() => json({ error: "boom", message: "db password secret-value" }, 500));
  const unknown = await createShare("art-1", "someone@example.com");
  assert.equal(unknown.ok === false && unknown.error.includes("secret-value"), false);
});

test("sharing sends the exact Origin plus a JSON body on the mutation", async () => {
  const calls = useFetch(() => json(grant("share-1", "someone@example.com"), 201));
  const created = await createShare("art-1", "someone@example.com");
  assert.deepEqual(created, {
    ok: true,
    value: { id: "share-1", email: "someone@example.com", createdLabel: "2026-10-19" },
  });
  assert.deepEqual([calls[0]?.url, calls[0]?.init.method], ["/api/artifacts/art-1/shares", "POST"]);
  assert.deepEqual(
    [headers(calls[0])["origin"], headers(calls[0])["content-type"]],
    [MUTATION_ORIGIN, "application/json"],
  );
  assert.equal(MUTATION_ORIGIN, "http://127.0.0.1:5173");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { email: "someone@example.com" });
});

test("revoking a grant is a DELETE with the exact Origin and an empty JSON body", async () => {
  const calls = useFetch(() => json({ ok: true }));
  assert.deepEqual(await revokeShare("art-1", "share-1"), { ok: true, value: "confirmed" });
  assert.deepEqual([calls[0]?.url, calls[0]?.init.method], ["/api/artifacts/art-1/shares/share-1", "DELETE"]);
  assert.deepEqual(
    [headers(calls[0])["origin"], headers(calls[0])["content-type"]],
    ["http://127.0.0.1:5173", "application/json"],
  );
  assert.equal(String(calls[0]?.init.body), "{}");
});

test("the grant list is displayable without a userId and an empty library panel is honest", async () => {
  const calls = useFetch(() => json({ shares: [grant("share-1", "someone@example.com")] }));
  const result = await listShares("art-1");
  assert.equal(result.ok, true);
  const rows = result.ok ? result.value : [];
  assert.deepEqual(rows, [{ id: "share-1", email: "someone@example.com", createdLabel: "2026-10-19" }]);
  assert.deepEqual([calls[0]?.init.method, calls[0]?.init.cache, calls[0]?.init.body], ["GET", "no-store", undefined]);
  assert.equal(headers(calls[0])["origin"], undefined);
  assert.deepEqual(parseShareList({ shares: [] }), []);
  assert.deepEqual(parseLinkList({ links: [] }), []);
  assert.equal(parseShareList({ shares: [{ id: "share-1" }] }), null);
  assert.equal(parseLinkList({ links: [{ id: "" }] }), null);
});

test("a missing session asks for a real sign-in instead of an empty panel", async () => {
  useFetch(() => json({ error: "unauthorized" }, 401));
  const shares = await listShares("art-1");
  const links = await listLinks("art-1");
  assert.deepEqual([shares.ok, links.ok], [false, false]);
  assert.deepEqual(
    [shares.ok === false && shares.signInRequired, links.ok === false && links.signInRequired],
    [true, true],
  );
  assert.equal(shares.ok === false && /sign in/i.test(shares.error), true);
});

test("a created link token is shown once and is gone after dismissal", async () => {
  useFetch(() => json({ id: "link-1", url: "http://127.0.0.1:5173/share/tok-abc", token: "tok-abc" }, 201));
  const created = await createLink("art-1");
  assert.deepEqual(created, {
    ok: true,
    value: { linkId: "link-1", url: "http://127.0.0.1:5173/share/tok-abc", token: "tok-abc" },
  });
  const shown = created.ok ? tokenNotice(revealToken(created.value)) : null;
  assert.equal(shown?.url, "http://127.0.0.1:5173/share/tok-abc");
  assert.equal(/shown once/.test(shown?.warning ?? ""), true);
  const dismissed = tokenNotice(dismissToken());
  assert.equal(dismissed, null);
  assert.equal(JSON.stringify([HIDDEN_REVEAL, dismissToken()]).includes("tok-abc"), false);
  assert.equal(parseReveal({ id: "link-1", url: "/share/tok-abc" }), null);
  assert.equal(parseReveal({ id: "link-1", url: "javascript:alert(1)", token: "tok-abc" }), null);
});

test("the link list shows live and revoked rows without any token", async () => {
  useFetch(() => json({ links: [link("link-1"), link("link-2", "2026-10-20T10:00:00.000Z")] }));
  const result = await listLinks("art-1");
  const rows = result.ok ? result.value : [];
  assert.deepEqual(rows, [
    { id: "link-1", createdLabel: "2026-10-19", revokedLabel: null },
    { id: "link-2", createdLabel: "2026-10-19", revokedLabel: "2026-10-20" },
  ]);
  assert.equal(JSON.stringify(rows).includes("tok"), false);
});

test("rotating a revoked link is a graceful 409, never a crash or an invented success", async () => {
  useFetch(() => json({ error: "already_revoked" }, 409));
  const rotated = await rotateLink("art-1", "link-2");
  assert.equal(rotated.ok === false && rotated.code, "already_revoked");
  const calls = useFetch(() => json({ ok: true }));
  await revokeLink("art-1", "link-1");
  assert.deepEqual([calls[0]?.url, calls[0]?.init.method], ["/api/artifacts/art-1/links/link-1", "DELETE"]);
  assert.deepEqual([headers(calls[0])["origin"], String(calls[0]?.init.body)], ["http://127.0.0.1:5173", "{}"]);
});

test("the first delete press only arms: no DELETE is sent until the second press", async () => {
  const calls = useFetch(() => json({ ok: true }));
  let fired = 0;
  const remove = async () => {
    fired += 1;
    return deleteArtifact("art-1");
  };
  const armed = await pressDelete("idle", remove);
  assert.deepEqual([armed.state, armed.result, fired, calls.length], ["armed", null, 0, 0]);
  const confirmed = await pressDelete(armed.state, remove);
  assert.equal(confirmed.result?.ok, true);
  assert.deepEqual([fired, calls.length, calls[0]?.init.method], [1, 1, "DELETE"]);
  assert.deepEqual([headers(calls[0])["origin"], String(calls[0]?.init.body)], ["http://127.0.0.1:5173", "{}"]);
});

test("a delete of an already-gone artifact is honest and asks for a fresh list", async () => {
  useFetch(() => json({ error: "not_found" }, 404));
  const gone = await deleteArtifact("art-1");
  assert.equal(gone.ok === false && gone.code, "not_found");
  assert.equal(gone.ok === false && /already deleted/i.test(gone.error), true);
  useFetch(() => json({ ok: true }));
  assert.deepEqual(await deleteArtifact("art-1"), { ok: true, value: "deleted" });
  useFetch(() => json({ ok: false }));
  assert.equal((await deleteArtifact("art-1")).ok, false);
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
  }) as typeof fetch;
  const offline = await listLinks("art-1");
  assert.equal(offline.ok === false && offline.error.includes("ECONNREFUSED"), false);
});
