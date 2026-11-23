import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import {
  accountSessionClosedNotice,
  accountSessionsClosedNotice,
  adminSessionRevokeConfirmation,
  adminSessionRevokeTitle,
  adminSessionsPath,
  adminSessionsRevokeConfirmation,
  adminSessionsRevokeTitle,
  parseSessionList,
  readAccountSessions,
  revokeAccountSession,
  revokeAccountSessions,
  sessionRefusalMessage,
  type SessionRow,
} from "../apps/dashboard/src/sessions-client.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
const MUTATION_ORIGIN = "http://127.0.0.1:5173";
const SRC = "../apps/dashboard/src";
const USERS_PAGE = `${SRC}/AdminUsersPage.tsx`;
const PANEL = `${SRC}/components/app/account-sessions.tsx`;
const SESSION_ROWS = `${SRC}/components/app/session-rows.tsx`;
const CLIENT = `${SRC}/sessions-client.ts`;
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

const PERSON = "Grace Hopper";
const OWN: SessionRow = {
  id: "sess-admin",
  startedAt: "2026-11-20T11:00:00.000Z",
  lastUsedAt: "2026-11-20T19:00:00.000Z",
  ipAddress: "198.51.100.4",
  userAgent: CHROME_MAC,
  current: true,
};
const ACCOUNT: SessionRow = {
  id: "sess-grace-1",
  startedAt: "2026-11-18T07:00:00.000Z",
  lastUsedAt: "2026-11-18T07:30:00.000Z",
  ipAddress: null,
  userAgent: CHROME_MAC,
  current: false,
};

const listBody = (sessions: unknown[] = [ACCOUNT, OWN]): unknown => ({ sessions });

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the users page opens an account's sessions and marks the caller's own when it belongs to that account", async () => {
  const calls = useFetch(() => json(listBody()));
  const result = await readAccountSessions("user-2");
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/admin/users/user-2/sessions");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.body, undefined);
  const rows = result.ok ? result.value : [];
  assert.deepEqual(rows, [ACCOUNT, OWN]);
  assert.deepEqual(
    rows.map((row) => row.current),
    [false, true],
  );
  assert.equal(adminSessionsPath("user-2"), "/api/admin/users/user-2/sessions");
  assert.equal(adminSessionsPath("a/b"), "/api/admin/users/a%2Fb/sessions");

  const page = read(USERS_PAGE);
  assert.match(page, /<AdminShell section="users"/);
  assert.match(page, /AccountSessionsPanel/, "the sessions of an account open from the users page");
  assert.match(page, /Open sessions/, "the page offers to open them");
  assert.match(page, /userId=\{subject\.id\}/);

  const panel = read(PANEL);
  assert.match(panel, /readAccountSessions\(userId\)/);
  assert.match(panel, /<SessionRows/);
  assert.match(panel, /currentLabel="Your session"/, "the caller's own session is marked as theirs");

  const rowsSource = read(SESSION_ROWS);
  for (const heading of ["Started", "Last used", "Address", "Browser"]) {
    assert.match(rowsSource, new RegExp(`>\\s*${heading}\\s*<`), `the table names the ${heading} column`);
  }
  assert.match(rowsSource, /sessionMomentLabel\(row\.startedAt\)/);
  assert.match(rowsSource, /sessionMomentLabel\(row\.lastUsedAt\)/);
  assert.match(rowsSource, /sessionAddressLabel\(row\.ipAddress\)/);
  assert.match(rowsSource, /sessionBrowserLabel\(row\.userAgent\)/);
  assert.doesNotMatch(rowsSource, /\{row\.userAgent\}/, "the recorded agent is described, never echoed raw");
});

test("closing one session of an account asks first, stating what it does", async () => {
  const calls = useFetch(() => json({ session: { id: "sess-grace-1" } }));
  const closed = await revokeAccountSession("user-2", "sess-grace-1");
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.ok ? closed.value : null, { id: "sess-grace-1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/admin/users/user-2/sessions/sess-grace-1/revoke");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headers(calls[0])["origin"], MUTATION_ORIGIN);
  assert.equal(headers(calls[0])["content-type"], "application/json");
  assert.equal(String(calls[0]?.init.body), "{}");

  assert.equal(adminSessionRevokeTitle(PERSON, ACCOUNT), `Close a session of ${PERSON}?`);
  assert.equal(adminSessionRevokeTitle(PERSON, OWN), "Close your own session?");
  const copy = adminSessionRevokeConfirmation(PERSON, ACCOUNT);
  assert.match(copy, /new sign-in/i);
  assert.match(copy, /Chrome on macOS/i);
  assert.match(copy, /Not recorded/i, "an address the server did not record is stated, never invented");
  assert.match(copy, /other sessions stay open/i);
  assert.match(copy, /password/i);
  const own = adminSessionRevokeConfirmation(PERSON, OWN);
  assert.match(own, /your own account/i);
  assert.match(own, /login screen/i);

  assert.match(accountSessionClosedNotice(ACCOUNT), /Closed one session/);
  assert.match(accountSessionClosedNotice(OWN), /signed out/i);

  const panel = read(PANEL);
  assert.match(panel, /<Dialog/);
  assert.match(panel, /adminSessionRevokeConfirmation\(who, confirming\)/);
  assert.match(panel, /revokeAccountSession\(userId, row\.id\)/);
});

