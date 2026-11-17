import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier, Pool } from "pg";

import {
  createArtifactWithRevision,
  getCurrentState,
  markArtifactDeleted,
  renameArtifact,
  setRevisionCas,
  type CommitFailure,
  type CommitResult,
  type RevisionInput,
} from "../apps/api/src/domain/commits.ts";
import { MAX_ARTIFACT_BYTES } from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { selectReadRevision } from "../apps/api/src/adapters/postgres/comments-repo.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const databaseTest = (name: string, run: () => Promise<void>): void => {
  test(name, { skip: DATABASE_URL ? false : "DATABASE_URL not provided; run with --env-file=.env.local" }, run);
};
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
let admin: Pool;
let pool: Pool;
let sdb: Database["db"];
let databaseName = "";
let ownerId: string;
let otherOwnerId: string;

const codeOf = (error: unknown): string | undefined =>
  (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
const nextRevision = (overrides: Partial<RevisionInput> = {}): RevisionInput => ({
  revision: 1,
  sizeBytes: 8,
  sha256: DIGEST_A,
  storageKey: `artifacts/${randomUUID().replaceAll("-", "")}`,
  observedSizeBytes: 8,
  ...overrides,
});
const expectValue = <T>(result: CommitResult<T>): T =>
  result.ok ? result.value : assert.fail(`unexpected ${result.kind}: ${result.reason}`);
const expectFailure = <T>(result: CommitResult<T>, kind: CommitFailure["kind"]): CommitFailure => {
  assert.equal(result.ok ? "ok" : result.kind, kind, `expected a ${kind} failure`);
  if (result.ok) assert.fail("unreachable");
  return result;
};
const create = (revision = nextRevision(), artifactId = `artifact-${randomUUID()}`, owner = ownerId) =>
  createArtifactWithRevision(sdb, { ownerId: owner, artifactId, title: "Doc", revision });
const cas = (artifactId: string, expectedRevisionId: string | null, next = nextRevision(), title?: string | null) =>
  setRevisionCas(sdb, { artifactId, ownerId, expectedRevisionId, next, title });

before(async () => {
  if (!DATABASE_URL) return;
  const url = new URL(DATABASE_URL);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  assert.equal(url.pathname, "/artiflow", "owned database name");
  admin = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  databaseName = `artiflow_artifact_test_${randomUUID().replaceAll("-", "")}`;
  assert.equal(/^artiflow_artifact_test_[0-9a-f]{32}$/.test(databaseName), true);
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  const testUrl = new URL(DATABASE_URL);
  testUrl.pathname = `/${databaseName}`;
  const database = createDatabase(testUrl.toString());
  pool = database.pool;
  sdb = database.db;
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  [ownerId, otherOwnerId] = [randomUUID(), randomUUID()];
  await pool.query(
    `insert into "user" ("id", "name", "email", "emailVerified") select "id", 'Commit Test Owner', "id" || '@example.test', false from unnest($1::text[]) as "id"`,
    [[ownerId, otherOwnerId]],
  );
});
after(async () => {
  if (!DATABASE_URL) return;
  await pool.end();
  const dropped = await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName)).then(
    () => true,
    () => false,
  );
  await admin.end();
  assert.equal(dropped, true, `Owned test database retained for manual cleanup: ${databaseName}`);
});

databaseTest("create sets the pointer, persists the observed size and never crosses owners", async () => {
  const created = expectValue(await create());
  const state = expectValue(await getCurrentState(sdb, created.artifactId, ownerId));
  assert.equal(created.revisionNumber, 1);
  assert.equal(state.currentRevisionId, created.revisionId);
  assert.equal(state.observedSizeBytes, 8, "the committed size is persisted, not recomputed later");
  assert.equal(state.deletedAt, null);
  assert.equal(state.revisionCount, 1);
  assert.equal(
    expectFailure(await create(nextRevision(), created.artifactId), "conflict").currentRevisionId,
    created.revisionId,
  );
  expectFailure(await create(nextRevision(), created.artifactId, otherOwnerId), "not_found");
  expectFailure(await getCurrentState(sdb, created.artifactId, otherOwnerId), "not_found");
});

