import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier, Pool } from "pg";

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const DATABASE_AVAILABLE = Boolean(process.env.DATABASE_URL);
const databaseTest = (name: string, run: () => Promise<void>): void => {
  test(name, { skip: DATABASE_AVAILABLE ? false : "DATABASE_URL not provided; run with --env-file=.env.local" }, run);
};
let admin: Pool,
  pool: Pool,
  finalPool: Pool,
  databaseName = "",
  stagedFolder: string;

const legacyComment = async (values: {
  parentId?: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  quote: string;
  body: string;
  resolved?: boolean;
}): Promise<string> => {
  const id = randomUUID();
  await pool.query(
    `insert into "artifactComments"
       ("id", "artifactId", "authorId", "parentId", "anchorStartLine", "anchorStartCol", "anchorEndLine", "anchorEndCol", "quotedText", "body", "resolvedAt")
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      process.env.MIGRATION_TEST_ARTIFACT_ID!,
      process.env.MIGRATION_TEST_AUTHOR_ID!,
      values.parentId ?? null,
      values.startLine,
      values.startCol,
      values.endLine,
      values.endCol,
      values.quote,
      values.body,
      values.resolved ? new Date() : null,
    ],
  );
  return id;
};

before(async () => {
  if (!DATABASE_AVAILABLE) return;
  const raw = process.env.DATABASE_URL!;
  const url = new URL(raw);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  admin = new Pool({ connectionString: raw, max: 1, connectionTimeoutMillis: 5000 });
  databaseName = `artiflow_anchor_migration_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query("SELECT 1");
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  const testUrl = new URL(`/${databaseName}`, raw);

  stagedFolder = mkdtempSync(join(tmpdir(), "artiflow-anchor-migration-"));
  for (const entry of readdirSync(MIGRATIONS_FOLDER))
    cpSync(join(MIGRATIONS_FOLDER, entry), join(stagedFolder, entry), { recursive: true });
  const journal = JSON.parse(readFileSync(join(stagedFolder, "meta", "_journal.json"), "utf8"));
  const legacyEntries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 11);
  assert.equal(legacyEntries.length, 12, "the staged journal keeps every migration before the anchor split");
  writeFileSync(
    join(stagedFolder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: legacyEntries }, null, 2),
  );
  const stagedPool = new Pool({ connectionString: testUrl.toString(), max: 1 });
  const staged = drizzle(stagedPool);
  await migrate(staged, { migrationsFolder: stagedFolder });
  await stagedPool.end();

  const authorId = randomUUID();
  const artifactId = randomUUID();
  pool = new Pool({ connectionString: testUrl.toString(), max: 1 });
  await pool.query(
    `insert into "user" ("id", "name", "email") values ($1, 'Anchor Migration', 'anchor-migration-${authorId}@example.test')`,
    [authorId],
  );
  await pool.query(`insert into "artifacts" ("id", "ownerId", "title") values ($1, $2, 'Anchor migration')`, [
    artifactId,
    authorId,
  ]);
  process.env.MIGRATION_TEST_AUTHOR_ID = authorId;
  process.env.MIGRATION_TEST_ARTIFACT_ID = artifactId;
});

after(async () => {
  if (!DATABASE_AVAILABLE) return;
  await pool.end();
  await finalPool.end();
  await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
  await admin.end();
  rmSync(stagedFolder, { recursive: true, force: true });
  delete process.env.MIGRATION_TEST_ARTIFACT_ID;
  delete process.env.MIGRATION_TEST_AUTHOR_ID;
});

