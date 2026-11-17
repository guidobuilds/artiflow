import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier, Pool } from "pg";

import {
  abortUpload,
  completeUpload,
  createUpload,
  deleteExpiredUploads,
  getUpload,
  listChunks,
  putChunk,
  type StagingFailure,
  type StagingResult,
} from "../apps/api/src/domain/staging.ts";
import {
  MAX_ARTIFACT_BYTES,
  MAX_CHUNK_BYTES,
  STAGING_TTL_MINUTES,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DATABASE_AVAILABLE = Boolean(process.env.DATABASE_URL);
const databaseTest = (name: string, run: () => Promise<void>): void => {
  test(name, { skip: DATABASE_AVAILABLE ? false : "DATABASE_URL not provided; run with --env-file=.env.local" }, run);
};
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

type Harness = { pool: Pool; db: Database["db"]; ownerId: string; otherOwnerId: string; close: () => Promise<void> };

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
  assert.equal(/^artiflow_artifact_test_[0-9a-f]{32}$/.test(name), true);
  await admin.query("SELECT 1");
  await admin.query("CREATE DATABASE " + escapeIdentifier(name));
  const testUrl = new URL(raw);
  testUrl.pathname = `/${name}`;
  const database = createDatabase(testUrl.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: MIGRATIONS_FOLDER });
  const seedOwner = async (): Promise<string> => {
    const id = randomUUID();
    await database.pool.query(
      `insert into "user" ("id", "name", "email", "emailVerified") values ($1, 'Staging Test Owner', $2, false)`,
      [id, `staging-owner-${id}@example.test`],
    );
    return id;
  };
  const ownerId = await seedOwner();
  const otherOwnerId = await seedOwner();
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
  return { pool: database.pool, db: database.db, ownerId, otherOwnerId, close };
}

let harness: Harness;
before(async () => {
  if (DATABASE_AVAILABLE) harness = await startHarness();
});
after(async () => {
  if (harness) await harness.close();
});

const newUploadId = (): string => `upload-${randomUUID()}`;
const expectValue = <T>(result: StagingResult<T>): T => {
  if (!result.ok) assert.fail(`unexpected ${result.kind}: ${result.reason}`);
  return result.value;
};
const expectFailure = <T>(result: StagingResult<T>, kind: StagingFailure["kind"]): StagingFailure => {
  assert.equal(result.ok, false, `expected a ${kind} failure`);
  if (result.ok) assert.fail("unreachable");
  assert.equal(result.kind, kind);
  return result;
};
type CreateInput = { ownerId: string; uploadId: string; declaredSizeBytes: number; declaredSha256: string };
const openUpload = (
  overrides: Partial<CreateInput> = {},
): Promise<StagingResult<{ id: string; expiresAt: Date; status: string }>> =>
  createUpload(harness.db, {
    ownerId: harness.ownerId,
    uploadId: newUploadId(),
    declaredSizeBytes: 8,
    declaredSha256: DIGEST_A,
    ...overrides,
  });
const stageChunk = (uploadId: string, chunkIndex: number, sizeBytes: number, sha256 = DIGEST_A, now?: Date) =>
  putChunk(harness.db, { ownerId: harness.ownerId, uploadId, chunkIndex, sizeBytes, sha256, now });
const countCollectable = async (): Promise<number> => {
  const result = await harness.pool.query<{ count: number }>(
    `select count(*)::int as count from "artifactUploads" where "status" <> 'complete'`,
  );
  return result.rows[0]?.count ?? -1;
};

databaseTest("an upload never crosses owners and is reported as not_found", async () => {
  const created = expectValue(await openUpload());
  const uploadId = created.id;
  const other = harness.otherOwnerId;
  expectFailure(await getUpload(harness.db, uploadId, other), "not_found");
  expectFailure(await listChunks(harness.db, uploadId, other), "not_found");
  expectFailure(
    await putChunk(harness.db, { ownerId: other, uploadId, chunkIndex: 0, sizeBytes: 8, sha256: DIGEST_A }),
    "not_found",
  );
  expectFailure(await abortUpload(harness.db, uploadId, other), "not_found");
  expectFailure(await completeUpload(harness.db, { ownerId: other, uploadId }), "not_found");
  expectFailure(
    await createUpload(harness.db, { ownerId: other, uploadId, declaredSizeBytes: 8, declaredSha256: DIGEST_A }),
    "not_found",
  );
  assert.equal(expectValue(await getUpload(harness.db, uploadId, harness.ownerId)).status, "open");
});

