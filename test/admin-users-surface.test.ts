import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { ADMIN_SECTIONS, administrationEntryVisible, readAdminGate } from "../apps/dashboard/src/admin-entry.ts";
import {
  ADMIN_USERS_PAGE_SIZE,
  accessMethodsLabel,
  adminUserRefusalMessage,
  buildAdminUserEdit,
  buildAdminUserSearch,
  changeAdminUserRole,
  directoryEmptyMessage,
  directorySummary,
  lastActivityLabel,
  parseAdminUserPage,
  readAdminUserPage,
  saveAdminUser,
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

const ADA = {
  id: "user-1",
  name: "Ada Lovelace",
  email: "ada@example.test",
  role: "administrator",
  accessMethods: ["credential", "github"],
  lastActivityAt: "2026-11-20T10:00:00.000Z",
};
const GRACE = {
  id: "user-2",
  name: "Grace Hopper",
  email: "grace@example.test",
  role: "member",
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
    buildAdminUserSearch({ page: 2, search: "  ada lovelace ", role: "administrator" }),
    "/api/admin/users?page=2&pageSize=20&search=ada+lovelace&role=administrator",
  );
  assert.equal(buildAdminUserSearch({ page: 1, search: "   ", role: null }), "/api/admin/users?page=1&pageSize=20");

  const calls = useFetch(() => json(directoryBody()));
  const result = await readAdminUserPage({ page: 2, search: "ada lovelace", role: "administrator" });
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
  const refused = await readAdminUserPage({ page: 1, search: "", role: null });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, "administrator_required");
  assert.match(refused.ok === false ? refused.error : "", /administrator/i);

  useFetch(() => json({ users: [{ id: "user-1" }], total: 1, page: 1, pageSize: 20 }));
  const unreadable = await readAdminUserPage({ page: 1, search: "", role: null });
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
  for (const heading of ["Name", "Email", "Role", "Access methods", "Last activity"]) {
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
  assert.match(page, /setRows\(/);
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

test("the administration shell carries the area, the three routes and the existing refusal", async () => {
  assert.deepEqual(
    ADMIN_SECTIONS.map((section) => [section.label, section.href]),
    [
      ["Users", "/admin/users"],
      ["Access", "/admin/access"],
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

test("the invitations entry states the console path instead of a dead form", () => {
  const page = read(INVITATIONS_PAGE);
  assert.match(page, /bun run user:invite/);
  assert.match(page, /console/i);
  assert.match(page, /later\s+step/i);
  assert.doesNotMatch(page, /<form|<Input|type="email"|<Button/);
  assert.doesNotMatch(page, /\/api\/admin\/invitations|fetch\(/);

  const main = read(MAIN);
  for (const route of ["/admin/users", "/admin/access", "/admin/invitations"]) {
    assert.ok(main.includes(`path === "${route}"`) || main.includes(`"${route}"`), `main.tsx routes ${route}`);
  }
  const users = main.indexOf("<AdminUsersPage />");
  const notFound = main.indexOf("<NotFoundPage />");
  assert.ok(users > 0 && notFound > users, "the administration routes precede the not-found fallback");
});
