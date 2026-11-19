import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier, Pool } from "pg";

import { createDatabase } from "../apps/api/src/adapters/postgres/db/client.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const DATABASE_AVAILABLE = Boolean(process.env.DATABASE_URL);
const databaseTest = (name: string, run: () => Promise<void>): void => {
  test(name, { skip: DATABASE_AVAILABLE ? false : "DATABASE_URL not provided; run with --env-file=.env.local" }, run);
};
type Harness = { pool: Pool; ownerId: string; recipientId: string; artifactId: string; close: () => Promise<void> };

const insertUser = async (pool: Pool, label: string): Promise<string> => {
  const id = randomUUID();
  await pool.query(`insert into "user" ("id", "name", "email") values ($1, $2, $3)`, [
    id,
    `I5a ${label}`,
    `i5a-${label}-${id}@example.test`,
  ]);
  return id;
};

async function startHarness(): Promise<Harness> {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  assert.equal(
    LOOPBACK_HOSTS.has(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  assert.equal(decodeURIComponent(url.pathname.replace(/^\//, "")), "artiflow", "owned database name");
  const admin = new Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  const name = `artiflow_artifact_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query("SELECT 1");
  await admin.query("CREATE DATABASE " + escapeIdentifier(name));
  const testUrl = new URL(raw);
  testUrl.pathname = `/${name}`;
  const database = createDatabase(testUrl.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: MIGRATIONS_FOLDER });
  const ownerId = await insertUser(database.pool, "owner");
  const recipientId = await insertUser(database.pool, "recipient");
  const artifactId = randomUUID();
  await database.pool.query(`insert into artifacts ("id", "ownerId", "title") values ($1, $2, 'I5a shared artifact')`, [
    artifactId,
    ownerId,
  ]);
  const close = async (): Promise<void> => {
    await database.close().catch(() => undefined);
    let retained = "";
    try {
      await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(name));
    } catch {
      retained = name;
    }
    await admin.end().catch(() => undefined);
    assert.equal(retained, "", `Owned test database retained for manual cleanup: ${retained}`);
  };
  return { pool: database.pool, ownerId, recipientId, artifactId, close };
}

let harness: Harness;
before(async () => {
  if (DATABASE_AVAILABLE) harness = await startHarness();
});
after(async () => {
  if (harness) await harness.close();
});

const expectCode = (query: Promise<unknown>, code: string): Promise<void> =>
  assert.rejects(query, (error: { code?: string }) => {
    assert.equal(error.code, code, `expected SQLSTATE ${code}`);
    return true;
  });
const countRows = async (table: string, column: string, value: string): Promise<number | undefined> => {
  const result = await harness.pool.query<{ count: number }>(
    `select count(*)::int as count from ${escapeIdentifier(table)} where "${column}" = $1`,
    [value],
  );
  return result.rows[0]?.count;
};
const newArtifact = async (title: string): Promise<string> => {
  const id = randomUUID();
  await harness.pool.query(`insert into artifacts ("id", "ownerId", "title") values ($1, $2, $3)`, [
    id,
    harness.ownerId,
    title,
  ]);
  return id;
};
const uniqueHash = (): string => createHash("sha256").update(randomUUID()).digest("hex");
const share = (artifactId: string, recipient: string, grantedBy = harness.ownerId) =>
  harness.pool.query(
    `insert into "artifactShares" ("artifactId", "sharedWithUserId", "grantedByUserId") values ($1, $2, $3) returning "id", "createdAt"`,
    [artifactId, recipient, grantedBy],
  );
const link = (artifactId: string, tokenHash: string, rotatedFromId: string | null = null) =>
  harness.pool.query(
    `insert into "artifactPublicLinks" ("artifactId", "tokenHash", "rotatedFromId") values ($1, $2, $3) returning "id", "revokedAt"`,
    [artifactId, tokenHash, rotatedFromId],
  );

databaseTest("a grant is one read-only row per recipient and repeats are rejected", async () => {
  const created = await share(harness.artifactId, harness.recipientId);
  assert.match(created.rows[0]?.id as string, UUID_RE, "uuid id comes from the database default");
  assert.ok(created.rows[0]?.createdAt instanceof Date, "createdAt defaults to now()");
  await expectCode(share(harness.artifactId, harness.recipientId, harness.recipientId), "23505");
  const otherArtifact = await newArtifact("I5a second artifact");
  await share(otherArtifact, harness.recipientId);
  assert.equal(await countRows("artifactShares", "artifactId", otherArtifact), 1);
});

databaseTest("deleting an artifact removes its grants and public links, and nothing else", async () => {
  const doomed = await newArtifact("I5a doomed artifact");
  const survivor = await newArtifact("I5a surviving artifact");
  await share(doomed, harness.recipientId);
  await share(survivor, harness.recipientId);
  await link(doomed, uniqueHash());
  await link(survivor, uniqueHash());
  await harness.pool.query(`delete from artifacts where "id" = $1`, [doomed]);
  assert.deepEqual(
    [
      await countRows("artifactShares", "artifactId", doomed),
      await countRows("artifactPublicLinks", "artifactId", doomed),
    ],
    [0, 0],
  );
  assert.deepEqual(
    [
      await countRows("artifactShares", "artifactId", survivor),
      await countRows("artifactPublicLinks", "artifactId", survivor),
    ],
    [1, 1],
  );
});

databaseTest("deleting either account removes the grant", async () => {
  const recipient = await insertUser(harness.pool, "temporary recipient");
  await share(harness.artifactId, recipient);
  await harness.pool.query(`delete from "user" where "id" = $1`, [recipient]);
  assert.equal(
    await countRows("artifactShares", "sharedWithUserId", recipient),
    0,
    "recipient deletion cascades the grant",
  );
  const granter = await insertUser(harness.pool, "temporary granter");
  await share(harness.artifactId, granter, granter);
  await harness.pool.query(`delete from "user" where "id" = $1`, [granter]);
  assert.equal(await countRows("artifactShares", "grantedByUserId", granter), 0, "granter deletion cascades the grant");
});

databaseTest("only one row can own a token hash, so a lookup resolves to one link", async () => {
  const hash = uniqueHash();
  await link(harness.artifactId, hash);
  await expectCode(link(await newArtifact("I5a hash collision"), hash), "23505");
  assert.equal(await countRows("artifactPublicLinks", "artifactId", harness.artifactId), 1);
});

databaseTest("revocation sets a timestamp and keeps the row, and no link carries an expiry", async () => {
  const created = await link(harness.artifactId, uniqueHash());
  assert.equal(created.rows[0]?.revokedAt, null, "a fresh link is live (revokedAt nullable)");
  const id = created.rows[0]?.id as string;
  await harness.pool.query(`update "artifactPublicLinks" set "revokedAt" = now() where "id" = $1`, [id]);
  const stored = await harness.pool.query<{ revokedAt: Date | null }>(
    `select "revokedAt" from "artifactPublicLinks" where "id" = $1`,
    [id],
  );
  assert.equal(stored.rows.length, 1, "revoked links are retained, not deleted");
  assert.ok(stored.rows[0]?.revokedAt instanceof Date, "revokedAt records the revocation");
  const columns = await harness.pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_name = 'artifactPublicLinks' order by 1`,
  );
  const names = columns.rows.map((row) => row.column_name);
  assert.deepEqual(names, ["artifactId", "createdAt", "id", "revokedAt", "rotatedFromId", "showComments", "tokenHash"]);
  assert.equal(
    names.some((name) => /expir/i.test(name)),
    false,
    "links never expire (decision)",
  );
});

databaseTest("rotation records its predecessor and survives losing it", async () => {
  const predecessor = (await link(harness.artifactId, uniqueHash())).rows[0]?.id as string;
  const successor = (await link(harness.artifactId, uniqueHash(), predecessor)).rows[0]?.id as string;
  const rotated = await harness.pool.query<{ id: string; revokedAt: Date }>(
    `update "artifactPublicLinks" set "revokedAt" = now() where "id" = $1 returning "id", "revokedAt"`,
    [predecessor],
  );
  assert.equal(rotated.rows.length, 1, "predecessor is revoked in place");
  await harness.pool.query(`delete from "artifactPublicLinks" where "id" = $1`, [predecessor]);
  const survivor = await harness.pool.query<{ rotatedFromId: string | null; revokedAt: Date | null }>(
    `select "rotatedFromId", "revokedAt" from "artifactPublicLinks" where "id" = $1`,
    [successor],
  );
  assert.deepEqual(
    [survivor.rows.length, survivor.rows[0]?.rotatedFromId, survivor.rows[0]?.revokedAt],
    [1, null, null],
  );
});

databaseTest(
  "grant rows carry the defaulted role enum and every reference has the approved delete action",
  async () => {
    const columns = await harness.pool.query<{
      column_name: string;
      column_default: string | null;
      is_nullable: string;
    }>(
      `select column_name, column_default, is_nullable from information_schema.columns where table_name = 'artifactShares' order by 1`,
    );
    const rows = new Map(columns.rows.map((row) => [row.column_name, row]));
    assert.deepEqual(
      [...rows.keys()],
      ["artifactId", "createdAt", "grantedByUserId", "id", "role", "sharedWithUserId"],
    );
    const role = rows.get("role");
    assert.ok(role, "artifactShares.role exists");
    assert.equal(role.is_nullable, "NO", "role is NOT NULL");
    assert.equal(role.column_default, "'reader'::text", "existing grants stay read-only");
    const checks = await harness.pool.query<{ conname: string; pg_get_constraintdef: string }>(
      `select conname, pg_get_constraintdef(c.oid) from pg_constraint c join pg_class cl on cl.oid = c.conrelid
      where c.contype = 'c' and cl.relname = 'artifactShares'`,
    );
    assert.deepEqual(
      checks.rows.map((row) => [row.conname, row.pg_get_constraintdef]),
      [
        [
          "artifactShares_role_check",
          `CHECK ((role = ANY (ARRAY['reader'::text, 'editor'::text, 'commenter'::text])))`,
        ],
      ],
      "role is database-checked",
    );
    const keys = await harness.pool.query<{ table_name: string; column_name: string; delete_action: string }>(
      `select cl.relname as table_name, a.attname as column_name, c.confdeltype as delete_action
       from pg_constraint c
       join pg_class cl on cl.oid = c.conrelid
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and cl.relname in ('artifactShares', 'artifactPublicLinks')
      order by 1, 2`,
    );
    assert.deepEqual(
      keys.rows.map((row) => [row.table_name, row.column_name, row.delete_action]),
      [
        ["artifactPublicLinks", "artifactId", "c"],
        ["artifactPublicLinks", "rotatedFromId", "n"],
        ["artifactShares", "artifactId", "c"],
        ["artifactShares", "grantedByUserId", "c"],
        ["artifactShares", "sharedWithUserId", "c"],
      ],
    );
  },
);

test("the 0006 migration only adds the two tables, their keys and indexes", () => {
  const drizzleDir = new URL("../drizzle/", import.meta.url);
  const files = readdirSync(drizzleDir).filter((name) => /^0006_.*\.sql$/.test(name));
  assert.deepEqual(files, ["0006_eminent_thunderbolts.sql"], "exactly one 0006 migration");
  const sql = readFileSync(new URL(files[0] as string, drizzleDir), "utf8");
  const statements = sql.split("--> statement-breakpoint").map((part) => part.trim());
  assert.equal(statements.length, 2 + 5 + 5, "two tables, five foreign keys, five indexes");
  for (const statement of statements) {
    assert.match(
      statement,
      /^(CREATE TABLE "artifact(Shares|PublicLinks)"|CREATE (UNIQUE )?INDEX "artifact(Shares|PublicLinks)_|ALTER TABLE "artifact(Shares|PublicLinks)" ADD CONSTRAINT)/,
      statement.slice(0, 70),
    );
  }
  for (const line of sql.split("\n")) {
    assert.equal(
      /^(DROP|DELETE|UPDATE|INSERT|TRUNCATE)\b/i.test(line),
      false,
      `no destructive or DML statement: ${line}`,
    );
  }
  const journal = readFileSync(new URL("meta/_journal.json", drizzleDir), "utf8");
  assert.ok(
    journal.includes(`"idx": 6`) && journal.includes(`"tag": "0006_eminent_thunderbolts"`),
    "journal records idx 6",
  );
  assert.ok(journal.includes(`"idx": 7`) && journal.includes(`"tag": "0007_`), "journal records idx 7");
});
