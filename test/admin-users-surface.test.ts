import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { ADMIN_SECTIONS, administrationEntryVisible, readAdminGate } from "../apps/dashboard/src/admin-entry.ts";
import {
  ADMIN_USERS_PAGE_SIZE,
  EMPTY_DIRECTORY,
  accessMethodsLabel,
  adminUserRefusalMessage,
  applyDirectoryRead,
  buildAdminUserEdit,
  buildAdminUserSearch,
  changeAdminUserRole,
  directoryEmptyMessage,
  directorySummary,
  lastActivityLabel,
  nextStatus,
  parseAdminStatusChange,
  parseAdminUserPage,
  readAdminUserPage,
  replaceAdminUserRole,
  replaceAdminUserRow,
  saveAdminUser,
  setAdminUserStatus,
  statusActionLabel,
  statusConfirmation,
  statusConfirmationTitle,
  statusLabel,
  type AdminUserList,
  type AdminUserRow,
} from "../apps/dashboard/src/admin-users-client.ts";
import { getSession } from "../apps/dashboard/src/auth-client.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
const MUTATION_ORIGIN = "http://127.0.0.1:5173";
const SRC = "../apps/dashboard/src";
const USERS_PAGE = `${SRC}/AdminUsersPage.tsx`;
const ACCESS_PAGE = `${SRC}/AdminAccessPage.tsx`;
const INVITATIONS_PAGE = `${SRC}/AdminInvitationsPage.tsx`;
const ADMIN_SHELL = `${SRC}/components/app/admin-shell.tsx`;
const ACCOUNT_MENU = `${SRC}/components/app/account-menu.tsx`;
const MAIN = `${SRC}/main.tsx`;

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

const ADA: AdminUserRow = {
  id: "user-1",
  name: "Ada Lovelace",
  email: "ada@example.test",
  role: "administrator",
  status: "active",
  accessMethods: ["credential", "github"],
  lastActivityAt: "2026-11-20T10:00:00.000Z",
};
const GRACE: AdminUserRow = {
  id: "user-2",
  name: "Grace Hopper",
  email: "grace@example.test",
  role: "member",
  status: "deactivated",
  accessMethods: [],
  lastActivityAt: null,
};

const directoryBody = (overrides: Record<string, unknown> = {}): unknown => ({
  users: [ADA, GRACE],
  total: 41,
  page: 2,
  pageSize: ADMIN_USERS_PAGE_SIZE,
  ...overrides,
});

const sessionOf = (role?: string): unknown => ({
  user: { id: "user-1", name: "Ada", email: "ada@example.test", ...(role === undefined ? {} : { role }) },
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the entry point is present for an administrator and absent for a member", async () => {
  useFetch(() => json(sessionOf("administrator")));
  const administrator = await getSession();
  assert.equal(administrationEntryVisible(administrator.ok ? administrator.value : null), true);

  useFetch(() => json(sessionOf("member")));
  const member = await getSession();
  assert.equal(administrationEntryVisible(member.ok ? member.value : null), false);

  useFetch(() => json(sessionOf()));
  const unrolved = await getSession();
  assert.equal(administrationEntryVisible(unrolved.ok ? unrolved.value : null), false);
  assert.equal(administrationEntryVisible(null), false);

  const menu = read(ACCOUNT_MENU);
  assert.match(menu, /administrationEntryVisible\(user\) \?/);
  assert.match(menu, /\/admin\/users/);
  assert.equal((menu.match(/administrationEntryVisible\(user\)/g) ?? []).length, 1);
  const guarded = menu.indexOf("administrationEntryVisible(user) ?");
  assert.ok(menu.indexOf("/admin/users") > guarded, "the administration entry lives inside the administrator branch");
});

