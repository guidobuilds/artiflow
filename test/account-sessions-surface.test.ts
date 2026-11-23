import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import {
  ACCOUNT_SESSIONS_PATH,
  EMPTY_SESSION_READ,
  LOGIN_PATH,
  applySessionRead,
  closeOtherSessionsConfirmation,
  closeOtherSessionsTitle,
  closeOwnSessionConfirmation,
  closeOwnSessionTitle,
  parseRevokedCount,
  parseRevokedSession,
  parseSessionList,
  readOwnSessions,
  revokeOtherOwnSessions,
  revokeOwnSession,
  revokeOutcome,
  sessionAddressLabel,
  sessionBrowserLabel,
  sessionMomentLabel,
  sessionRefusalMessage,
  sessionsRevokedNotice,
  type SessionRow,
} from "../apps/dashboard/src/sessions-client.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
const MUTATION_ORIGIN = "http://127.0.0.1:5173";
const SRC = "../apps/dashboard/src";
const ACCOUNT_PAGE = `${SRC}/AccountPage.tsx`;
const SESSION_ROWS = `${SRC}/components/app/session-rows.tsx`;
const CLIENT = `${SRC}/sessions-client.ts`;
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FIREFOX_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

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

const CURRENT: SessionRow = {
  id: "sess-current",
  startedAt: "2026-11-20T10:00:00.000Z",
  lastUsedAt: "2026-11-20T18:30:00.000Z",
  ipAddress: "203.0.113.7",
  userAgent: CHROME_MAC,
  current: true,
};
const OTHER: SessionRow = {
  id: "sess-other",
  startedAt: "2026-11-19T08:15:00.000Z",
  lastUsedAt: "2026-11-19T09:45:00.000Z",
  ipAddress: null,
  userAgent: FIREFOX_WINDOWS,
  current: false,
};

const listBody = (sessions: unknown[] = [CURRENT, OTHER]): unknown => ({ sessions });

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the account page lists the person's sessions and marks the one this browser is using", async () => {
  const calls = useFetch(() => json(listBody()));
  const result = await readOwnSessions();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, ACCOUNT_SESSIONS_PATH);
  assert.equal(calls[0]?.url, "/api/account/sessions");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.body, undefined);
  const rows = result.ok ? result.value : [];
  assert.deepEqual(rows, [CURRENT, OTHER]);
  assert.deepEqual(
    rows.map((row) => row.current),
    [true, false],
  );

  assert.deepEqual(parseSessionList(listBody()), [CURRENT, OTHER]);
  assert.equal(parseSessionList({ sessions: [{ ...OTHER, current: "yes" }] }), null);
  assert.equal(parseSessionList({ sessions: [{ ...OTHER, startedAt: "yesterday" }] }), null);
  assert.equal(parseSessionList({ sessions: [{ ...OTHER, id: "" }] }), null);
  assert.equal(parseSessionList({ sessions: {} }), null);
  assert.equal(parseSessionList(null), null);

  const page = read(ACCOUNT_PAGE);
  assert.match(page, /readOwnSessions\(\)/, "the page reads the sessions from the server");
  assert.match(page, /<SessionRows/, "the page renders the shared session rows");
  assert.match(page, /currentLabel="This browser"/, "the row behind this cookie is labelled");

  const rowsSource = read(SESSION_ROWS);
  for (const heading of ["Started", "Last used", "Address", "Browser"]) {
    assert.match(rowsSource, new RegExp(`>\\s*${heading}\\s*<`), `the table names the ${heading} column`);
  }
  assert.match(rowsSource, /sessionMomentLabel\(row\.startedAt\)/);
  assert.match(rowsSource, /sessionMomentLabel\(row\.lastUsedAt\)/);
  assert.match(rowsSource, /sessionAddressLabel\(row\.ipAddress\)/);
  assert.match(rowsSource, /sessionBrowserLabel\(row\.userAgent\)/);
  assert.match(rowsSource, /<Tag on>\{currentLabel\}<\/Tag>/);
  assert.match(rowsSource, /row\.current/);
  assert.doesNotMatch(rowsSource, /\{row\.userAgent\}/, "the recorded agent is described, never echoed raw");
});

