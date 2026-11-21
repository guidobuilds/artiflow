import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { account, user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import {
  seedDirectory,
  trustedSession,
  type DirectoryEntry,
  type SeededDirectoryEntry,
  type TrustedFixture,
  type TrustedSession,
} from "./helpers/trusted-accounts.ts";
import {
  adminGet,
  adminPatch,
  adminPost,
  assertStatus,
  countDatabaseQueries,
  startAdminHarness,
  type AdminHarness,
  type QueryCounter,
} from "./helpers/admin-harness.ts";

const TEST_TIMEOUT_MS = 20_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

const USERS_PATH = "/api/admin/users";
const DIRECTORY_DOMAIN = "directory.test";
const GENERATED_SIZE = 200;
const NADIA_LAST_ACTIVITY = "2026-11-19T08:30:00.000Z";

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  accessMethods: string[];
  lastActivityAt: string | null;
};
type UserPage = { users: UserRow[]; total: number; page: number; pageSize: number };
type IdentityRow = { providerId: string; accountId: string; password: string | null; accessToken: string | null };

let harness: AdminHarness | null = null;
let fixture: TrustedFixture | null = null;
let administrator: TrustedSession | null = null;
let member: TrustedSession | null = null;
let directory: SeededDirectoryEntry[] = [];
let queries: QueryCounter | null = null;

function target(): AdminHarness {
  assert.ok(harness, "the harness started");
  return harness;
}

function fixtureOf(): TrustedFixture {
  assert.ok(fixture, "the fixture started");
  return fixture;
}

function actor(session: TrustedSession | null): TrustedSession {
  assert.ok(session, "the account exists");
  return session;
}

function counter(): QueryCounter {
  assert.ok(queries, "the query counter started");
  return queries;
}

function entry(index: number): SeededDirectoryEntry {
  const seeded = directory[index];
  assert.ok(seeded, `directory entry ${index} exists`);
  return seeded;
}

function setStatus(userId: string, status: "active" | "deactivated"): Promise<Response> {
  return adminPost(
    target(),
    `${USERS_PATH}/${userId}/status`,
    { status },
    actor(administrator).cookie,
  );
}

function listPath(query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ search: DIRECTORY_DOMAIN, ...query });
  return `${USERS_PATH}?${params.toString()}`;
}

async function listDirectory(query: Record<string, string> = {}): Promise<UserPage> {
  const response = await adminGet(target(), listPath(query), actor(administrator).cookie);
  assertStatus(response, 200, "an administrator reads the user list");
  return (await response.json()) as UserPage;
}

async function storedUser(userId: string): Promise<{ name: string; email: string } | undefined> {
  const rows = await target()
    .database.db.select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId));
  return rows[0];
}

async function identitiesOf(userId: string): Promise<IdentityRow[]> {
  return await target()
    .database.db
    .select({
      providerId: account.providerId,
      accountId: account.accountId,
      password: account.password,
      accessToken: account.accessToken,
    })
    .from(account)
    .where(eq(account.userId, userId))
    .orderBy(account.providerId);
}

type Captured<T> = { result: T; lines: Record<string, unknown>[] };

async function withAuditCapture<T>(run: () => Promise<T>): Promise<Captured<T>> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    const result = await run();
    const lines = written
      .flatMap((chunk) => chunk.split("\n"))
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    return { result, lines };
  } finally {
    process.stdout.write = original;
  }
}

function directorySeeds(): DirectoryEntry[] {
  return [
    {
      name: "Nadia Perez",
      email: `nadia.perez@${DIRECTORY_DOMAIN}`,
      accessMethods: ["credential", "github"],
      lastActivityAt: new Date(NADIA_LAST_ACTIVITY),
    },
    { name: "Omar Silva", email: `omar.silva@${DIRECTORY_DOMAIN}`, accessMethods: ["credential", "google"] },
    { name: "Lucia Ferro", email: `lucia.ferro@${DIRECTORY_DOMAIN}`, role: "administrator" },
    ...Array.from({ length: GENERATED_SIZE }, (_, index) => ({
      name: `Directory Person ${String(index + 1).padStart(3, "0")}`,
      email: `person-${index + 1}@${DIRECTORY_DOMAIN}`,
    })),
  ];
}