databaseTest("legacy line/column comments migrate into text-range anchors without loss", async () => {
  const root = await legacyComment({
    startLine: 3,
    startCol: 1,
    endLine: 4,
    endCol: 12,
    quote: "multi\nline",
    body: "Root",
  });
  const reply = await legacyComment({
    parentId: root,
    startLine: 3,
    startCol: 1,
    endLine: 4,
    endCol: 12,
    quote: "multi\nline",
    body: "Reply",
  });
  const resolved = await legacyComment({
    startLine: 1,
    startCol: 1,
    endLine: 1,
    endCol: 6,
    quote: "First",
    body: "Resolved",
    resolved: true,
  });

  finalPool = new Pool({ connectionString: new URL(`/${databaseName}`, process.env.DATABASE_URL!).toString(), max: 1 });
  await migrate(drizzle(finalPool), {
    migrationsFolder: MIGRATIONS_FOLDER,
  });

  const columns = await pool.query(
    `select column_name from information_schema.columns where table_name = 'artifactComments' order by column_name`,
  );
  const names = columns.rows.map((row: { column_name: string }) => row.column_name).sort();
  assert.deepEqual(names, [
    "anchor",
    "artifactId",
    "authorId",
    "body",
    "createdAt",
    "id",
    "parentId",
    "resolvedAt",
    "resolvedBy",
    "revisionId",
    "updatedAt",
  ]);

  const { rows } = await pool.query<{
    id: string;
    parentId: string | null;
    anchor: Record<string, unknown>;
    resolvedBy: string | null;
    revisionId: string | null;
    resolvedAt: Date | null;
  }>(
    `select "id", "parentId", "anchor", "resolvedBy", "revisionId", "resolvedAt" from "artifactComments" order by "createdAt", "id"`,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.deepEqual(byId.get(root)!.anchor, {
    kind: "text-range",
    startLine: 3,
    startCol: 1,
    endLine: 4,
    endCol: 12,
    quotedText: "multi\nline",
  });
  assert.equal(byId.get(reply)!.anchor, null);
  assert.deepEqual(byId.get(resolved)!.anchor, {
    kind: "text-range",
    startLine: 1,
    startCol: 1,
    endLine: 1,
    endCol: 6,
    quotedText: "First",
  });
  for (const row of rows) {
    assert.equal(row.resolvedBy, null);
    assert.equal(row.revisionId, null);
    if (row.parentId === null) assert.ok(row.anchor);
    else assert.equal(row.anchor, null);
  }
  assert.ok(byId.get(resolved)!.resolvedAt);

  await assert.rejects(
    pool.query(
      `insert into "artifactComments" ("id", "artifactId", "authorId", "parentId", "body") values ($1, $2, $3, null, 'no anchor')`,
      [randomUUID(), process.env.MIGRATION_TEST_ARTIFACT_ID, process.env.MIGRATION_TEST_AUTHOR_ID],
    ),
    /root_anchor_check/,
  );
  await assert.rejects(
    pool.query(
      `insert into "artifactComments" ("id", "artifactId", "authorId", "parentId", "anchor", "body") values ($1, $2, $3, $4, $5, 'reply with anchor')`,
      [
        randomUUID(),
        process.env.MIGRATION_TEST_ARTIFACT_ID,
        process.env.MIGRATION_TEST_AUTHOR_ID,
        root,
        JSON.stringify({ kind: "page-point", x: 0.5, y: 1, viewportWidth: 800 }),
      ],
    ),
    /root_anchor_check/,
  );
  await assert.rejects(
    pool.query(
      `insert into "artifactComments" ("id", "artifactId", "authorId", "parentId", "anchor", "body") values ($1, $2, $3, null, $4, 'bad kind')`,
      [
        randomUUID(),
        process.env.MIGRATION_TEST_ARTIFACT_ID,
        process.env.MIGRATION_TEST_AUTHOR_ID,
        JSON.stringify({ kind: "bogus" }),
      ],
    ),
    /anchor_kind_check/,
  );
  await assert.rejects(
    pool.query(
      `insert into "artifactComments" ("id", "artifactId", "authorId", "parentId", "anchor", "body") values ($1, $2, $3, null, $4, 'long quote')`,
      [
        randomUUID(),
        process.env.MIGRATION_TEST_ARTIFACT_ID,
        process.env.MIGRATION_TEST_AUTHOR_ID,
        JSON.stringify({
          kind: "text-range",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 2,
          quotedText: "x".repeat(2001),
        }),
      ],
    ),
    /quote_cap_check/,
  );
  await pool.query(
    `insert into "artifactComments" ("id", "artifactId", "authorId", "parentId", "anchor", "body") values ($1, $2, $3, null, $4, 'html shape is a valid row')`,
    [
      randomUUID(),
      process.env.MIGRATION_TEST_ARTIFACT_ID,
      process.env.MIGRATION_TEST_AUTHOR_ID,
      JSON.stringify({ kind: "element", selector: "p", point: { x: 0.5, y: 0.5 }, textHint: "", viewportWidth: 800 }),
    ],
  );
});
