import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  seedCredentialUser,
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
      await seedCredentialUser(target, email, password);

      const signedIn = await signInEmail(target, email, password);
      assert.equal(signedIn.status, 200, "the seeded identity signs in on the legacy schema");
      const cookie = sessionCookie(signedIn);
      const before = await session(cookie);
      assert.equal(before?.email, email);
      assert.equal(before?.emailVerified, false);
      assert.equal(typeof before?.id, "string");

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
      const absent = await signInEmail(target, refusedEmail, `no-account-${randomUUID()}`);
      assert.equal(absent.status >= 400, true, "the refused invitation created no account");
      assertNoSession(absent);

      await migrate(drizzle(target.database.pool), { migrationsFolder: CURRENT_MIGRATIONS });

      const carried = await session(cookie);
      assert.equal(carried?.id, before?.id, "the pre-upgrade session keeps its user id");
      assert.equal(carried?.name, before?.name, "the pre-upgrade session keeps its name");
      assert.equal(carried?.email, email, "the pre-upgrade session keeps its email");

      const again = await signInEmail(target, email, password);
      assert.equal(again.status, 200, "the existing password still signs in after the upgrade");
      const againUser = await session(sessionCookie(again));
      assert.equal(againUser?.id, before?.id, "the existing account keeps its identity");
      assert.equal(againUser?.name, before?.name);

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