test("closing every session of an account asks first and answers with the number closed", async () => {
  const calls = useFetch(() => json({ revoked: 3 }));
  const closed = await revokeAccountSessions("user-2");
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.ok ? closed.value : null, { revoked: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/admin/users/user-2/sessions/revoke");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headers(calls[0])["origin"], MUTATION_ORIGIN);

  assert.equal(adminSessionsRevokeTitle(PERSON), `Close every session of ${PERSON}?`);
  const copy = adminSessionsRevokeConfirmation(PERSON, 3);
  assert.match(copy, /3 sessions/);
  assert.match(copy, /new sign-in/i);
  assert.match(copy, /stay as they are/i);
  assert.equal(adminSessionsRevokeConfirmation(PERSON, 1).includes("1 session of"), true);

  assert.match(accountSessionsClosedNotice(3, PERSON), /Closed 3 sessions/);
  assert.match(accountSessionsClosedNotice(0, PERSON), /no open session/i);

  const panel = read(PANEL);
  assert.match(panel, /adminSessionsRevokeConfirmation\(who, rowCount\)/);
  assert.match(panel, /revokeAccountSessions\(userId\)/);
  assert.match(panel, /Close all sessions/);
});

test("a session or an account that vanished between the read and the action is reported plainly and read again", async () => {
  useFetch(() => json({ error: "session_not_found" }, 404));
  const gone = await revokeAccountSession("user-2", "sess-gone");
  assert.equal(gone.ok, false);
  assert.equal(gone.ok === false && gone.code, "session_not_found");
  assert.match(gone.ok === false ? gone.error : "", /no longer exists/i);
  assert.match(gone.ok === false ? gone.error : "", /read again/i);

  useFetch(() => json({ error: "user_not_found" }, 404));
  const vanished = await revokeAccountSessions("user-2");
  assert.equal(vanished.ok === false && vanished.code, "user_not_found");
  assert.match(vanished.ok === false ? vanished.error : "", /no longer exists/i);

  useFetch(() => json({ error: "administrator_required" }, 403));
  const refused = await readAccountSessions("user-2");
  assert.equal(refused.ok === false && refused.code, "administrator_required");
  assert.match(refused.ok === false ? refused.error : "", /administrator/i);
  assert.equal(sessionRefusalMessage("administrator_required").includes("administrator_required"), false);

  const panel = read(PANEL);
  assert.match(panel, /role="alert"/);
  assert.match(panel, /\{notice\}/);
  assert.match(
    panel,
    /if \(!result\.ok\) \{\s*setNotice\(result\.error\);\s*void client\.invalidateQueries\(\{ queryKey: queryKeys\.admin\.sessions\(userId\) \}\)/,
    "a refused closure reports itself and reads the list again",
  );
});

test("neither the panel nor its answers ever render a session credential", async () => {
  const token = "sess-token-abc123";
  const calls = useFetch(() => json(listBody([{ ...ACCOUNT, token }])));
  const smuggled = await readAccountSessions("user-2");
  assert.equal(calls.length, 1);
  assert.equal(smuggled.ok, false, "a listing that carries a credential is refused");
  assert.equal(smuggled.ok === false && smuggled.code, "unreadable_answer");
  assert.equal(parseSessionList(listBody([{ ...ACCOUNT, token }])), null);
  assert.equal(JSON.stringify(sessionRefusalMessage("unreadable_answer")).includes(token), false);

  for (const path of [USERS_PAGE, PANEL, SESSION_ROWS]) {
    const source = read(path);
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/, `${path} stores nothing`);
    assert.doesNotMatch(source, /console\.(log|info|debug)/, `${path} logs nothing`);
    assert.doesNotMatch(source, /\btoken\b/i, `${path} never speaks about a session token`);
  }
  const client = read(CLIENT);
  assert.doesNotMatch(client, /localStorage|sessionStorage|document\.cookie/, "the client stores nothing");
  assert.doesNotMatch(client, /console\.(log|info|debug)/, "the client logs nothing");
});
