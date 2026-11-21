import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { ADMIN_SECTIONS } from "../apps/dashboard/src/admin-entry.ts";
import {
  ADMIN_INVITATIONS_PATH,
  ADMIN_RESET_LINKS_PATH,
  EMPTY_INVITATION_READ,
  HIDDEN_LINK,
  RESET_LINK_ACTIVE_ACCOUNT,
  applyInvitationRead,
  buildEmailRequest,
  dayLabel,
  dismissLink,
  invitationRefusalMessage,
  issueInvitation,
  issueResetLink,
  issuedNotice,
  issuerLabel,
  linkNotice,
  parseInvitationList,
  parseIssuedInvitation,
  parseResetLink,
  parseRevokedInvitation,
  readPendingInvitations,
  regenerateInvitation,
  regeneratedNotice,
  revokeInvitation,
  revealInvitationLink,
  revealResetLink,
  resetIssuedNotice,
  revokedNotice,
  type AdminInvitation,
  type InvitationListResult,
} from "../apps/dashboard/src/admin-invitations-client.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
const MUTATION_ORIGIN = "http://127.0.0.1:5173";
const SRC = "../apps/dashboard/src";
const INVITATIONS_PAGE = `${SRC}/AdminInvitationsPage.tsx`;
const USERS_PAGE = `${SRC}/AdminUsersPage.tsx`;
const CLIENT = `${SRC}/admin-invitations-client.ts`;
const ONE_TIME_LINK = `${SRC}/components/app/one-time-link.tsx`;

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

const ADA = { id: "user-1", name: "Ada Lovelace", email: "ada@example.test" };

const PENDING: AdminInvitation = {
  id: "inv-1",
  email: "grace@example.test",
  expiresAt: "2026-12-01T09:00:00.000Z",
  createdAt: "2026-11-30T09:00:00.000Z",
  issuedBy: ADA,
};
const FROM_CONSOLE: AdminInvitation = {
  id: "inv-2",
  email: "linus@example.test",
  expiresAt: "2026-12-02T09:00:00.000Z",
  createdAt: "2026-12-01T09:00:00.000Z",
  issuedBy: null,
};
const LINK = "https://artiflow.example.test/register#token-abc";