databaseTest("createUpload is idempotent for one declaration and conflicts on a different one", async () => {
  const uploadId = newUploadId();
  const first = expectValue(await openUpload({ uploadId }));
  const second = expectValue(await openUpload({ uploadId }));
  assert.equal(second.id, first.id);
  assert.equal(
    second.expiresAt.getTime(),
    first.expiresAt.getTime(),
    "a retry reuses the row instead of extending the ttl",
  );
  expectFailure(await openUpload({ uploadId, declaredSha256: DIGEST_B }), "conflict");
  expectFailure(await openUpload({ uploadId, declaredSizeBytes: 9 }), "conflict");
  assert.deepEqual(expectValue(await listChunks(harness.db, uploadId, harness.ownerId)).chunks, []);
});

databaseTest("createUpload rejects out-of-range sizes and non-hex digests as validation", async () => {
  const base: CreateInput = {
    ownerId: harness.ownerId,
    uploadId: newUploadId(),
    declaredSizeBytes: 8,
    declaredSha256: DIGEST_A,
  };
  expectFailure(await createUpload(harness.db, { ...base, declaredSizeBytes: MAX_ARTIFACT_BYTES + 1 }), "validation");
  expectFailure(await createUpload(harness.db, { ...base, declaredSizeBytes: 0 }), "validation");
  expectFailure(await createUpload(harness.db, { ...base, declaredSha256: "A".repeat(64) }), "validation");
  expectFailure(await createUpload(harness.db, { ...base, declaredSha256: "a".repeat(63) }), "validation");
  expectFailure(await getUpload(harness.db, base.uploadId, harness.ownerId), "not_found");
  assert.equal(MAX_ARTIFACT_BYTES, 16_777_216);
});

databaseTest("putChunk accepts one idempotent retry and rejects a different payload for the same index", async () => {
  const created = expectValue(await openUpload());
  const first = expectValue(await stageChunk(created.id, 0, 4));
  const second = expectValue(await stageChunk(created.id, 0, 4));
  assert.equal(second.id, first.id, "a byte-identical retry keeps the stored chunk");
  expectFailure(await stageChunk(created.id, 0, 4, DIGEST_B), "conflict");
  expectFailure(await stageChunk(created.id, 0, 5), "conflict");
  const listing = expectValue(await listChunks(harness.db, created.id, harness.ownerId));
  assert.equal(listing.chunks.length, 1);
  assert.equal(listing.nextIndex, 1);
  assert.deepEqual(listing.missing, []);
});

databaseTest("putChunk rejects oversized chunks, out-of-range indices and non-hex digests", async () => {
  const created = expectValue(await openUpload({ declaredSizeBytes: MAX_ARTIFACT_BYTES }));
  expectFailure(await stageChunk(created.id, 0, MAX_CHUNK_BYTES + 1), "validation");
  expectFailure(await stageChunk(created.id, 0, 0), "validation");
  expectFailure(await stageChunk(created.id, 16, 4), "validation");
  expectFailure(await stageChunk(created.id, -1, 4), "validation");
  expectFailure(await stageChunk(created.id, 0, 4, "z".repeat(64)), "validation");
  assert.equal(MAX_CHUNK_BYTES, 1_048_576);
});

databaseTest("an expired upload rejects new chunks and completion", async () => {
  const created = expectValue(await openUpload());
  expectValue(await stageChunk(created.id, 0, 8));
  const later = new Date(Date.now() + (STAGING_TTL_MINUTES + 1) * 60_000);
  expectFailure(await stageChunk(created.id, 1, 1, DIGEST_A, later), "expired");
  expectFailure(
    await completeUpload(harness.db, { ownerId: harness.ownerId, uploadId: created.id, now: later }),
    "expired",
  );
  assert.equal(
    expectValue(await getUpload(harness.db, created.id, harness.ownerId)).status,
    "open",
    "expiry is not applied by reading",
  );
});

databaseTest("a chunk range with a gap reports it and cannot complete", async () => {
  const created = expectValue(await openUpload({ declaredSizeBytes: 8 }));
  expectValue(await stageChunk(created.id, 0, 4));
  expectValue(await stageChunk(created.id, 2, 4, DIGEST_B));
  const listing = expectValue(await listChunks(harness.db, created.id, harness.ownerId));
  assert.deepEqual(
    listing.chunks.map((chunk) => chunk.chunkIndex),
    [0, 2],
    "chunks arrive in index order",
  );
  assert.equal(listing.nextIndex, 1);
  assert.deepEqual(listing.missing, [1]);
  const failure = expectFailure(
    await completeUpload(harness.db, { ownerId: harness.ownerId, uploadId: created.id }),
    "conflict",
  );
  assert.equal(failure.reason, "staged_chunk_range_not_contiguous");
});

