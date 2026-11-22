import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier, Pool } from "pg";

import { commitUpload, writeArtifact } from "../apps/api/src/domain/commit-flow.ts";
import { getCurrentState } from "../apps/api/src/domain/commits.ts";
import { createUpload, putChunk } from "../apps/api/src/domain/staging.ts";
import {
  deleteRevisionBytes,
  getRevisionBytes,
  isRevisionStorageKey,
  REVISION_KEY_PREFIX,
} from "../apps/api/src/adapters/storage/s3.ts";
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
let admin: Pool;
let pool: Pool;
let database: Database;
let sdb: Database["db"];
let storage: Storage;
let databaseName = "";
let ownerId: string;
let otherOwnerId: string;

type Opts = {
  bytes: Uint8Array;
  uploadId: string;
  artifactId?: string;
  expectedRevisionId?: string;
  ownerId?: string;
  title?: string | null;
};
const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const expectValue = <T>(result: { ok: true; value: T } | { ok: false; kind: string; reason: string }): T =>
  result.ok ? result.value : assert.fail(`unexpected ${result.kind}: ${result.reason}`);
const commit = (input: Opts) => commitUpload({ database, storage, ...input, ownerId: input.ownerId ?? ownerId });
const titleOf = async (artifactId: string): Promise<string | null> =>
  (await pool.query<{ title: string | null }>(`select "title" from "artifacts" where "id" = $1`, [artifactId])).rows[0]
    ?.title ?? null;

async function stage(owner: string, bytes: Uint8Array, chunkSize = 4096): Promise<string> {
  const uploadId = `upload-${randomUUID()}`;
  assert.equal(
    (
      await createUpload(sdb, {
        ownerId: owner,
        uploadId,
        declaredSizeBytes: bytes.length,
        declaredSha256: digestOf(bytes),
      })
    ).ok,
    true,
    "upload declared",
  );
  for (let index = 0; index * chunkSize < bytes.length; index += 1) {
    const part = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
    assert.equal(
      (
        await putChunk(sdb, {
          ownerId: owner,
          uploadId,
          chunkIndex: index,
          sizeBytes: part.length,
          sha256: digestOf(part),
        })
      ).ok,
      true,
    );
  }
  return uploadId;
}

async function ownKeysGone(): Promise<void> {
  const rows = await pool.query<{ storageKey: string; sha256: string }>(
    `select "storageKey", "sha256" from "artifactRevisions"`,
  );
  let remaining = 0;
  for (const { storageKey, sha256 } of rows.rows) {
    await deleteRevisionBytes({ storage, storageKey });
    if ((await getRevisionBytes({ storage, storageKey, sha256 })).ok) remaining += 1;
  }
  assert.equal(remaining, 0, "every own key was deleted");
}

async function revisionObjectCount(): Promise<number> {
  const listed = await storage.client.send(
    new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: REVISION_KEY_PREFIX }),
  );
  return listed.KeyCount ?? listed.Contents?.length ?? 0;
}

const flowTest = (name: string, run: () => Promise<void>) =>
  test(name, { skip: ENV_READY ? false : "DATABASE_URL or S3 missing; run with --env-file=.env.local" }, run);

const stubDatabase = (): { database: Database; reads: () => number } => {
  let reads = 0;
  const database = {
    get db(): never {
      reads += 1;
      throw new Error("the domain reached the database before refusing the kind");
    },
  } as unknown as Database;
  return { database, reads: () => reads };
};