const listBody = (overrides: Record<string, unknown> = {}): unknown => ({
  invitations: [PENDING, FROM_CONSOLE],
  ...overrides,
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("issuing an invitation sends the address and answers the link once", async () => {
  assert.equal(ADMIN_INVITATIONS_PATH, "/api/admin/invitations");
  assert.deepEqual(buildEmailRequest("  grace@example.test  "), { email: "grace@example.test" });

  const calls = useFetch(() => json({ invitation: PENDING, link: LINK, reactivated: false }));
  const issued = await issueInvitation("  grace@example.test  ");
  assert.equal(issued.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/admin/invitations");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headers(calls[0])["origin"], MUTATION_ORIGIN);
  assert.equal(headers(calls[0])["content-type"], "application/json");
  assert.deepEqual(calls[0] && JSON.parse(String(calls[0].init.body)), { email: "grace@example.test" });
  assert.deepEqual(issued.ok ? issued.value.invitation : null, PENDING);
  assert.equal(issued.ok ? issued.value.link : "", LINK);
  assert.equal(issued.ok ? issued.value.reactivated : true, false);

  assert.equal(parseIssuedInvitation({ invitation: PENDING, reactivated: false }), null, "a link is required");
  assert.equal(parseIssuedInvitation({ invitation: PENDING, link: "", reactivated: false }), null);
  assert.equal(parseIssuedInvitation({ invitation: PENDING, link: LINK }), null, "reactivated is required");

  useFetch(() => json({ invitation: { ...PENDING, expiresAt: "soon" }, link: LINK, reactivated: false }));
  const unreadable = await issueInvitation("grace@example.test");
  assert.equal(unreadable.ok === false && unreadable.code, "unreadable_answer");

  const page = read(INVITATIONS_PAGE);
  assert.match(page, /<AdminShell section="invitations"/);
  assert.match(page, /<Field label="Email"/);
  assert.match(page, /type="email"/);
  assert.match(page, /issueInvitation\(/);
  assert.match(page, /Issue invitation/);
  assert.doesNotMatch(page, /location\.reload/);
});

test("the pending list names the author and the expiry of every invitation", async () => {
  const calls = useFetch(() => json(listBody()));
  const listed = await readPendingInvitations();
  assert.equal(listed.ok, true);
  assert.equal(calls[0]?.url, "/api/admin/invitations");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.body, undefined);
  assert.deepEqual(listed.ok ? listed.value : null, [PENDING, FROM_CONSOLE]);

  assert.equal(issuerLabel(ADA), "Issued by Ada Lovelace");
  assert.equal(issuerLabel({ id: "user-3", name: "  ", email: "nobody@example.test" }), "Issued by nobody@example.test");
  assert.equal(issuerLabel(null), "Issued from the console");
  assert.equal(dayLabel("2026-12-01T09:00:00.000Z"), "2026-12-01");
  assert.equal(dayLabel("not a date"), "an unknown date");

  assert.equal(parseInvitationList({ invitations: [PENDING] })?.[0]?.email, "grace@example.test");
  assert.equal(parseInvitationList({ invitations: [{ ...PENDING, issuedBy: { id: "" } }] }), null);
  assert.equal(parseInvitationList({ invitations: [{ ...PENDING, expiresAt: undefined }] }), null);
  assert.equal(parseInvitationList({}), null);

  const page = read(INVITATIONS_PAGE);
  assert.match(page, /issuerLabel\(row\.issuedBy\)/);
  assert.match(page, /dayLabel\(row\.expiresAt\)/);
  assert.match(page, /dayLabel\(row\.createdAt\)/);
  for (const heading of ["Email", "Issued by", "Issued", "Expires"]) {
    assert.match(page, new RegExp(`>\\s*${heading}\\s*<`), `the table names the ${heading} column`);
  }
});

test("the link is shown once and a reload loses it", () => {
  const reveal = revealInvitationLink(LINK);
  const notice = linkNotice(reveal);
  assert.equal(notice?.url, LINK);
  assert.match(notice?.warning ?? "", /shown once/i);
  assert.match(notice?.warning ?? "", /cannot be seen again/i);
  assert.match(notice?.warning ?? "", /reload/i);
  assert.equal(linkNotice(dismissLink()), null);
  assert.deepEqual(dismissLink(), HIDDEN_LINK);
  assert.deepEqual(linkNotice(HIDDEN_LINK), null);

  const page = read(INVITATIONS_PAGE);
  assert.match(page, /useState<LinkReveal>\(HIDDEN_LINK\)/, "the reveal starts empty on every load");
  assert.match(page, /<OneTimeLink state=\{reveal\} onDismiss=\{\(\) => setReveal\(dismissLink\(\)\)\} \/>/);
  assert.match(page, /revealInvitationLink\(result\.value\.link\)/);
  assert.doesNotMatch(page, /row\.link|invitation\.link/, "the pending rows never carry a link");

  const component = read(ONE_TIME_LINK);
  assert.match(component, /\{notice\.url\}/);
  assert.match(component, /Copy link/);
  assert.match(component, /\{notice\.warning\}/);
  assert.match(component, /onDismiss/);
  assert.match(component, /navigator\.clipboard/);
});

test("revoking and regenerating send the right payload", async () => {
  const calls = useFetch((call) =>
    call.url.endsWith("/regenerate")
      ? json({ invitation: PENDING, link: LINK })
      : json({ invitation: { id: "inv-1", revokedAt: "2026-11-30T10:00:00.000Z" } }),
  );

  const revoked = await revokeInvitation("inv/1");
  assert.equal(revoked.ok, true);
  assert.deepEqual(revoked.ok ? revoked.value : null, { id: "inv-1", revokedAt: "2026-11-30T10:00:00.000Z" });
  assert.equal(calls[0]?.url, "/api/admin/invitations/inv%2F1/revoke");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headers(calls[0])["origin"], MUTATION_ORIGIN);
  assert.deepEqual(calls[0] && JSON.parse(String(calls[0].init.body)), {});

  const regenerated = await regenerateInvitation("inv/1");
  assert.equal(regenerated.ok, true);
  assert.equal(regenerated.ok ? regenerated.value.link : "", LINK);
  assert.deepEqual(regenerated.ok ? regenerated.value.invitation : null, PENDING);
  assert.equal(calls[1]?.url, "/api/admin/invitations/inv%2F1/regenerate");
  assert.equal(calls[1]?.init.method, "POST");
  assert.equal(headers(calls[1])["origin"], MUTATION_ORIGIN);
  assert.deepEqual(calls[1] && JSON.parse(String(calls[1].init.body)), {});

  assert.equal(parseRevokedInvitation({ invitation: { id: "inv-1" } }), null);
  assert.equal(parseRevokedInvitation({ invitation: { id: "", revokedAt: "2026-11-30T10:00:00.000Z" } }), null);
  assert.match(regeneratedNotice(PENDING), /grace@example\.test/);
  assert.match(regeneratedNotice(PENDING), /previous link/i);
  assert.match(revokedNotice("grace@example.test"), /grace@example\.test/);
  assert.match(revokedNotice("grace@example.test"), /revoked/i);

  const page = read(INVITATIONS_PAGE);
  assert.match(page, /revokeInvitation\(row\.id\)/);
  assert.match(page, /regenerateInvitation\(row\.id\)/);
  assert.match(page, /void revoke\(row\)/);
  assert.match(page, /void regenerate\(row\)/);
});

test("issuing for a deactivated account says the account is active again", async () => {
  const reactivatedNotice = issuedNotice({ invitation: PENDING, link: LINK, reactivated: true });
  assert.match(reactivatedNotice, /grace@example\.test/);
  assert.match(reactivatedNotice, /deactivated/i);
  assert.match(reactivatedNotice, /active again/i);
  assert.match(reactivatedNotice, /password/i);

  const freshNotice = issuedNotice({ invitation: PENDING, link: LINK, reactivated: false });
  assert.match(freshNotice, /grace@example\.test/);
  assert.match(freshNotice, /24 hours/i);
  assert.match(freshNotice, /once/i);
  assert.doesNotMatch(freshNotice, /deactivated/i);

  const page = read(INVITATIONS_PAGE);
  assert.match(page, /issuedNotice\(result\.value\)/, "the page states the reactivation the server reported");
  assert.match(page, /role="status"/);
});

test("every named refusal of the invitation surface renders as itself", async () => {
  const cases: [string, number, RegExp, (code: string) => Promise<{ ok: boolean; code?: string; error?: string }>][] = [
    ["invalid_email", 400, /valid email address/i, (email) => issueInvitation(email)],
    ["email_in_use", 409, /already holds an active account/i, (email) => issueInvitation(email)],
    ["invitation_not_found", 404, /no longer exists/i, () => revokeInvitation("inv-1")],
    ["invitation_consumed", 409, /already used/i, () => regenerateInvitation("inv-1")],
    ["invitation_expired", 409, /expired/i, () => regenerateInvitation("inv-1")],
    ["invitation_revoked", 409, /already revoked/i, () => regenerateInvitation("inv-1")],
    ["user_not_found", 404, /no account uses that email address/i, (email) => issueResetLink(email)],
    ["account_deactivated", 409, /deactivated/i, (email) => issueResetLink(email)],
    ["administrator_required", 403, /administrator/i, (email) => issueInvitation(email)],
    ["unauthorized", 401, /no signed-in account/i, (email) => issueInvitation(email)],
    ["invalid_body", 400, /refused the request/i, (email) => issueInvitation(email)],
  ];

  for (const [code, status, message, send] of cases) {
    useFetch(() => json({ error: code }, status));
    const result = await send("grace@example.test");
    assert.equal(result.ok, false, `a ${code} answer is a refusal`);
    assert.equal(result.code, code);
    assert.match(result.error ?? "", message);
    assert.equal((result.error ?? "").includes(code), false, `the ${code} code is not shown raw`);
    assert.equal(invitationRefusalMessage(code).includes(code), false);
  }

  const page = read(INVITATIONS_PAGE);
  assert.match(page, /role="alert"/);
  assert.match(page, /\{error\}/);

  const users = read(USERS_PAGE);
  assert.match(users, /role="alert"/);
  assert.match(users, /\{resetError\}/);
});

test("the users page issues a reset link and states the active-account rule", async () => {
  assert.equal(ADMIN_RESET_LINKS_PATH, "/api/admin/reset-links");
  assert.match(RESET_LINK_ACTIVE_ACCOUNT, /active account/i);
  assert.match(RESET_LINK_ACTIVE_ACCOUNT, /deactivated/i);
  assert.match(RESET_LINK_ACTIVE_ACCOUNT, /reactivate/i);

  const calls = useFetch(() => json({ link: LINK, expiresAt: "2026-12-01T10:00:00.000Z" }));
  const issued = await issueResetLink(" grace@example.test ");
  assert.equal(issued.ok, true);
  assert.equal(calls[0]?.url, "/api/admin/reset-links");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headers(calls[0])["origin"], MUTATION_ORIGIN);
  assert.deepEqual(calls[0] && JSON.parse(String(calls[0].init.body)), { email: "grace@example.test" });
  assert.deepEqual(issued.ok ? issued.value : null, { link: LINK, expiresAt: "2026-12-01T10:00:00.000Z" });

  assert.equal(parseResetLink({ link: LINK }), null);
  assert.equal(parseResetLink({ link: "", expiresAt: "2026-12-01T10:00:00.000Z" }), null);

  const resetNotice = resetIssuedNotice("grace@example.test", "2026-12-01T10:00:00.000Z");
  assert.match(resetNotice, /grace@example\.test/);
  assert.match(resetNotice, /one hour/i);
  assert.match(resetNotice, /once/i);

  const reveal = revealResetLink(LINK);
  assert.match(linkNotice(reveal)?.warning ?? "", /cannot be seen again/i);

  const users = read(USERS_PAGE);
  assert.match(users, /issueResetLink\(/);
  assert.match(users, /subject\.email/);
  assert.match(users, /\{RESET_LINK_ACTIVE_ACCOUNT\}/);
  assert.match(users, /useState<LinkReveal>\(HIDDEN_LINK\)/);
  assert.match(users, /<OneTimeLink state=\{resetReveal\} onDismiss=\{\(\) => setResetReveal\(dismissLink\(\)\)\} \/>/);
  assert.match(users, /revealResetLink\(result\.value\.link\)/);
  assert.match(users, /resetIssuedNotice\(/);
  assert.match(users, /Issue reset link/);
});

test("no link ever reaches storage or a log", () => {
  const forbidden = /localStorage|sessionStorage|indexedDB|document\.cookie|console\.\w+\(|sendBeacon/;
  for (const path of [INVITATIONS_PAGE, USERS_PAGE, CLIENT, ONE_TIME_LINK]) {
    assert.doesNotMatch(read(path), forbidden, `${path} keeps the link out of storage and logs`);
  }
  assert.doesNotMatch(read(CLIENT), /location\.(href|search|hash)\s*=/, "the client never puts a link in the URL");

  const parsed = parseInvitationList({ invitations: [{ ...PENDING, link: LINK }] });
  assert.ok(parsed);
  assert.equal("link" in (parsed[0] ?? {}), false, "a list row that carries a link keeps no such field");

  assert.match(invitationRefusalMessage("unreadable_answer"), /answered unexpectedly/i);
  assert.match(invitationRefusalMessage("network"), /could not be reached/i);

  const loaded = parseInvitationList(listBody());
  assert.ok(loaded);
  const first = applyInvitationRead(EMPTY_INVITATION_READ, { ok: true, value: loaded });
  assert.deepEqual(first, { invitations: loaded, failure: "", signInRequired: false });

  const lapsed: InvitationListResult = {
    ok: false,
    code: "administrator_required",
    error: invitationRefusalMessage("administrator_required"),
    signInRequired: false,
  };
  const after = applyInvitationRead(first, lapsed);
  assert.deepEqual(after.invitations, loaded, "a failed refresh keeps the last list on screen");
  assert.match(after.failure, /administrator/i);
  assert.deepEqual(applyInvitationRead(EMPTY_INVITATION_READ, lapsed).invitations, null);

  assert.ok(ADMIN_SECTIONS.some((section) => section.href === "/admin/invitations"));
});
