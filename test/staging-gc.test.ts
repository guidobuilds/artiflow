import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier, Pool } from "pg";

import { commitUpload } from "../apps/api/src/domain/commit-flow.ts";
import { sweepStagingGarbage, type StagingSweepResult } from "../apps/api/src/domain/gc.ts";
import {
  deleteRevisionBytes,
  deleteStagingChunk,
  getRevisionBytes,
  putStagingChunk,
  stagingStorageKey,
  type DeletedRevision,
  type StorageResult,
} from "../apps/api/src/adapters/storage/s3.ts";
import { completeUpload, createUpload, putChunk } from "../apps/api/src/domain/staging.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { createStorage, type Storage } from "../apps/api/src/adapters/storage/client.ts";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const S3_VARS = [
  "ARTIFLOW_S3_ENDPOINT",
  "ARTIFLOW_S3_BUCKET",
  "ARTIFLOW_S3_ACCESS_KEY_ID",
  "ARTIFLOW_S3_SECRET_ACCESS_KEY",
];
const ENV_READY = Boolean(DATABASE_URL) && S3_VARS.every((name) => process.env[name]);
const SKIP = ENV_READY ? false : "DATABASE_URL or S3 missing; run with --env-file=.env.local";

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const ownKeys: { staging: string[]; revisions: { storageKey: string; sha256: string }[] } = {
  staging: [],
  revisions: [],
};

type Harness = { database: Database; storage: Storage; ownerId: string; close: () => Promise<void> };
let harness: Harness;

const putStagingBytes = async (bytes: Uint8Array): Promise<string> => {
  const sha256 = digestOf(bytes);
  assert.equal(await putStagingChunk(harness.storage, sha256, bytes), true, "staging byte seeded");
  ownKeys.staging.push(sha256);
  return sha256;
};

const stagingExists = async (sha256: string): Promise<boolean> => {
  try {
    await harness.storage.client.send(
      new GetObjectCommand({ Bucket: harness.storage.bucket, Key: stagingStorageKey(sha256) }),
    );
    return true;
  } catch {
    return false;
  }
};

const revisionExists = async (stored: { storageKey: string; sha256: string }): Promise<boolean> => {
  return (await getRevisionBytes({ storage: harness.storage, ...stored })).ok;
};

const uploadRowCount = async (uploadId: string): Promise<number> =>
  (
    await harness.database.pool.query<{ count: number }>(
      `select count(*)::int as count from "artifactUploads" where "id" = $1`,
      [uploadId],
    )
  ).rows[0]?.count ?? -1;
const chunkRowCount = async (uploadId: string): Promise<number> =>
  (
    await harness.database.pool.query<{ count: number }>(
      `select count(*)::int as count from "artifactChunks" where "uploadId" = $1`,
      [uploadId],
    )
  ).rows[0]?.count ?? -1;

const expire = async (uploadId: string): Promise<void> => {
  await harness.database.pool.query(
    `update "artifactUploads" set "expiresAt" = now() - interval '1 minute' where "id" = $1`,
    [uploadId],
  );
};

const seedUpload = async (
  bytes: Uint8Array,
  options: { complete?: boolean; expire?: boolean; chunkCount?: number } = {},
): Promise<string> => {
  const uploadId = `upload-${randomUUID()}`;
  assert.equal(
    (
      await createUpload(harness.database.db, {
        ownerId: harness.ownerId,
        uploadId,
        declaredSizeBytes: bytes.length,
        declaredSha256: digestOf(bytes),
      })
    ).ok,
    true,
  );
  const sha256 = await putStagingBytes(bytes);
  assert.equal(
    (
      await putChunk(harness.database.db, {
        ownerId: harness.ownerId,
        uploadId,
        chunkIndex: 0,
        sizeBytes: bytes.length,
        sha256,
      })
    ).ok,
    true,
  );
  if (options.complete) {
    assert.equal((await completeUpload(harness.database.db, { ownerId: harness.ownerId, uploadId })).ok, true);
  }
  if (options.expire) await expire(uploadId);
  return uploadId;
};

