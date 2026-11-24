import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { queryKeys, type UserDirectoryFilter } from "../apps/dashboard/src/query/keys.ts";
import {
  FIRST_ADMIN_USERS_FILTER,
  adminUsersSearch,
  librarySearch,
  parseAdminUsersSearch,
  parseLibrarySearch,
} from "../apps/dashboard/src/route-search.ts";

const SRC = "../apps/dashboard/src";
const ROUTER = `${SRC}/router.tsx`;
const LIBRARY = `${SRC}/LibraryPage.tsx`;
const ADMIN_USERS = `${SRC}/AdminUsersPage.tsx`;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("an absent or unknown library filter normalizes to the default and a named filter round-trips", () => {
  assert.deepEqual(parseLibrarySearch({}), { filter: "all" });
  assert.deepEqual(parseLibrarySearch({ filter: "mine" }), { filter: "mine" });
  assert.deepEqual(parseLibrarySearch({ filter: "shared" }), { filter: "shared" });
  for (const filter of ["all", "mine", "shared"] as const) {
    assert.deepEqual(parseLibrarySearch(librarySearch(filter)), { filter }, filter);
  }
  for (const bogus of ["everything", "", "MINE", 3, null, true, ["mine"]]) {
    assert.deepEqual(parseLibrarySearch({ filter: bogus }), { filter: "all" }, JSON.stringify(bogus));
  }
  assert.deepEqual(parseLibrarySearch({ filter: undefined }), { filter: "all" });
});

test("the directory page is a positive integer and anything else falls back to the first page", () => {
  assert.equal(FIRST_ADMIN_USERS_FILTER.page, 1);
  assert.equal(parseAdminUsersSearch({ page: "3" }).page, 3);
  assert.equal(parseAdminUsersSearch({ page: 3 }).page, 3);
  assert.equal(parseAdminUsersSearch({}).page, 1);
  for (const bogus of ["x", -1, "0", "2.5", "", " ", null, true]) {
    assert.equal(parseAdminUsersSearch({ page: bogus }).page, 1, JSON.stringify(bogus));
  }
});

test("the directory search is a trimmed string, never anything else", () => {
  assert.equal(parseAdminUsersSearch({ search: "  ada lovelace  " }).search, "ada lovelace");
  assert.equal(parseAdminUsersSearch({ search: "ada" }).search, "ada");
  assert.equal(parseAdminUsersSearch({}).search, "");
  assert.equal(parseAdminUsersSearch({ search: 42 }).search, "");
  assert.equal(parseAdminUsersSearch({ search: "   " }).search, "");
});

test("role, status and method accept only their union members and otherwise become null", () => {
  assert.equal(parseAdminUsersSearch({ role: "administrator" }).role, "administrator");
  assert.equal(parseAdminUsersSearch({ role: "member" }).role, "member");
  assert.equal(parseAdminUsersSearch({ role: "owner" }).role, null);
  assert.equal(parseAdminUsersSearch({}).role, null);
  assert.equal(parseAdminUsersSearch({ status: "deactivated" }).status, "deactivated");
  assert.equal(parseAdminUsersSearch({ status: "active" }).status, "active");
  assert.equal(parseAdminUsersSearch({ status: "suspended" }).status, null);
  assert.equal(parseAdminUsersSearch({}).status, null);
  assert.equal(parseAdminUsersSearch({ method: "github" }).method, "github");
  assert.equal(parseAdminUsersSearch({ method: "artiflow" }).method, "artiflow");
  assert.equal(parseAdminUsersSearch({ method: "magic" }).method, null);
  assert.equal(parseAdminUsersSearch({}).method, null);
  const parsed = parseAdminUsersSearch({ page: "2", search: " ada ", role: "member", method: "google" });
  assert.ok(
    Object.values(parsed).every((value) => value === null || ["string", "number"].includes(typeof value)),
    "every field of the parsed search is a primitive",
  );
});

test("the query key and the search param are the same normalized value", () => {
  const parsed = parseAdminUsersSearch({
    page: "2",
    search: " ada lovelace ",
    role: "member",
    status: "nope",
    method: "github",
  });
  const filter: UserDirectoryFilter = parsed;
  assert.deepEqual(parsed, { page: 2, search: "ada lovelace", role: "member", status: null, method: "github" });
  assert.deepEqual(
    queryKeys.admin.users(filter),
    ["admin", "users", { page: 2, search: "ada lovelace", role: "member", status: null, method: "github" }],
    "the key carries the normalized search itself",
  );
  assert.deepEqual(
    parseAdminUsersSearch(adminUsersSearch(parsed)),
    parsed,
    "the written params read back as themselves",
  );
  assert.deepEqual(
    adminUsersSearch(FIRST_ADMIN_USERS_FILTER),
    { page: 1 },
    "the untouched filters stay out of the URL",
  );
});

test("the routes derive their filters from validateSearch", () => {
  const router = read(ROUTER);
  assert.match(router, /parseLibrarySearch,/, "the library normalizer comes from the pure module");
  assert.match(router, /parseAdminUsersSearch,/);
  assert.match(
    router,
    /const validateLibrarySearch = \(search: LibrarySearchParams & SearchSchemaInput\) => parseLibrarySearch\(search\);/,
  );
  assert.match(router, /parseAdminUsersSearch\(search\);/, "the admin validator stays thin over the normalizer");
  assert.match(router, /path: "\/",\s*validateSearch: validateLibrarySearch,/);
  assert.match(router, /path: "\/library",\s*validateSearch: validateLibrarySearch,/);
  assert.match(router, /path: "\/admin\/users",\s*validateSearch: validateAdminUsersSearch,/);
  assert.match(router, /const \{ filter \} = indexRoute\.useSearch\(\);/);
  assert.match(router, /const \{ filter \} = libraryRoute\.useSearch\(\);/);
  assert.match(router, /const search = adminUsersRoute\.useSearch\(\);/);
  assert.match(router, /<LibraryPage filter=\{filter\} \/>/);
  assert.match(router, /<AdminUsersPage filter=\{search\} \/>/);
});

test("the admin directory reads the route filter and writes changes through navigation", () => {
  const page = read(ADMIN_USERS);
  assert.doesNotMatch(page, /useState<AdminUserFilter>/, "the filter no longer lives in local state");
  assert.doesNotMatch(page, /setFilter\(/);
  assert.match(page, /export default function AdminUsersPage\(\{ filter \}: \{ filter: AdminUserFilter \}\)/);
  assert.match(page, /const navigate = useNavigate\(\);/);
  assert.match(
    page,
    /void navigate\(\{ to: "\/admin\/users", search: adminUsersSearch\(\{ \.\.\.filter, \.\.\.next \}\) \}\);/,
  );
  assert.match(page, /queryKey: queryKeys\.admin\.users\(filter\)/);
  assert.match(page, /useState\(filter\.search\)/);
});

test("the library reads the route filter and navigates when the filter changes", () => {
  const library = read(LIBRARY);
  assert.doesNotMatch(library, /initialFilter/, "the one-shot read of window.location is gone");
  assert.doesNotMatch(library, /useState<LibraryFilter>/);
  assert.match(library, /filter = "all"/);
  assert.match(library, /const navigate = useNavigate\(\);/);
  assert.match(library, /void navigate\(\{ to: "\/", search: librarySearch\(next\) \}\);/);
  assert.match(library, /onFilter=\{selectFilter\}/);
});
