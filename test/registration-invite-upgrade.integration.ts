import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { hashPassword } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { loadConfig } from "../apps/api/src/config.ts";
import {
  COMPLETE_PATH,
  PREVIEW_PATH,
  assertNoLeak,
  assertNoSession,
  invitationCredential,
  invitePost,
  inviteRequest,
  sessionCookie,
  signInEmail,
  startInvitationHarness,
  type InvitationHarness,
} from "./helpers/registration-invites.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CURRENT_MIGRATIONS = join(PROJECT_ROOT, "drizzle");
const SESSION_PATH = "/api/auth/get-session";
const LEGACY_MIGRATION_COUNT = 10;

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };
type Identity = { id?: string; email?: string; name?: string; emailVerified?: boolean };
type AccountRow = { id: string; name: string; email: string; emailVerified: boolean };
type AccountCounts = { users: number; accounts: number };

async function readAccountRow(target: InvitationHarness, email: string): Promise<AccountRow[]> {
  const { rows } = await target.database.pool.query<AccountRow>(
    `SELECT "id", "name", "email", "emailVerified" FROM "user" WHERE "email" = $1`,
    [email],
  );
  return rows;
}

async function countAccountRows(target: InvitationHarness): Promise<AccountCounts | undefined> {
  const { rows } = await target.database.pool.query<AccountCounts>(
    `SELECT (SELECT count(*)::int FROM "user") AS "users", (SELECT count(*)::int FROM "account") AS "accounts"`,
  );
  return rows[0];
}