before(async () => {
  if (!ENV_READY) return;
  const url = new URL(DATABASE_URL);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  assert.equal(url.pathname, "/artiflow", "owned database name");
  const admin = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  const databaseName = `artiflow_gc_test_${randomUUID().replaceAll("-", "")}`;
  assert.equal(/^artiflow_gc_test_[0-9a-f]{32}$/.test(databaseName), true);
  await admin.query("SELECT 1");
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  const database = createDatabase(new URL(`/${databaseName}`, DATABASE_URL).toString());
  await migrate(drizzle(database.pool), { migrationsFolder: MIGRATIONS });
  const ownerId = randomUUID();
  await database.pool.query(
    `insert into "user" ("id", "name", "email", "emailVerified") values ($1, 'GC Test Owner', $2, false)`,
    [ownerId, `gc-owner-${ownerId}@example.test`],
  );
  const endpoint = new URL(process.env.ARTIFLOW_S3_ENDPOINT ?? "");
  assert.equal(
    ["127.0.0.1", "localhost"].includes(endpoint.hostname) || process.env.ARTIFLOW_TEST_S3 === "1",
    true,
    "test storage must be loopback or ARTIFLOW_TEST_S3=1",
  );
  const storage = createStorage({
    endpoint: endpoint.origin,
    region: (process.env.ARTIFLOW_S3_REGION ?? "us-east-1").trim() || "us-east-1",
    bucket: process.env.ARTIFLOW_S3_BUCKET ?? "",
    accessKeyId: process.env.ARTIFLOW_S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.ARTIFLOW_S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: true,
  });
  harness = {
    database,
    storage,
    ownerId,
    close: async (): Promise<void> => {
      for (const sha256 of ownKeys.staging) await deleteStagingChunk({ storage, sha256 });
      for (const stored of ownKeys.revisions) await deleteRevisionBytes({ storage, storageKey: stored.storageKey });
      const leftovers: string[] = [];
      for (const sha256 of ownKeys.staging) if (await stagingExists(sha256)) leftovers.push(stagingStorageKey(sha256));
      storage.destroy();
      await database.close().catch(() => undefined);
      let retained = "";
      try {
        await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
      } catch {
        retained = databaseName;
      }
      await admin.end().catch(() => undefined);
      assert.deepEqual(
        [leftovers, retained],
        [[], ""],
        `Owned test residue: keys ${leftovers.join(",")} db ${retained}`,
      );
    },
  };
});

after(async () => {
  if (harness) await harness.close();
});

const sweep = async (): Promise<StagingSweepResult> =>
  sweepStagingGarbage({ db: harness.database.db, storage: harness.storage, now: new Date() });

const envTest = (name: string, run: () => Promise<void>): void => {
  test(name, { skip: ENV_READY ? SKIP : "DATABASE_URL or S3 missing; run with --env-file=.env.local" }, run);
};