test("a session is described by when it started, when it was last used, its address and its browser", () => {
  assert.equal(sessionMomentLabel("2026-11-20T10:00:00.000Z"), "2026-11-20 10:00 UTC");
  assert.equal(sessionMomentLabel("2026-11-19T08:15:12.000Z"), "2026-11-19 08:15 UTC");
  assert.equal(sessionMomentLabel(CURRENT.startedAt), "2026-11-20 10:00 UTC");
  assert.equal(sessionMomentLabel("not a moment"), "an unknown moment");

  assert.equal(sessionAddressLabel("203.0.113.7"), "203.0.113.7");
  assert.equal(sessionAddressLabel(null), "Not recorded");
  assert.equal(sessionAddressLabel("   "), "Not recorded");
  assert.equal(sessionAddressLabel("203.0.113.7") === sessionAddressLabel(OTHER.ipAddress), false);

  assert.equal(sessionBrowserLabel(CHROME_MAC), "Chrome on macOS");
  assert.equal(sessionBrowserLabel(FIREFOX_WINDOWS), "Firefox on Windows");
  assert.equal(sessionBrowserLabel(SAFARI_IPHONE), "Safari on iPhone");
  assert.equal(sessionBrowserLabel(null), "Not recorded");
  assert.equal(sessionBrowserLabel("curl/8.7.1"), "An unrecognized browser");
});