databaseTest("invalid revisions, failed inserts and the observed size cap are enforced by data", async () => {
  const artifactId = `artifact-${randomUUID()}`;
  const upper = await create(nextRevision({ sha256: DIGEST_A.toUpperCase() }), artifactId);
  assert.equal(expectFailure(upper, "validation").reason, "revision_digest_not_lowercase_hex_sha256");
  const storageKey = `artifacts/${randomUUID().replaceAll("-", "")}`;
  const capTarget = expectValue(await create(nextRevision({ storageKey })));
  const shared = expectValue(await create(nextRevision({ storageKey }), artifactId));
  assert.notEqual(shared.artifactId, capTarget.artifactId, "the shared key backs two distinct artifacts");
  const sharedKeys = await pool.query<{ count: number }>(
    `select count(*)::int as count from "artifactRevisions" where "storageKey" = $1`,
    [storageKey],
  );
  assert.equal(sharedKeys.rows[0]?.count, 2, "both revisions reference the same content-addressed key");
  const oversized = await pool
    .query(`update "artifacts" set "observedSizeBytes" = $1 where "id" = $2`, [
      MAX_ARTIFACT_BYTES + 1,
      capTarget.artifactId,
    ])
    .then(
      () => "accepted",
      (error: unknown) => codeOf(error),
    );
  assert.equal(oversized, "23514", "the 16 MiB cap is a database CHECK");
});

databaseTest("renameArtifact changes only the title and allocates no revision", async () => {
  const created = expectValue(await create());
  const renamed = expectValue(await renameArtifact(sdb, { artifactId: created.artifactId, ownerId, title: "Renamed" }));
  assert.equal(renamed.artifactId, created.artifactId);
  assert.equal(renamed.title, "Renamed");
  assert.equal(renamed.currentRevisionId, created.revisionId, "the pointer is untouched");
  assert.equal(renamed.revisionCount, 1, "no revision row is allocated");
  const after = expectValue(await getCurrentState(sdb, created.artifactId, ownerId));
  assert.equal(after.revisionCount, 1);
  const read = (await selectReadRevision(sdb, ownerId, created.artifactId))!;
  assert.equal(read.title, "Renamed");
});

databaseTest("renameArtifact repeats idempotently and CASes against the pointer", async () => {
  const created = expectValue(await create());
  const again = expectValue(await renameArtifact(sdb, { artifactId: created.artifactId, ownerId, title: "Renamed" }));
  assert.equal(again.title, "Renamed");
  const withCas = expectValue(
    await renameArtifact(sdb, {
      artifactId: created.artifactId,
      ownerId,
      title: "Third name",
      expectedRevisionId: created.revisionId,
    }),
  );
  assert.equal(withCas.title, "Third name");
  const stale = expectFailure(
    await renameArtifact(sdb, {
      artifactId: created.artifactId,
      ownerId,
      title: "Never",
      expectedRevisionId: "stale-" + "0".repeat(24),
    }),
    "concurrent_commit",
  );
  assert.equal(stale.currentRevisionId, created.revisionId);
  const final = (await selectReadRevision(sdb, ownerId, created.artifactId))!;
  assert.equal(final.title, "Third name", "a losing CAS never renames");
});

databaseTest("renameArtifact refuses foreign, deleted and blank renames", async () => {
  const created = expectValue(await create());
  const foreign = expectFailure(
    await renameArtifact(sdb, { artifactId: created.artifactId, ownerId: otherOwnerId, title: "Mine" }),
    "not_found",
  );
  assert.equal(foreign.currentRevisionId, null);
  expectFailure(await renameArtifact(sdb, { artifactId: "", ownerId, title: "X" }), "validation");
  expectFailure(await renameArtifact(sdb, { artifactId: created.artifactId, ownerId, title: "   " }), "validation");
  const deleted = expectValue(await markArtifactDeleted(sdb, created.artifactId, ownerId));
  const gone = expectFailure(
    await renameArtifact(sdb, { artifactId: created.artifactId, ownerId, title: "Ghost" }),
    "gone",
  );
  assert.notEqual(deleted.deletedAt, null);
  assert.equal(gone.currentRevisionId, null, "a gone rename carries no retry pointer");
});