test("the listing asks the server for one page filtered by search, role and page", async () => {
  assert.equal(ADMIN_USERS_PAGE_SIZE, 20);
  assert.equal(
    buildAdminUserSearch({ page: 2, search: "  ada lovelace ", role: "administrator", status: null }),
    "/api/admin/users?page=2&pageSize=20&search=ada+lovelace&role=administrator",
  );
  assert.equal(
    buildAdminUserSearch({ page: 1, search: "   ", role: null, status: null }),
    "/api/admin/users?page=1&pageSize=20",
  );

  const calls = useFetch(() => json(directoryBody()));
  const result = await readAdminUserPage({ page: 2, search: "ada lovelace", role: "administrator", status: null });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/admin/users?page=2&pageSize=20&search=ada+lovelace&role=administrator");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.body, undefined);
  assert.deepEqual(result.ok ? result.value.users.map((row) => row.id) : [], ["user-1", "user-2"]);
  assert.equal(result.ok ? result.value.total : 0, 41);
  assert.equal(directorySummary({ users: [], total: 41, page: 2, pageSize: 20 }), "41 accounts · page 2 of 3");
  assert.equal(directorySummary({ users: [], total: 1, page: 1, pageSize: 20 }), "1 account · page 1 of 1");

  const page = read(USERS_PAGE);
  assert.match(page, /readAdminUserPage\(/);
  assert.match(page, /readAdminUserPage\(filter\)/);
  assert.doesNotMatch(page, /users\.filter\(|\.filter\(\(row\)/);
  assert.doesNotMatch(page, /location\.reload|fetchArtifacts|toLowerCase\(\)\.includes/);
});

test("the directory refuses a member and an unreadable answer without showing rows", async () => {
  useFetch(() => json({ error: "administrator_required" }, 403));
  const refused = await readAdminUserPage({ page: 1, search: "", role: null, status: null });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, "administrator_required");
  assert.match(refused.ok === false ? refused.error : "", /administrator/i);

  useFetch(() => json({ users: [{ id: "user-1" }], total: 1, page: 1, pageSize: 20 }));
  const unreadable = await readAdminUserPage({ page: 1, search: "", role: null, status: null });
  assert.equal(unreadable.ok === false && unreadable.code, "unreadable_answer");
  assert.equal(parseAdminUserPage({ users: [], total: -1, page: 1, pageSize: 20 }), null);
});

test("the table renders the access methods and the last activity of every row", () => {
  assert.equal(accessMethodsLabel(["credential", "github"]), "Password, GitHub");
  assert.equal(accessMethodsLabel(["google"]), "Google");
  assert.equal(accessMethodsLabel([]), "No sign-in method yet");
  assert.equal(lastActivityLabel(null), "Never signed in");
  assert.equal(lastActivityLabel("2026-11-20T10:00:00.000Z"), "2026-11-20");
  assert.equal(lastActivityLabel("not a date"), "Never signed in");

  const parsed = parseAdminUserPage(directoryBody());
  assert.deepEqual(parsed?.users[0], ADA);

  const page = read(USERS_PAGE);
  assert.match(page, /accessMethodsLabel\(row\.accessMethods\)/);
  assert.match(page, /lastActivityLabel\(row\.lastActivityAt\)/);
  assert.match(page, /\{statusLabel\(row\.status\)\}/, "the table renders the stored status of every row");
  assert.match(page, /<Tag on=\{row\.status === "active"\}>/);
  for (const heading of ["Name", "Email", "Role", "Status", "Access methods", "Last activity"]) {
    assert.match(page, new RegExp(`>\\s*${heading}\\s*<`), `the table names the ${heading} column`);
  }
});

test("the edit sends the name and the email that were typed", async () => {
  const calls = useFetch(() => json({ user: { ...ADA, name: "Ada L", email: "ada.l@example.test" } }));
  const saved = await saveAdminUser("user-1", { name: "  Ada L  ", email: " Ada.L@example.test " });
  assert.equal(saved.ok, true);
  assert.deepEqual(calls[0] && JSON.parse(String(calls[0].init.body)), { name: "Ada L", email: "Ada.L@example.test" });
  assert.equal(calls[0]?.url, "/api/admin/users/user-1");
  assert.equal(calls[0]?.init.method, "PATCH");
  assert.equal(headers(calls[0])["origin"], MUTATION_ORIGIN);
  assert.equal(headers(calls[0])["content-type"], "application/json");
  assert.deepEqual(buildAdminUserEdit({ name: "  Ada L  ", email: " Ada.L@example.test " }), {
    name: "Ada L",
    email: "Ada.L@example.test",
  });
  assert.equal(saved.ok ? saved.value.email : "", "ada.l@example.test");

  const page = read(USERS_PAGE);
  assert.match(page, /No verification/);
  assert.match(page, /saveAdminUser\(/);
  assert.match(page, /replaceAdminUserRow\(/);
  assert.doesNotMatch(page, /location\.reload/);
});

test("the role toggle uses the role endpoint and reads the changed flag", async () => {
  const calls = useFetch(() => json({ user: { id: "user-2", role: "administrator" }, changed: true }));
  const changed = await changeAdminUserRole("user-2", "administrator");
  assert.equal(changed.ok, true);
  assert.equal(changed.ok ? changed.value.changed : false, true);
  assert.equal(changed.ok ? changed.value.role : "", "administrator");
  assert.equal(calls[0]?.url, "/api/admin/users/user-2/role");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headers(calls[0])["origin"], MUTATION_ORIGIN);
  assert.deepEqual(calls[0] && JSON.parse(String(calls[0].init.body)), { role: "administrator" });
  assert.match(read(USERS_PAGE), /changeAdminUserRole\(/);
});

test("every named refusal of the directory renders as itself", async () => {
  const cases: [number, string, RegExp][] = [
    [400, "invalid_name", /name/i],
    [400, "invalid_email", /email address/i],
    [409, "email_in_use", /another account/i],
    [404, "user_not_found", /no longer exists/i],
    [400, "invalid_body", /refused/i],
  ];
  for (const [status, code, message] of cases) {
    useFetch(() => json({ error: code }, status));
    const result = await saveAdminUser("user-1", { name: "Ada", email: "ada@example.test" });
    assert.equal(result.ok, false, `a ${code} answer is a refusal`);
    assert.equal(result.ok === false && result.code, code);
    assert.match(result.ok === false ? result.error : "", message);
    assert.equal(result.ok === false && result.error.includes(code), false, `the ${code} code is not shown raw`);
    assert.equal(adminUserRefusalMessage(code).includes(code), false);
  }

  useFetch(() => json({ error: "invalid_role" }, 400));
  const role = await changeAdminUserRole("user-2", "administrator");
  assert.equal(role.ok === false && role.error.includes("invalid_role"), false);

  const page = read(USERS_PAGE);
  assert.match(page, /role="alert"/);
  assert.match(page, /\{editError\}/);
});

test("an empty directory says what to do next", () => {
  assert.match(directoryEmptyMessage({ search: "", role: null }), /bun run user:invite/);
  assert.match(directoryEmptyMessage({ search: "", role: null }), /console/i);
  assert.match(directoryEmptyMessage({ search: "ada", role: null }), /clear the search/i);
  assert.match(directoryEmptyMessage({ search: "", role: "administrator" }), /clear the role filter/i);
  assert.match(read(USERS_PAGE), /directoryEmptyMessage\(/);
});

test("the administration shell carries the area, the four routes and the existing refusal", async () => {
  assert.deepEqual(
    ADMIN_SECTIONS.map((section) => [section.label, section.href]),
    [
      ["Users", "/admin/users"],
      ["Access", "/admin/access"],
      ["Password policy", "/admin/password-policy"],
      ["Invitations", "/admin/invitations"],
    ],
  );

  const shell = read(ADMIN_SHELL);
  assert.match(shell, /BareShell/);
  assert.match(shell, /Instance administration/);
  assert.match(shell, /aria-label="Administration"/);
  assert.match(shell, /This area is for administrators\./);
  assert.match(shell, /Sign in to open this page\./);
  assert.match(shell, /Back to your library/);
  assert.match(shell, /encodeURIComponent/);

  for (const [path, section] of [
    [USERS_PAGE, "users"],
    [ACCESS_PAGE, "access"],
    [INVITATIONS_PAGE, "invitations"],
  ] as const) {
    assert.match(read(path), new RegExp(`<AdminShell section="${section}"`), `${path} renders inside the shell`);
  }

  useFetch(() => json(sessionOf("member")));
  const memberGate = await readAdminGate();
  assert.equal(memberGate.kind, "refused");
  assert.equal(memberGate.kind === "refused" && memberGate.signInRequired, false);
  assert.match(memberGate.kind === "refused" ? memberGate.message : "", /administrator/i);

  useFetch(() => json(null));
  const anonymous = await readAdminGate();
  assert.equal(anonymous.kind === "refused" && anonymous.signInRequired, true);

  useFetch(() => json(sessionOf("administrator")));
  assert.equal((await readAdminGate()).kind, "ready");
});

test("the invitations entry reaches the shipped surface instead of the console placeholder", () => {
  const page = read(INVITATIONS_PAGE);
  assert.match(page, /readPendingInvitations\(\)/, "the page reads the pending list from the server");
  assert.match(page, /issueInvitation\(/, "the page issues through the administration endpoint");
  assert.match(page, /<AdminShell section="invitations"/);
  assert.doesNotMatch(page, /location\.reload/, "the list is read again without reloading the document");
  assert.doesNotMatch(page, /later\s+step/i, "the page no longer defers the surface to a later step");

  const main = read(MAIN);
  for (const route of ["/admin/users", "/admin/access", "/admin/invitations"]) {
    assert.ok(main.includes(`path === "${route}"`) || main.includes(`"${route}"`), `main.tsx routes ${route}`);
  }
  const users = main.indexOf("<AdminUsersPage />");
  const notFound = main.indexOf("<NotFoundPage />");
  assert.ok(users > 0 && notFound > users, "the administration routes precede the not-found fallback");
});

test("the status filter travels to the server next to the role and the search", async () => {
  assert.equal(
    buildAdminUserSearch({ page: 1, search: "", role: null, status: "deactivated" }),
    "/api/admin/users?page=1&pageSize=20&status=deactivated",
  );
  assert.equal(
    buildAdminUserSearch({ page: 3, search: "ada", role: "administrator", status: "active" }),
    "/api/admin/users?page=3&pageSize=20&search=ada&role=administrator&status=active",
  );
  assert.equal(
    buildAdminUserSearch({ page: 1, search: "", role: null, status: null }),
    "/api/admin/users?page=1&pageSize=20",
  );

  const calls = useFetch(() => json(directoryBody()));
  const result = await readAdminUserPage({ page: 1, search: "", role: null, status: "deactivated" });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/admin/users?page=1&pageSize=20&status=deactivated");
  assert.equal(calls[0]?.init.method, "GET");

  assert.match(directoryEmptyMessage({ search: "", role: null, status: "active" }), /clear the status filter/i);
  assert.equal(
    directoryEmptyMessage({ search: "", role: null, status: null }),
    directoryEmptyMessage({ search: "", role: null }),
  );

  const page = read(USERS_PAGE);
  assert.match(page, /<Segmented label="Status filter">/);
  for (const label of ["Any status", "Active", "Deactivated"]) {
    assert.match(page, new RegExp(`>\\s*${label}\\s*<`), `the status filter offers ${label}`);
  }
  assert.match(page, /status: "deactivated"/);
  assert.match(page, /status: "active"/);
  assert.match(page, /setFilter\(\(current\) => \(\{ \.\.\.current, page: 1, status:/);
});

test("deactivating asks for the consequences first and then sends the deactivated status", async () => {
  const calls = useFetch(() => json({ user: { id: "user-2", status: "deactivated" } }));
  const saved = await setAdminUserStatus("user-2", "deactivated");
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.ok ? saved.value : null, { id: "user-2", status: "deactivated" });
  assert.equal(calls[0]?.url, "/api/admin/users/user-2/status");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headers(calls[0])["origin"], MUTATION_ORIGIN);
  assert.equal(headers(calls[0])["content-type"], "application/json");
  assert.deepEqual(calls[0] && JSON.parse(String(calls[0].init.body)), { status: "deactivated" });
  assert.equal(parseAdminStatusChange({ user: { id: "user-2", status: "suspended" } }), null);
  assert.equal(parseAdminStatusChange({ user: { id: "", status: "active" } }), null);
  assert.equal(parseAdminStatusChange({ user: { id: "user-2", status: "deactivated" } })?.status, "deactivated");

  assert.equal(nextStatus("active"), "deactivated");
  assert.equal(statusActionLabel(nextStatus("active")), "Deactivate account");

  const copy = statusConfirmation("deactivated");
  assert.match(copy, /no longer sign in by any method/i);
  assert.match(copy, /session/i);
  assert.match(copy, /public links/i);
  assert.match(copy, /revoked/i);
  assert.match(copy, /nothing is deleted/i);
  assert.match(copy, /shared with/i, "the confirmation states that shared content keeps working");
  assert.equal(statusActionLabel("deactivated"), "Deactivate account");
  assert.equal(statusConfirmationTitle("Grace Hopper", "deactivated"), "Deactivate Grace Hopper?");

  const page = read(USERS_PAGE);
  assert.match(page, /<Dialog/);
  assert.match(page, /\{statusConfirmation\(confirming\)\}/);
  assert.match(page, /void applyStatus\(confirming\)/);
  assert.match(page, /setAdminUserStatus\(subject\.id, status\)/);
});

test("reactivating sends the active status and states what it does not restore", async () => {
  const calls = useFetch(() => json({ user: { id: "user-2", status: "active" } }));
  const saved = await setAdminUserStatus("user-2", "active");
  assert.equal(saved.ok, true);
  assert.equal(saved.ok ? saved.value.status : "", "active");
  assert.equal(calls[0]?.url, "/api/admin/users/user-2/status");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headers(calls[0])["origin"], MUTATION_ORIGIN);
  assert.deepEqual(calls[0] && JSON.parse(String(calls[0].init.body)), { status: "active" });

  assert.equal(nextStatus("deactivated"), "active");
  assert.equal(statusActionLabel(nextStatus("deactivated")), "Reactivate account");

  const copy = statusConfirmation("active");
  assert.match(copy, /restores the account's access/i);
  assert.match(copy, /neither the sessions/i);
  assert.match(copy, /public links/i);
  assert.doesNotMatch(copy, /nothing is deleted/i, "reactivating promises no deletion of anything");
  assert.equal(statusActionLabel("active"), "Reactivate account");
  assert.equal(statusConfirmationTitle("Grace Hopper", "active"), "Reactivate Grace Hopper?");

  const page = read(USERS_PAGE);
  assert.match(page, /statusActionLabel\(nextStatus\(subject\.status\)\)/);
});

test("the lifecycle control is one toggle that offers only the status the account does not hold", () => {
  assert.equal(statusLabel("active"), "Active");
  assert.equal(statusLabel("deactivated"), "Deactivated");

  const parsed = parseAdminUserPage(directoryBody());
  assert.deepEqual(
    parsed?.users.map((row) => [row.id, row.status]),
    [
      ["user-1", "active"],
      ["user-2", "deactivated"],
    ],
  );

  const withoutStatus: Record<string, unknown> = { ...ADA };
  delete withoutStatus.status;
  assert.equal(
    parseAdminUserPage({ users: [withoutStatus], total: 1, page: 1, pageSize: 20 }),
    null,
    "a row that does not carry a status is unreadable",
  );
  assert.equal(parseAdminUserPage({ users: [{ ...ADA, status: "suspended" }], total: 1, page: 1, pageSize: 20 }), null);

  const page = read(USERS_PAGE);
  assert.equal((page.match(/chooseStatus\(/g) ?? []).length, 1, "the page holds one lifecycle control");
  assert.match(page, /chooseStatus\(nextStatus\(subject\.status\)\)/, "it offers only the other status");
  assert.match(page, /\{statusActionLabel\(nextStatus\(subject\.status\)\)\}/);
  assert.doesNotMatch(page, /chooseStatus\("deactivated"\)/);
  assert.doesNotMatch(page, /chooseStatus\("active"\)/);
});

test("every named refusal of the status change renders as itself", async () => {
  const cases: [number, string, RegExp][] = [
    [409, "status_unchanged", /already has that status/i],
    [404, "user_not_found", /no longer exists/i],
    [400, "invalid_body", /refused/i],
    [403, "administrator_required", /administrator/i],
    [401, "unauthorized", /no signed-in account/i],
  ];
  for (const [status, code, message] of cases) {
    useFetch(() => json({ error: code }, status));
    const result = await setAdminUserStatus("user-2", "deactivated");
    assert.equal(result.ok, false, `a ${code} answer is a refusal`);
    assert.equal(result.ok === false && result.code, code);
    assert.match(result.ok === false ? result.error : "", message);
    assert.equal(result.ok === false && result.error.includes(code), false, `the ${code} code is not shown raw`);
    assert.equal(adminUserRefusalMessage(code).includes(code), false);
  }
  assert.match(adminUserRefusalMessage("sign_in_required"), /no signed-in account/i);

  useFetch(() => json({ user: { id: "user-2", status: "suspended" } }));
  const unreadable = await setAdminUserStatus("user-2", "active");
  assert.equal(unreadable.ok === false && unreadable.code, "unreadable_answer");

  const page = read(USERS_PAGE);
  assert.match(page, /role="alert"/);
  assert.match(page, /\{editError\}/);
  assert.match(page, /setEditError\(result\.error\)/);
});

test("a failed refresh keeps the rows on screen and reports the failure", () => {
  const loaded = parseAdminUserPage(directoryBody());
  assert.ok(loaded);
  const first = applyDirectoryRead(EMPTY_DIRECTORY, { ok: true, value: loaded });
  assert.deepEqual(first, { page: loaded, failure: "", signInRequired: false });

  const lapsed: AdminUserList = {
    ok: false,
    code: "administrator_required",
    error: adminUserRefusalMessage("administrator_required"),
    signInRequired: false,
  };
  const after = applyDirectoryRead(first, lapsed);
  assert.deepEqual(after.page, loaded, "the last good page stays on screen");
  assert.match(after.failure, /administrator/i);
  assert.equal(after.signInRequired, false);

  const signedOut = applyDirectoryRead(first, {
    ok: false,
    code: "unauthorized",
    error: adminUserRefusalMessage("unauthorized"),
    signInRequired: true,
  });
  assert.deepEqual(signedOut.page, loaded, "losing the session keeps the rows too");
  assert.equal(signedOut.signInRequired, true);

  const recovered = applyDirectoryRead(after, { ok: true, value: loaded });
  assert.equal(recovered.failure, "", "a later answer clears the failure");
  assert.deepEqual(recovered.page, loaded);

  const beforeAnyPage = applyDirectoryRead(EMPTY_DIRECTORY, lapsed);
  assert.equal(beforeAnyPage.page, null, "a refusal before the first page has no rows to keep");

  const page = read(USERS_PAGE);
  assert.match(page, /applyDirectoryRead\(current, result\)/);
  assert.match(page, /role="alert"/);
  assert.match(page, /directory\.failure/);
  assert.doesNotMatch(page, /setGate\(/, "the page no longer swaps the table for the refusal screen");
  assert.doesNotMatch(page, /setRows\(/);
});

test("the edit panel keeps no copy of the committed role", async () => {
  const loaded = parseAdminUserPage(directoryBody());
  assert.ok(loaded);
  const changed = replaceAdminUserRole(loaded, "user-2", "administrator");
  assert.deepEqual(
    changed.users.map((row) => [row.id, row.role]),
    [
      ["user-1", "administrator"],
      ["user-2", "administrator"],
    ],
  );
  assert.equal(changed.total, loaded.total);
  assert.equal(changed.page, loaded.page);
  assert.equal(loaded.users[1]?.role, "member", "the previous page is left alone");
  assert.deepEqual(
    replaceAdminUserRole(loaded, "absent", "administrator").users.map((row) => row.role),
    ["administrator", "member"],
    "an unknown row changes nothing",
  );

  const saved = replaceAdminUserRow(loaded, { ...ADA, role: "administrator", name: "Ada L" });
  assert.deepEqual(saved.users[0], { ...ADA, role: "administrator", name: "Ada L" });
  assert.deepEqual(saved.users[1], GRACE);

  useFetch(() => json({ user: { id: "user-2", role: "administrator" }, changed: true }));
  const role = await changeAdminUserRole("user-2", "administrator");
  assert.equal(role.ok, true);

  const page = read(USERS_PAGE);
  const declared = /type Draft = \{([^}]*)\}/.exec(page);
  assert.ok(declared, "the page declares the draft it edits");
  assert.equal(/\brole\b/.test(declared[1] ?? ""), false, "the draft keeps no role of its own");
  assert.match(
    page,
    /rows\.users\.find\(\(row\) => row\.id === draft\.id\)/,
    "the committed role is read from the row",
  );
  assert.match(page, /pressed=\{subject\.role === "member"\}/);
  assert.match(page, /pressed=\{subject\.role === "administrator"\}/);
  assert.match(page, /replaceAdminUserRole\(current\.page, id, stored\)/);
  assert.doesNotMatch(page, /setDraft\(\(current\) =>/, "no draft field survives the save");
});