async function seedLegacyCredentialUser(
  target: InvitationHarness,
  email: string,
  password: string,
): Promise<string> {
  const userId = randomUUID();
  const now = new Date();
  await target.database.pool.query(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, false, $4, $4)`,
    [userId, "Existing Owner", email, now],
  );
  await target.database.pool.query(
    `INSERT INTO "account" ("id", "userId", "providerId", "accountId", "password", "createdAt", "updatedAt")
     VALUES ($1, $2, 'credential', $2, $3, $4, $4)`,
    [randomUUID(), userId, await hashPassword(password), now],
  );
  return userId;
}

async function legacyMigrationsFolder(): Promise<string> {
  const journal = JSON.parse(await readFile(join(CURRENT_MIGRATIONS, "meta/_journal.json"), "utf8")) as Journal;
  const upgrade = journal.entries.find((entry) => entry.tag === "0010_registration_invites");
  assert.ok(upgrade, "the current journal must carry the invitation migration");
  const legacy = journal.entries.filter((entry) => entry.idx < upgrade.idx);
  assert.equal(legacy.length, LEGACY_MIGRATION_COUNT, "the legacy stage must be the whole 0000-0009 journal prefix");
  assert.deepEqual(
    [legacy[0]?.idx, legacy.at(-1)?.idx, legacy.at(-1)?.tag],
    [0, 9, "0009_productive_hardball"],
    "the legacy stage must be idx 0..9 inclusive and end at the 0009 migration",
  );
  assert.equal(
    legacy.some((entry) => entry.tag === upgrade.tag),
    false,
    "the legacy stage must not already contain the invitation migration",
  );

  const folder = await mkdtemp(join(tmpdir(), "artic-legacy-migrations-"));
  await mkdir(join(folder, "meta"));
  await writeFile(join(folder, "meta/_journal.json"), `${JSON.stringify({ ...journal, entries: legacy }, null, 2)}\n`);
  for (const entry of legacy) {
    await copyFile(join(CURRENT_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

test(
  "an account created before 0010 keeps its identity and only then accepts an invitation",
  { timeout: 180_000 },
  async () => {
    const config = loadConfig(process.env);
    const legacy = await legacyMigrationsFolder();
    let harness: InvitationHarness | null = null;
    try {
      harness = await startInvitationHarness(config, { migrationsFolder: legacy });
      const target = harness;
      const session = async (cookie: string): Promise<Identity | null> => {
        const response = await inviteRequest(target, SESSION_PATH, { headers: { cookie } });
        assert.equal(response.status, 200);
        return ((await response.json()) as { user?: Identity } | null)?.user ?? null;
      };

      const email = `upgrade-${randomUUID()}@example.test`;
      const password = `upgrade-password-${randomUUID()}`;
      const seededUserId = await seedLegacyCredentialUser(target, email, password);
      const legacyRows = await readAccountRow(target, email);
      assert.equal(legacyRows.length, 1, "the legacy stage holds exactly one row for the seeded account");
      const before = legacyRows[0];
      assert.equal(before?.id, seededUserId, "the legacy identity keeps the id it was seeded with");
      assert.equal(before?.name, "Existing Owner");
      assert.equal(before?.email, email);
      assert.equal(before?.emailVerified, false);
      assert.deepEqual(
        await countAccountRows(target),
        { users: 1, accounts: 1 },
        "the legacy stage holds one account row and its one credential row",
      );

      const refusedEmail = `legacy-${randomUUID()}@example.test`;
      let refusal = "";
      try {
        target.issue(refusedEmail);
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      assert.equal(
        refusal.includes("invitation: the database is unavailable; check DATABASE_URL and that migrations are applied."),
        true,
        `the operator command must be refused on the 0009 schema, got: ${refusal}`,
      );
      assert.equal(refusal.includes("#token="), false, "a refused command prints no invitation URL");
      assert.equal(refusal.length < 600, true, "the refusal stays one bounded line");
      const absent = await readAccountRow(target, refusedEmail);
      assert.equal(absent.length, 0, "the refused invitation created no account");
      assert.deepEqual(
        await countAccountRows(target),
        { users: 1, accounts: 1 },
        "the refused invitation added no row of any kind",
      );

      await migrate(drizzle(target.database.pool), { migrationsFolder: CURRENT_MIGRATIONS });

      const upgradedRows = await readAccountRow(target, email);
      assert.equal(upgradedRows.length, 1, "the upgrade keeps exactly one row for the pre-existing account");
      assert.deepEqual(
        upgradedRows[0],
        before,
        "the pre-existing account keeps its id, name, email and unverified state through the upgrade",
      );

      const again = await signInEmail(target, email, password);
      assert.equal(again.status, 200, "the pre-upgrade password still signs in after the upgrade");
      const againUser = await session(sessionCookie(again));
      assert.equal(againUser?.id, before?.id, "the pre-existing account keeps its id through the upgrade");
      assert.equal(againUser?.name, before?.name, "the pre-existing account keeps its name through the upgrade");
      assert.equal(againUser?.email, email, "the pre-existing account keeps its email through the upgrade");
      assert.equal(againUser?.emailVerified, false, "the upgrade never verifies the pre-existing account");

      const issued = target.issue(`  Upgraded-${randomUUID()}@Example.TEST  `);
      assert.equal(issued.token.length, 43);
      const preview = await invitePost(target, PREVIEW_PATH, { token: issued.token });
      assert.equal(preview.status, 200);
      assert.deepEqual(await preview.json(), { email: issued.email });

      const { name, password: invitedPassword } = invitationCredential();
      const completion = await invitePost(target, COMPLETE_PATH, {
        token: issued.token,
        name,
        password: invitedPassword,
      });
      assert.equal(completion.status, 200);
      const text = await completion.text();
      assert.deepEqual(JSON.parse(text), { ok: true });
      assertNoLeak(text, [issued.token, invitedPassword]);
      assertNoSession(completion);

      const created = await signInEmail(target, issued.email, invitedPassword);
      assert.equal(created.status, 200, "the invited account signs in with its own password");
      const createdUser = await session(sessionCookie(created));
      assert.equal(createdUser?.email, issued.email);
      assert.equal(createdUser?.name, name);
      assert.equal(createdUser?.emailVerified, false, "the upgrade never verifies an invited account");
      assert.equal(createdUser?.id === before?.id, false);
    } finally {
      await harness?.close();
      await rm(legacy, { recursive: true, force: true });
    }
  },
);