before(async () => {
  harness = await startAdminHarness(loadConfig(process.env));
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
  administrator = await trustedSession(fixtureOf(), { role: "administrator", name: "Listing Administrator" });
  member = await trustedSession(fixtureOf(), { name: "Ordinary Member" });
  directory = await seedDirectory(harness.database, directorySeeds());
  queries = countDatabaseQueries(harness);
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("a member is refused on both user endpoints", async () => {
  const list = await adminGet(target(), USERS_PATH, actor(member).cookie);
  assertStatus(list, 403, "listing users is an administration action");
  assert.deepEqual(await list.json(), { error: "administrator_required" });

  const subject = entry(3);
  const edit = await adminPatch(
    target(),
    `${USERS_PATH}/${subject.userId}`,
    { name: "Renamed By A Member", email: subject.email },
    actor(member).cookie,
  );
  assertStatus(edit, 403, "editing a user is an administration action");
  assert.deepEqual(await edit.json(), { error: "administrator_required" });
  assert.deepEqual(await storedUser(subject.userId), { name: subject.name, email: subject.email });
});

integration("the administrator lists users with pagination and a stable total", async () => {
  const first = await listDirectory({ page: "1", pageSize: "5" });
  assert.equal(first.total, directory.length, "the total counts every matching account");
  assert.equal(first.users.length, 5, "a page carries at most the requested size");
  assert.equal(first.page, 1);
  assert.equal(first.pageSize, 5);
  assert.equal(
    first.users.every((row) => row.email.endsWith(`@${DIRECTORY_DOMAIN}`)),
    true,
    "the search bounds the page to the matched accounts",
  );

  const second = await listDirectory({ page: "2", pageSize: "5" });
  assert.equal(second.total, first.total, "the total does not depend on the page");
  const firstIds = new Set(first.users.map((row) => row.id));
  assert.equal(
    second.users.every((row) => !firstIds.has(row.id)),
    true,
    "consecutive pages do not repeat a row",
  );
});

integration("search finds a person by partial email and by partial name, ignoring case", async () => {
  const byEmail = await listDirectory({ search: "perez@" });
  assert.equal(byEmail.total, 1, "a partial address narrows the list to one person");
  assert.equal(byEmail.users[0]?.email, entry(0).email);
  assert.deepEqual(byEmail.users[0]?.accessMethods, ["credential", "github"], "the row names every access method");
  assert.equal(byEmail.users[0]?.lastActivityAt, NADIA_LAST_ACTIVITY, "the row carries the last activity");

  const byName = await listDirectory({ search: "Silva" });
  assert.equal(byName.total, 1, "a partial name narrows the list to one person");
  assert.equal(byName.users[0]?.id, entry(1).userId);
  assert.equal(byName.users[0]?.lastActivityAt, null, "an account without activity has no timestamp");

  const upperCase = await listDirectory({ search: "SILVA" });
  assert.deepEqual(
    upperCase.users.map((row) => row.id),
    byName.users.map((row) => row.id),
    "the search ignores case",
  );
});

integration("the role filter narrows the list", async () => {
  const administrators = await listDirectory({ role: "administrator", pageSize: "100" });
  assert.deepEqual(
    administrators.users.map((row) => row.id),
    [entry(2).userId],
    "only the directory administrator matches the filter",
  );
  assert.equal(administrators.total, 1);

  const members = await listDirectory({ role: "member" });
  assert.equal(members.total, directory.length - 1, "the member filter excludes the administrator");
  assert.equal(
    members.users.every((row) => row.role === "member"),
    true,
    "the filter only returns members",
  );
});

integration("a page beyond the end is empty rather than an error", async () => {
  const response = await adminGet(target(), listPath({ page: "9999", pageSize: "10" }), actor(administrator).cookie);
  assertStatus(response, 200, "a page past the end is a valid request");
  const body = (await response.json()) as UserPage;
  assert.deepEqual(body.users, []);
  assert.equal(body.total, directory.length);
  assert.equal(body.page, 9999);
});

integration("an edit changes the name and persists", async () => {
  const subject = entry(5);
  const response = await adminPatch(
    target(),
    `${USERS_PATH}/${subject.userId}`,
    { name: "  Directory Person Renamed  ", email: subject.email },
    actor(administrator).cookie,
  );
  assertStatus(response, 200, "an administrator edits a user");
  const body = (await response.json()) as { user: UserRow };
  assert.equal(body.user.id, subject.userId);
  assert.equal(body.user.name, "Directory Person Renamed", "the name is trimmed before it is stored");
  assert.equal(body.user.email, subject.email, "an unchanged address is echoed back");
  assert.equal(body.user.role, "member");
  assert.deepEqual(await storedUser(subject.userId), { name: "Directory Person Renamed", email: subject.email });

  const found = await listDirectory({ search: "Renamed" });
  assert.equal(found.total, 1, "the edited name is searchable");
  assert.equal(found.users[0]?.id, subject.userId);
});

integration("a duplicate email is refused with the named error and changes nothing", async () => {
  const holder = entry(0);
  const subject = entry(6);
  const before = await storedUser(subject.userId);

  const response = await adminPatch(
    target(),
    `${USERS_PATH}/${subject.userId}`,
    { name: "Colliding Person", email: `  ${holder.email.toUpperCase()}  ` },
    actor(administrator).cookie,
  );
  assertStatus(response, 409, "an address another account holds is a conflict");
  assert.deepEqual(await response.json(), { error: "email_in_use" });
  assert.deepEqual(await storedUser(subject.userId), before, "a refused edit leaves the stored row untouched");
});

integration("a malformed address is refused with the named error", async () => {
  const subject = entry(7);
  const before = await storedUser(subject.userId);

  const response = await adminPatch(
    target(),
    `${USERS_PATH}/${subject.userId}`,
    { name: "Should Not Apply", email: "not-an-address" },
    actor(administrator).cookie,
  );
  assertStatus(response, 400, "a malformed address is refused");
  assert.deepEqual(await response.json(), { error: "invalid_email" });
  assert.deepEqual(await storedUser(subject.userId), before);
});

integration("an email change keeps the account rows of that person identical", async () => {
  const subject = entry(8);
  const identitiesBefore = await identitiesOf(subject.userId);
  assert.equal(identitiesBefore.every((row) => row.providerId === "credential"), true);

  const nextEmail = `renamed.person-9@${DIRECTORY_DOMAIN}`;
  const response = await adminPatch(
    target(),
    `${USERS_PATH}/${subject.userId}`,
    { name: subject.name, email: `  ${nextEmail.toUpperCase()}  ` },
    actor(administrator).cookie,
  );
  assertStatus(response, 200, "an administrator changes an address");
  const body = (await response.json()) as { user: UserRow };
  assert.equal(body.user.email, nextEmail, "the stored address is trimmed and canonicalized");
  assert.deepEqual(await storedUser(subject.userId), { name: subject.name, email: nextEmail });
  assert.deepEqual(await identitiesOf(subject.userId), identitiesBefore, "linked identities survive the change");
  assert.deepEqual(body.user.accessMethods, ["credential"], "the access methods still name the same identity");
});

integration("the list costs the same number of queries for any page", async () => {
  async function measured(pageSize: string): Promise<UserPage> {
    counter().reset();
    const page = await listDirectory({ page: "1", pageSize });
    assert.equal(counter().count() > 0, true, "the request ran against the database");
    return page;
  }

  counter().reset();
  const small = await measured("5");
  const smallCount = counter().count();
  const large = await measured("100");
  const largeCount = counter().count();

  assert.equal(small.users.length, 5);
  assert.equal(large.users.length, 100);
  assert.equal(largeCount, smallCount, "a larger page issues no extra query per row");
});

integration("the status filter narrows the list", async () => {
  const deactivatedEntries = [entry(150), entry(151)];
  for (const subject of deactivatedEntries) {
    assertStatus(await setStatus(subject.userId, "deactivated"), 200, "the administrator deactivates the account");
  }

  const deactivated = await listDirectory({ status: "deactivated", pageSize: "100" });
  assert.deepEqual(
    deactivated.users.map((row) => row.id).sort(),
    deactivatedEntries.map((subject) => subject.userId).sort(),
    "only the deactivated accounts match the filter",
  );
  assert.equal(deactivated.total, deactivatedEntries.length, "the total counts the filtered accounts");

  const active = await listDirectory({ status: "active", pageSize: "100" });
  assert.equal(active.total, directory.length - deactivatedEntries.length, "the active filter excludes the deactivated");
  assert.equal(
    active.users.some((row) => deactivatedEntries.some((subject) => subject.userId === row.id)),
    false,
    "no deactivated account appears on an active page",
  );
});

integration("the status filter combines with the role filter", async () => {
  const deactivatedAdministrator = entry(2);
  assertStatus(
    await setStatus(deactivatedAdministrator.userId, "deactivated"),
    200,
    "the administrator deactivates another administrator",
  );

  const deactivatedAdministrators = await listDirectory({ status: "deactivated", role: "administrator" });
  assert.deepEqual(
    deactivatedAdministrators.users.map((row) => row.id),
    [deactivatedAdministrator.userId],
    "both filters apply to the same page",
  );
  assert.equal(deactivatedAdministrators.total, 1);

  const deactivatedMembers = await listDirectory({ status: "deactivated", role: "member", pageSize: "100" });
  assert.deepEqual(
    deactivatedMembers.users.map((row) => row.id).sort(),
    [entry(150).userId, entry(151).userId].sort(),
    "the role filter narrows the deactivated accounts",
  );
  assert.equal(deactivatedMembers.total, 2);

  const activeAdministrators = await listDirectory({ status: "active", role: "administrator" });
  assert.deepEqual(activeAdministrators.users, [], "a deactivated administrator is not active");
  assert.equal(activeAdministrators.total, 0);
});

integration("an unknown status value is refused and leaves the stored rows untouched", async () => {
  const response = await adminGet(target(), listPath({ status: "suspended" }), actor(administrator).cookie);
  assertStatus(response, 400, "an unknown status is a malformed query");
  assert.deepEqual(await response.json(), { error: "invalid_query" });

  const stillDeactivated = await listDirectory({ status: "deactivated", pageSize: "100" });
  assert.deepEqual(
    stillDeactivated.users.map((row) => row.id).sort(),
    [entry(2).userId, entry(150).userId, entry(151).userId].sort(),
    "the refusal changed no stored state",
  );
  assert.deepEqual(await storedUser(entry(2).userId), { name: entry(2).name, email: entry(2).email });
});

integration("the edit records one event with the actor, the person and both addresses", async () => {
  const subject = entry(9);
  const nextEmail = `audited.person-10@${DIRECTORY_DOMAIN}`;
  const changed = await withAuditCapture(() =>
    adminPatch(
      target(),
      `${USERS_PATH}/${subject.userId}`,
      { name: subject.name, email: nextEmail },
      actor(administrator).cookie,
    ),
  );
  assertStatus(changed.result, 200, "the audited edit is applied");
  const events = changed.lines.filter((line) => line.event === "user.updated");
  assert.equal(events.length, 1, "one edit records exactly one event");
  const event = events[0] ?? {};
  assert.equal(event.actorId, actor(administrator).userId);
  assert.equal(event.actorRole, "administrator");
  assert.equal(event.subjectId, subject.userId);
  assert.equal(event.outcome, "applied");
  assert.equal(event.emailBefore, subject.email);
  assert.equal(event.emailAfter, nextEmail);
  assert.equal(JSON.stringify(event).includes("password"), false, "no credential reaches the line");

  const nameOnly = await withAuditCapture(() =>
    adminPatch(
      target(),
      `${USERS_PATH}/${subject.userId}`,
      { name: "Audited Name Only", email: nextEmail },
      actor(administrator).cookie,
    ),
  );
  assertStatus(nameOnly.result, 200, "a name-only edit is applied");
  const nameEvents = nameOnly.lines.filter((line) => line.event === "user.updated");
  assert.equal(nameEvents.length, 1);
  assert.equal("emailBefore" in (nameEvents[0] ?? {}), false, "an unchanged address is not recorded");

  const refused = await withAuditCapture(() =>
    adminPatch(
      target(),
      `${USERS_PATH}/${subject.userId}`,
      { name: "Refused", email: entry(0).email },
      actor(administrator).cookie,
    ),
  );
  assertStatus(refused.result, 409, "the duplicate address is still refused");
  assert.deepEqual(
    refused.lines.filter((line) => line.event === "user.updated"),
    [],
    "a refused edit records nothing",
  );
});