databaseTest("staged sizes must add up to the declared size", async () => {
  const created = expectValue(await openUpload({ declaredSizeBytes: 9 }));
  expectValue(await stageChunk(created.id, 0, 4));
  expectValue(await stageChunk(created.id, 1, 4, DIGEST_B));
  const failure = expectFailure(
    await completeUpload(harness.db, { ownerId: harness.ownerId, uploadId: created.id }),
    "conflict",
  );
  assert.equal(failure.reason, "staged_size_mismatch");
});

databaseTest("a contiguous, size-matching upload completes once and is then terminal", async () => {
  const created = expectValue(await openUpload());
  expectValue(await stageChunk(created.id, 0, 4));
  expectValue(await stageChunk(created.id, 1, 4, DIGEST_B));
  const done = expectValue(await completeUpload(harness.db, { ownerId: harness.ownerId, uploadId: created.id }));
  assert.equal(done.upload.status, "complete");
  assert.equal(done.chunkCount, 2);
  assert.equal(done.totalSizeBytes, 8);
  assert.equal(
    done.upload.expiresAt.getTime(),
    created.expiresAt.getTime(),
    "completion keeps the recorded expiry stamp",
  );
  expectFailure(await completeUpload(harness.db, { ownerId: harness.ownerId, uploadId: created.id }), "conflict");
  expectFailure(await abortUpload(harness.db, created.id, harness.ownerId), "conflict");
  expectFailure(await stageChunk(created.id, 2, 4), "conflict");
});

databaseTest("an upload with no staged chunks cannot complete", async () => {
  const created = expectValue(await openUpload());
  expectFailure(await completeUpload(harness.db, { ownerId: harness.ownerId, uploadId: created.id }), "conflict");
});

databaseTest("abortUpload is idempotent and stops further chunks", async () => {
  const created = expectValue(await openUpload());
  assert.equal(expectValue(await abortUpload(harness.db, created.id, harness.ownerId)).status, "aborted");
  assert.equal(expectValue(await abortUpload(harness.db, created.id, harness.ownerId)).status, "aborted");
  expectFailure(await stageChunk(created.id, 0, 4), "conflict");
  expectFailure(await getUpload(harness.db, newUploadId(), harness.ownerId), "not_found");
});

databaseTest("deleteExpiredUploads removes only expired non-complete uploads", async () => {
  const open = expectValue(await openUpload());
  expectValue(await stageChunk(open.id, 0, 8));
  const aborted = expectValue(await openUpload());
  expectValue(await abortUpload(harness.db, aborted.id, harness.ownerId));
  const complete = expectValue(await openUpload({ declaredSizeBytes: 4 }));
  expectValue(await stageChunk(complete.id, 0, 4));
  expectValue(await completeUpload(harness.db, { ownerId: harness.ownerId, uploadId: complete.id }));
  const before = await countCollectable();
  const later = new Date(Date.now() + (STAGING_TTL_MINUTES + 1) * 60_000);
  assert.equal(await deleteExpiredUploads(harness.db, later), before, "every expired non-complete upload is collected");
  assert.equal(await countCollectable(), 0, "completed uploads are never collected as garbage");
  expectFailure(await getUpload(harness.db, open.id, harness.ownerId), "not_found");
  expectFailure(await getUpload(harness.db, aborted.id, harness.ownerId), "not_found");
  const chunks = await harness.pool.query<{ count: number }>(
    `select count(*)::int as count from "artifactChunks" where "uploadId" = any($1::text[])`,
    [[open.id, aborted.id]],
  );
  assert.equal(chunks.rows[0]?.count, 0, "chunks are removed with their upload");
  assert.equal(expectValue(await getUpload(harness.db, complete.id, harness.ownerId)).status, "complete");
  const fresh = expectValue(await openUpload());
  assert.equal(await deleteExpiredUploads(harness.db, new Date()), 0, "unexpired staging is left alone");
  assert.equal(expectValue(await getUpload(harness.db, fresh.id, harness.ownerId)).status, "open");
});