const stubStorage = (): { storage: Storage; requests: () => number } => {
  let requests = 0;
  const storage = {
    client: {
      send: async (): Promise<never> => {
        requests += 1;
        throw new Error("the domain reached storage before refusing the kind");
      },
    },
    bucket: "stub-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  } as unknown as Storage;
  return { storage, requests: () => requests };
};

test("an unknown kind is a validation refusal before any database or storage access", async () => {
  const bytes = Buffer.from("# Notes\n", "utf8");
  for (const entry of ["write", "commit"] as const) {
    const { database, reads } = stubDatabase();
    const { storage, requests } = stubStorage();
    const result =
      entry === "write"
        ? await writeArtifact({ database, storage, ownerId: "owner-1", bytes, kind: "pptx" })
        : await commitUpload({ database, storage, ownerId: "owner-1", uploadId: "upload-1", bytes, kind: "pptx" });
    assert.deepEqual(
      result,
      { ok: false, kind: "validation", reason: "unknown_artifact_kind" },
      `${entry} refuses a kind the registry does not declare`,
    );
    assert.equal(requests(), 0, `${entry} wrote nothing to storage`);
    assert.equal(reads(), 0, `${entry} read no database row`);
  }
});

before(async () => {
  if (!ENV_READY) return;
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
  database = createDatabase(testUrl.toString());
  pool = database.pool;
  sdb = database.db;
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  const endpoint = new URL(process.env.ARTIFLOW_S3_ENDPOINT ?? "");
  assert.equal(
    ["127.0.0.1", "localhost"].includes(endpoint.hostname) || process.env.ARTIFLOW_TEST_S3 === "1",
    true,
    "test storage must be loopback or ARTIFLOW_TEST_S3=1",
  );
  storage = createStorage({
    endpoint: endpoint.origin,
    region: (process.env.ARTIFLOW_S3_REGION ?? "us-east-1").trim() || "us-east-1",
    bucket: process.env.ARTIFLOW_S3_BUCKET ?? "",
    accessKeyId: process.env.ARTIFLOW_S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.ARTIFLOW_S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: true,
  });
  [ownerId, otherOwnerId] = [randomUUID(), randomUUID()];
  await pool.query(
    `insert into "user" ("id", "name", "email", "emailVerified") select "id", 'Flow Test Owner', "id" || '@example.test', false from unnest($1::text[]) as "id"`,
    [[ownerId, otherOwnerId]],
  );
});

after(async () => {
  if (!ENV_READY) return;
  await ownKeysGone();
  storage.destroy();
  await pool.end();
  const dropped = await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName)).then(
    () => true,
    () => false,
  );
  await admin.end();
  assert.equal(dropped, true, `Owned test database retained for manual cleanup: ${databaseName}`);
});

flowTest("commit persists a supplied title on creation and update and keeps it when omitted", async () => {
  const [first, second, third] = [randomBytes(512), randomBytes(768), randomBytes(256)];
  const created = expectValue(
    await commit({ uploadId: await stage(ownerId, first), bytes: first, title: "Forma — Comparativa" }),
  );
  assert.equal(await titleOf(created.artifactId), "Forma — Comparativa", "creation persists the title");
  const updated = expectValue(
    await commit({
      uploadId: await stage(ownerId, second),
      bytes: second,
      artifactId: created.artifactId,
      expectedRevisionId: created.revisionId,
      title: "Renamed by update",
    }),
  );
  assert.equal(updated.revisionNumber, 2);
  assert.equal(await titleOf(created.artifactId), "Renamed by update", "the update persists the supplied title");
  expectValue(
    await commit({
      uploadId: await stage(ownerId, third),
      bytes: third,
      artifactId: created.artifactId,
      expectedRevisionId: updated.revisionId,
    }),
  );
  assert.equal(await titleOf(created.artifactId), "Renamed by update", "omitting the title keeps the stored one");
});

flowTest("commit stores bytes, revision row, pointer and observed size, then advances on update", async () => {
  const [first, second] = [randomBytes(8192), randomBytes(2048)];
  const [firstDigest, secondDigest] = [digestOf(first), digestOf(second)];
  const uploadId = await stage(ownerId, first);
  const created = expectValue(await commit({ uploadId, bytes: first }));
  assert.deepEqual([created.revisionNumber, created.observedSizeBytes], [1, 8192]);
  assert.equal(isRevisionStorageKey(created.storageKey), true, "the flow persists a caller-generated key");
  const firstRow = await pool.query<{ storageKey: string; sha256: string }>(
    `select "storageKey", "sha256" from "artifactRevisions" where "id" = $1`,
    [created.revisionId],
  );
  assert.deepEqual(
    firstRow.rows[0],
    { storageKey: created.storageKey, sha256: firstDigest },
    "the row keeps the key and the digest the adapter verified",
  );
  const firstState = expectValue(await getCurrentState(sdb, created.artifactId, ownerId));
  assert.deepEqual(
    [firstState.currentRevisionId, firstState.observedSizeBytes, firstState.revisionCount],
    [created.revisionId, 8192, 1],
  );
  const stored = await getRevisionBytes({ storage, storageKey: created.storageKey, sha256: firstDigest });
  assert.deepEqual(Buffer.from(stored.ok ? stored.value.bytes : []), first);
  assert.equal(
    (await pool.query<{ status: string }>(`select "status" from "artifactUploads" where "id" = $1`, [uploadId])).rows[0]
      ?.status,
    "complete",
    "the upload is terminal after a commit",
  );
  const updated = expectValue(
    await commit({
      uploadId: await stage(ownerId, second),
      bytes: second,
      artifactId: created.artifactId,
      expectedRevisionId: created.revisionId,
    }),
  );
  const secondState = expectValue(await getCurrentState(sdb, created.artifactId, ownerId));
  assert.deepEqual(
    [updated.revisionNumber, secondState.currentRevisionId, secondState.observedSizeBytes, secondState.revisionCount],
    [2, updated.revisionId, 2048, 2],
  );
  assert.equal(
    (await getRevisionBytes({ storage, storageKey: created.storageKey, sha256: firstDigest })).ok,
    true,
    "the superseded revision stays immutable",
  );
  assert.equal((await getRevisionBytes({ storage, storageKey: updated.storageKey, sha256: secondDigest })).ok, true);
});