databaseTest("renameArtifact keeps the deleted check ahead of the title write", async () => {
  const created = expectValue(await create());
  await markArtifactDeleted(sdb, created.artifactId, ownerId);
  expectFailure(await renameArtifact(sdb, { artifactId: created.artifactId, ownerId, title: "Ghost" }), "gone");
  const read = (await selectReadRevision(sdb, ownerId, created.artifactId))!;
  assert.notEqual(read.title, "Ghost");
});

databaseTest("setRevisionCas advances the pointer and refuses a stale expectation", async () => {
  const created = expectValue(await create());
  const committed = expectValue(
    await cas(
      created.artifactId,
      created.revisionId,
      nextRevision({ revision: 2, observedSizeBytes: 12, sha256: DIGEST_B }),
    ),
  );
  const state = expectValue(await getCurrentState(sdb, created.artifactId, ownerId));
  assert.equal(committed.revisionNumber, 2);
  assert.equal(state.currentRevisionId, committed.revisionId);
  assert.equal(state.observedSizeBytes, 12);
  assert.equal(state.revisionCount, 2);
  const stale = expectFailure(
    await cas(created.artifactId, created.revisionId, nextRevision({ revision: 3 })),
    "concurrent_commit",
  );
  assert.equal(stale.currentRevisionId, committed.revisionId);
  const after = expectValue(await getCurrentState(sdb, created.artifactId, ownerId));
  assert.equal(after.currentRevisionId, committed.revisionId, "a losing CAS never moves the pointer");
  assert.equal(after.revisionCount, 2, "a losing CAS allocates no revision row");
});

databaseTest("a CAS update persists a supplied title and keeps it when the commit omits one", async () => {
  const titleOf = async (artifactId: string): Promise<string | null> =>
    (await pool.query<{ title: string | null }>(`select "title" from "artifacts" where "id" = $1`, [artifactId]))
      .rows[0]?.title ?? null;
  const created = expectValue(await create());
  assert.equal(await titleOf(created.artifactId), "Doc", "creation persists the title");
  expectValue(
    await cas(
      created.artifactId,
      created.revisionId,
      nextRevision({ revision: 2, sha256: DIGEST_B }),
      "Forma — Comparativa",
    ),
  );
  assert.equal(await titleOf(created.artifactId), "Forma — Comparativa", "the CAS update persists the supplied title");
  const state2 = expectValue(await getCurrentState(sdb, created.artifactId, ownerId));
  expectValue(await cas(created.artifactId, state2.currentRevisionId, nextRevision({ revision: 3 })));
  assert.equal(
    await titleOf(created.artifactId),
    "Forma — Comparativa",
    "an update without a title keeps the existing one",
  );
  const state3 = expectValue(await getCurrentState(sdb, created.artifactId, ownerId));
  expectValue(
    await cas(created.artifactId, state3.currentRevisionId, nextRevision({ revision: 4, sha256: DIGEST_B }), null),
  );
  assert.equal(
    await titleOf(created.artifactId),
    "Forma — Comparativa",
    "an explicit null title keeps the existing one",
  );
});

databaseTest("CAS from a null pointer works and a reused revision number conflicts", async () => {
  const artifactId = `artifact-${randomUUID()}`;
  await pool.query(`insert into "artifacts" ("id", "ownerId", "title") values ($1, $2, 'Bare')`, [artifactId, ownerId]);
  const committed = expectValue(await cas(artifactId, null));
  const reused = expectFailure(await cas(artifactId, committed.revisionId, nextRevision()), "conflict");
  assert.equal(reused.reason, "unique_constraint_violation");
  const state = expectValue(await getCurrentState(sdb, artifactId, ownerId));
  assert.equal(state.currentRevisionId, committed.revisionId);
  assert.equal(state.revisionCount, 1, "the rejected insert left no revision row");
});

databaseTest("a soft deleted artifact is gone and deletion is idempotent", async () => {
  const created = expectValue(await create());
  const deleted = expectValue(await markArtifactDeleted(sdb, created.artifactId, ownerId));
  const again = expectValue(await markArtifactDeleted(sdb, created.artifactId, ownerId));
  assert.equal(again.deletedAt.getTime(), deleted.deletedAt.getTime(), "deletion keeps the first stamp");
  expectFailure(await cas(created.artifactId, created.revisionId, nextRevision({ revision: 2 })), "gone");
  expectFailure(await markArtifactDeleted(sdb, created.artifactId, otherOwnerId), "not_found");
});