test("closing one of the other sessions sends its identifier and keeps this browser signed in", async () => {
  const calls = useFetch(() => json({ session: { id: "sess-other" } }));
  const closed = await revokeOwnSession("sess-other");
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.ok ? closed.value : null, { id: "sess-other" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/account/sessions/sess-other/revoke");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headers(calls[0])["origin"], MUTATION_ORIGIN);
  assert.equal(headers(calls[0])["content-type"], "application/json");
  assert.equal(String(calls[0]?.init.body), "{}");

  assert.equal(parseRevokedSession({ session: { id: "sess-other" } })?.id, "sess-other");
  assert.equal(parseRevokedSession({ session: { id: "" } }), null);
  assert.equal(parseRevokedSession({ session: { id: "sess-other", token: "abc" } }), null);

  assert.equal(revokeOutcome(OTHER), "closed");
  assert.equal(closeOwnSessionTitle(OTHER), "Close that session?");
  const copy = closeOwnSessionConfirmation(OTHER);
  assert.match(copy, /needs to sign in again/i);
  assert.match(copy, /this browser stays signed in/i);

  const page = read(ACCOUNT_PAGE);
  assert.match(page, /revokeOwnSession\(/);
  assert.match(page, /<Dialog/);
  assert.match(page, /closeOwnSessionConfirmation\(/);
});

test("closing the current session returns the person to the login screen", () => {
  assert.equal(LOGIN_PATH, "/login");
  assert.equal(revokeOutcome(CURRENT), "signed_out");
  assert.equal(closeOwnSessionTitle(CURRENT), "Close this session and sign out?");
  const copy = closeOwnSessionConfirmation(CURRENT);
  assert.match(copy, /this browser/i);
  assert.match(copy, /login page/i);
  assert.match(copy, /other session stays open/i);

  const page = read(ACCOUNT_PAGE);
  assert.match(page, /revokeOutcome\(row\) === "signed_out"/, "the page decides from the row that was closed");
  assert.match(page, /window\.location\.assign\(LOGIN_PATH\)/, "the person lands on the login screen");
  const signedOut = page.indexOf('revokeOutcome(row) === "signed_out"');
  const assign = page.lastIndexOf("window.location.assign(LOGIN_PATH)");
  assert.ok(assign > signedOut, "the redirect belongs to that branch");
});

test("closing the other sessions closes them all and leaves this one open", async () => {
  const calls = useFetch(() => json({ revoked: 2 }));
  const closed = await revokeOtherOwnSessions();
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.ok ? closed.value : null, { revoked: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/account/sessions/revoke-others");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headers(calls[0])["origin"], MUTATION_ORIGIN);

  assert.deepEqual(parseRevokedCount({ revoked: 0 }), { revoked: 0 });
  assert.equal(parseRevokedCount({ revoked: -1 }), null);
  assert.equal(parseRevokedCount({ revoked: "two" }), null);

  assert.equal(closeOtherSessionsTitle(2), "Close the other 2 sessions?");
  assert.equal(closeOtherSessionsTitle(1), "Close the other session?");
  const copy = closeOtherSessionsConfirmation(2);
  assert.match(copy, /2 sessions/);
  assert.match(copy, /sign in again/i);
  assert.match(copy, /this browser stays signed in/i);

  assert.match(sessionsRevokedNotice(2), /Closed 2 other sessions/);
  assert.match(sessionsRevokedNotice(1), /Closed 1 other session\./);
  assert.match(sessionsRevokedNotice(0), /no other session/i);

  const page = read(ACCOUNT_PAGE);
  assert.match(page, /revokeOtherOwnSessions\(\)/);
  assert.match(page, /sessionsRevokedNotice\(/);
});

test("a session that vanished between the read and the action is reported plainly and the list is read again", async () => {
  useFetch(() => json({ error: "session_not_found" }, 404));
  const gone = await revokeOwnSession("sess-gone");
  assert.equal(gone.ok, false);
  assert.equal(gone.ok === false && gone.code, "session_not_found");
  assert.match(gone.ok === false ? gone.error : "", /no longer exists/i);
  assert.match(gone.ok === false ? gone.error : "", /read again/i);
  assert.equal(gone.ok === false && gone.error.includes("session_not_found"), false);

  const page = read(ACCOUNT_PAGE);
  assert.match(page, /role="alert"/);
  assert.match(page, /\{notice\}/);
  assert.match(
    page,
    /if \(!result\.ok\) \{\s*setNotice\(result\.error\);\s*void client\.invalidateQueries\(\{ queryKey: queryKeys\.accountSessions \}\)/,
    "a refused closure reports itself and reads the list again",
  );
});

test("every refusal renders as itself and no session token reaches the markup or storage", async () => {
  const cases: [number, string, string, RegExp][] = [
    [401, "sign_in_required", "unauthorized", /no signed-in account/i],
    [403, "origin_not_allowed", "origin_not_allowed", /does not accept for changes/i],
    [415, "json_content_type_required", "json_content_type_required", /refused the request as incomplete/i],
    [404, "session_not_found", "session_not_found", /no longer exists/i],
  ];
  for (const [status, answered, code, message] of cases) {
    useFetch(() => json({ error: answered }, status));
    const result = await revokeOwnSession("sess-other");
    assert.equal(result.ok, false, `a ${answered} answer is a refusal`);
    assert.equal(result.ok === false && result.code, code);
    assert.match(result.ok === false ? result.error : "", message);
    assert.equal(
      result.ok === false && result.error.includes(answered),
      false,
      `the ${answered} code is not shown raw`,
    );
    assert.equal(sessionRefusalMessage(answered).includes(answered), false);
  }

  useFetch(() => json({ error: "administrator_required" }, 403));
  assert.match(sessionRefusalMessage("administrator_required"), /administrator/i);

  useFetch(() => {
    throw new Error("offline");
  });
  const offline = await readOwnSessions();
  assert.equal(offline.ok === false && offline.code, "network");

  const calls = useFetch(() => json(listBody([{ ...CURRENT, token: "sess-token-abc" }])));
  const smuggled = await readOwnSessions();
  assert.equal(calls.length, 1);
  assert.equal(smuggled.ok, false, "a listing that carries a credential is refused");
  assert.equal(smuggled.ok === false && smuggled.code, "unreadable_answer");
  assert.equal(parseSessionList(listBody([{ ...CURRENT, token: "sess-token-abc" }])), null);

  for (const path of [ACCOUNT_PAGE, SESSION_ROWS, CLIENT]) {
    const source = read(path);
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/, `${path} stores nothing`);
    assert.doesNotMatch(source, /console\.(log|info|debug)/, `${path} logs nothing`);
  }
  const page = read(ACCOUNT_PAGE);
  assert.doesNotMatch(page, /token/i, "the member page never speaks about a session token");
});

test("a failed read keeps the last list on screen and reports the failure", () => {
  const loaded = parseSessionList(listBody());
  assert.ok(loaded);
  const first = applySessionRead(EMPTY_SESSION_READ, { ok: true, value: loaded });
  assert.deepEqual(first, { sessions: loaded, failure: "", signInRequired: false });

  const lapsed = applySessionRead(first, {
    ok: false,
    code: "sign_in_required",
    error: sessionRefusalMessage("sign_in_required"),
    signInRequired: true,
  });
  assert.deepEqual(lapsed.sessions, loaded, "the last list stays on screen");
  assert.match(lapsed.failure, /no signed-in account/i);
  assert.equal(lapsed.signInRequired, true);

  const recovered = applySessionRead(lapsed, { ok: true, value: loaded });
  assert.equal(recovered.failure, "");
  assert.deepEqual(recovered.sessions, loaded);
  assert.equal(
    applySessionRead(EMPTY_SESSION_READ, {
      ok: false,
      code: "sign_in_required",
      error: sessionRefusalMessage("sign_in_required"),
      signInRequired: true,
    }).sessions,
    null,
  );

  const page = read(ACCOUNT_PAGE);
  assert.match(page, /apply: applySessionRead/);
  assert.match(page, /read\.failure/);
});