envTest("the sweep collects terminal and expired staging bytes and never touches open or revision bytes", async () => {
  const openBytes = randomBytes(512);
  const openDigest = digestOf(openBytes);
  const openUploadId = await seedUpload(openBytes);
  const sharedDigest = openDigest;
  const sharedUploadId = `upload-${randomUUID()}`;
  assert.equal(
    (
      await createUpload(harness.database.db, {
        ownerId: harness.ownerId,
        uploadId: sharedUploadId,
        declaredSizeBytes: openBytes.length,
        declaredSha256: openDigest,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await putChunk(harness.database.db, {
        ownerId: harness.ownerId,
        uploadId: sharedUploadId,
        chunkIndex: 0,
        sizeBytes: openBytes.length,
        sha256: sharedDigest,
      })
    ).ok,
    true,
  );
  assert.equal(
    (await completeUpload(harness.database.db, { ownerId: harness.ownerId, uploadId: sharedUploadId })).ok,
    true,
  );
  const terminalBytes = randomBytes(384);
  const terminalUploadId = await seedUpload(terminalBytes, { complete: true });
  const terminalDigest = digestOf(terminalBytes);
  const expiredBytes = randomBytes(256);
  const expiredUploadId = await seedUpload(expiredBytes, { expire: true });
  const expiredDigest = digestOf(expiredBytes);
  const artifactBytes = randomBytes(1024);
  const artifactUploadId = await seedUpload(artifactBytes);
  const committed = await commitUpload({
    database: harness.database,
    storage: harness.storage,
    ownerId: harness.ownerId,
    uploadId: artifactUploadId,
    bytes: artifactBytes,
    title: "gc probe",
  });
  assert.equal(committed.ok, true);
  if (!committed.ok) return;
  const committedKey = { storageKey: committed.value.storageKey, sha256: digestOf(artifactBytes) };
  ownKeys.revisions.push(committedKey);

  const result = await sweep();

  assert.equal(result.expiredUploads, 1, "the expired upload row is removed");
  assert.equal(result.failed, 0, "no storage failure expected");
  assert.equal(result.deleted >= 2, true, `terminal and expired bytes collected (deleted=${result.deleted})`);
  assert.equal(await stagingExists(terminalDigest), false, "terminal-only staged bytes are collected");
  assert.equal(await stagingExists(expiredDigest), false, "expired-upload staged bytes are collected");
  assert.equal(await stagingExists(openDigest), true, "bytes an open upload still needs are retained (S3)");
  assert.equal(await revisionExists(committedKey), true, "revision bytes are never touched (S2)");
  assert.equal(await uploadRowCount(expiredUploadId), 0, "the expired upload row is gone");
  assert.equal(await uploadRowCount(openUploadId), 1, "the open upload row survives");
  assert.equal(await chunkRowCount(openUploadId), 1, "the open upload's chunk claim survives");
  assert.equal(await uploadRowCount(terminalUploadId), 1, "a complete upload row is never collected (S2)");
  assert.equal(
    await chunkRowCount(terminalUploadId),
    0,
    "collected terminal chunk claims are cleared so the candidate set stays bounded",
  );
});

envTest("re-running the sweep with nothing collectable reports zero and leaves storage unchanged", async () => {
  const bytes = randomBytes(320);
  const digest = digestOf(bytes);
  await seedUpload(bytes);
  const before = await stagingExists(digest);
  const result = await sweep();
  assert.deepEqual(result, { expiredUploads: 0, candidates: 0, deleted: 0, failed: 0 });
  assert.equal(await stagingExists(digest), before, "an idempotent sweep mutates nothing");
});

envTest("one failed storage delete does not abandon the remaining candidates and keeps its claim row", async () => {
  const failedBytes = randomBytes(128);
  const okBytes = randomBytes(192);
  const failedDigest = digestOf(failedBytes);
  const okDigest = digestOf(okBytes);
  await seedUpload(failedBytes, { expire: true });
  await seedUpload(okBytes, { expire: true });
  const failing = async (input: { storage: Storage; sha256: string }): Promise<StorageResult<DeletedRevision>> =>
    input.sha256 === failedDigest
      ? { ok: false, kind: "conflict", reason: "injected sweep failure" }
      : deleteStagingChunk(input);
  const result = await sweepStagingGarbage({
    db: harness.database.db,
    storage: harness.storage,
    now: new Date(),
    deleteStagingChunkFn: failing,
  });
  assert.equal(result.failed, 1, "the injected failure is reported, not swallowed");
  assert.equal(result.deleted, 1, "the other candidate is still collected (S4)");
  assert.equal(await stagingExists(okDigest), false, "the surviving candidate's bytes are gone");
  assert.equal(await stagingExists(failedDigest), true, "the failed candidate's bytes are retained for the next sweep");
  const failedUploadId =
    (
      await harness.database.pool.query<{ id: string }>(
        `select "id" from "artifactUploads" where "declaredSha256" = $1`,
        [digestOf(failedBytes)],
      )
    ).rows[0]?.id ?? "";
  assert.notEqual(failedUploadId, "", "the failed upload row is retained for retry");
  assert.equal(await chunkRowCount(failedUploadId), 1, "the failed digest keeps its claim row");
  const okUploadId =
    (
      await harness.database.pool.query<{ id: string }>(
        `select "id" from "artifactUploads" where "declaredSha256" = $1`,
        [digestOf(okBytes)],
      )
    ).rows[0]?.id ?? "";
  assert.equal(okUploadId, "", "the successful upload row is gone");
});