flowTest("a stale expected revision returns concurrent_commit and never moves the pointer", async () => {
  const [first, second] = [randomBytes(1024), randomBytes(512)];
  const created = expectValue(await commit({ uploadId: await stage(ownerId, first), bytes: first }));
  const stale = await commit({
    uploadId: await stage(ownerId, second),
    bytes: second,
    artifactId: created.artifactId,
    expectedRevisionId: randomUUID(),
  });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.kind, "concurrent_commit");
  assert.equal(stale.currentRevisionId, created.revisionId, "the result carries the current pointer");
  const state = expectValue(await getCurrentState(sdb, created.artifactId, ownerId));
  assert.deepEqual(
    [state.currentRevisionId, state.revisionCount],
    [created.revisionId, 1],
    "no pointer move and no revision row",
  );
});

flowTest("identical bytes recommitted to one artifact take a second key without a 23505", async () => {
  const bytes = randomBytes(640);
  const created = expectValue(await commit({ uploadId: await stage(ownerId, bytes), bytes }));
  const again = expectValue(
    await commit({
      uploadId: await stage(ownerId, bytes),
      bytes,
      artifactId: created.artifactId,
      expectedRevisionId: created.revisionId,
    }),
  );
  assert.equal(again.revisionNumber, 2);
  const secondRow = await pool.query<{ sha256: string }>(`select "sha256" from "artifactRevisions" where "id" = $1`, [
    again.revisionId,
  ]);
  assert.equal(secondRow.rows[0]?.sha256, digestOf(bytes), "identical bytes carry an identical digest");
  assert.notEqual(again.storageKey, created.storageKey, "a revision never reuses another revision's key");
  for (const [storageKey, sha256] of [
    [created.storageKey, digestOf(bytes)],
    [again.storageKey, digestOf(bytes)],
  ] as const) {
    const shared = await pool.query<{ count: number }>(
      `select count(*)::int as count from "artifactRevisions" where "storageKey" = $1`,
      [storageKey],
    );
    assert.equal(shared.rows[0]?.count, 1, "each key belongs to exactly one revision row");
    assert.equal((await getRevisionBytes({ storage, storageKey, sha256 })).ok, true, "both bodies stay readable");
  }
});

flowTest("a foreign upload is not_found and an expired upload expires before any S3 write", async () => {
  const [foreignBytes, expiredBytes] = [randomBytes(256), randomBytes(320)];
  const before = await revisionObjectCount();
  const expiredUpload = await stage(ownerId, expiredBytes);
  await pool.query(`update "artifactUploads" set "expiresAt" = now() - interval '1 minute' where "id" = $1`, [
    expiredUpload,
  ]);
  const foreign = await commit({ uploadId: await stage(otherOwnerId, foreignBytes), bytes: foreignBytes });
  assert.equal(foreign.ok ? "ok" : foreign.kind, "not_found");
  const expired = await commit({ uploadId: expiredUpload, bytes: expiredBytes });
  assert.equal(expired.ok ? "ok" : expired.kind, "expired");
  assert.equal(await revisionObjectCount(), before, "a refused commit wrote no revision body");
});
