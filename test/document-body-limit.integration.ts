import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier, Pool } from "pg";

import { MAX_ARTIFACT_BYTES } from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { createApiApp } from "../apps/api/src/app.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { commitUpload } from "../apps/api/src/domain/commit-flow.ts";
import { createUpload, putChunk } from "../apps/api/src/domain/staging.ts";
import { createStorage, type Storage } from "../apps/api/src/adapters/storage/client.ts";
import { trustedSession } from "./helpers/trusted-accounts.ts";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const S3_VARS = [
  "ARTIFLOW_S3_ENDPOINT",
  "ARTIFLOW_S3_BUCKET",
  "ARTIFLOW_S3_ACCESS_KEY_ID",
  "ARTIFLOW_S3_SECRET_ACCESS_KEY",
];
const ENV_READY = Boolean(DATABASE_URL) && S3_VARS.every((name) => process.env[name]);
const SKIP = ENV_READY ? false : "DATABASE_URL or S3 missing; run with --env-file=test/integration-config.example";
const config = ENV_READY ? loadConfig(process.env) : undefined;
const publicOrigin = config?.publicOrigin ?? "";
const MUTATION = { "content-type": "application/json", origin: publicOrigin };
const OVER_CAP_BY = 512;

type Owner = { cookie: string; userId: string };
type Doc = { id: string; revisionId: string };

let admin: Pool, pool: Pool, storage: Storage, server: ReturnType<typeof serve>;
let database: Database;
let baseUrl = "",
  databaseName = "";
let owner: Owner, doc: Doc;

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type Reply = { status: number; text: string; json: Record<string, unknown> | null; headers: Headers };
const read = async (path: string, init: RequestInit = {}, user?: Owner): Promise<Reply> => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, ...(user ? { cookie: user.cookie } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : null,
    headers: response.headers,
  };
};

const seedOwner = async (): Promise<Owner> => {
  const session = await trustedSession(
    { database, baseUrl, origin: publicOrigin },
    { name: "Body Limit Owner", email: `body-limit-${randomUUID()}@example.test` },
  );
  return { cookie: session.cookie, userId: session.userId };
};

const seed = async (user: Owner, text: string): Promise<Doc> => {
  const bytes = Buffer.from(text, "utf8");
  const uploadId = `upload-${randomUUID()}`;
  const sha256 = digestOf(bytes);
  assert.equal(
    (
      await createUpload(database.db, {
        ownerId: user.userId,
        uploadId,
        declaredSizeBytes: bytes.length,
        declaredSha256: sha256,
      })
    ).ok,
    true,
  );
  assert.equal(
    (await putChunk(database.db, { ownerId: user.userId, uploadId, chunkIndex: 0, sizeBytes: bytes.length, sha256 }))
      .ok,
    true,
  );
  const committed = await commitUpload({
    database,
    storage,
    ownerId: user.userId,
    uploadId,
    bytes,
    title: "Body limit doc",
    kind: "markdown",
  });
  if (!committed.ok) throw new Error(`seed refused: ${committed.reason}`);
  return { id: committed.value.artifactId, revisionId: committed.value.revisionId };
};

const revisionCount = async (artifactId: string): Promise<number> =>
  (
    await pool.query<{ count: number }>(`select count(*)::int as count from "artifactRevisions" where "artifactId" = $1`, [
      artifactId,
    ])
  ).rows[0]?.count ?? -1;

const currentRevisionOf = async (artifactId: string): Promise<string | null> =>
  (
    await pool.query<{ currentRevisionId: string | null }>(
      `select "currentRevisionId" from "artifacts" where "id" = $1`,
      [artifactId],
    )
  ).rows[0]?.currentRevisionId ?? null;

before(async () => {
  if (!config) return;
  const url = new URL(DATABASE_URL);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  admin = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  databaseName = `artiflow_body_limit_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  const testUrl = new URL(`/${databaseName}`, DATABASE_URL);
  const migratePool = new Pool({ connectionString: testUrl.toString(), max: 1 });
  await migrate(drizzle(migratePool), { migrationsFolder: MIGRATIONS });
  await migratePool.end();
  database = createDatabase(testUrl.toString());
  pool = database.pool;
  storage = createStorage({
    endpoint: new URL(process.env.ARTIFLOW_S3_ENDPOINT ?? "").origin,
    region: (process.env.ARTIFLOW_S3_REGION ?? "us-east-1").trim() || "us-east-1",
    bucket: process.env.ARTIFLOW_S3_BUCKET ?? "",
    accessKeyId: process.env.ARTIFLOW_S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.ARTIFLOW_S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: true,
  });
  const app = createApiApp({ config, database, storage });
  server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    started.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  owner = await seedOwner();
  doc = await seed(owner, "# Body limit doc\n\nfirst paragraph\n");
});

after(async () => {
  if (!ENV_READY) return;
  const rows = await pool.query<{ storageKey: string }>(`select distinct "storageKey" from "artifactRevisions"`);
  for (const { storageKey } of rows.rows) {
    await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: storageKey }));
    const left = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: storageKey })).then(
      () => true,
      () => false,
    );
    assert.equal(left, false, "every own S3 key was deleted");
  }
  storage.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
  await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
  const leftover = await admin.query<{ count: number }>(
    "select count(*)::int as count from pg_database where datname like $1",
    ["artiflow_body_limit_test_%"],
  );
  assert.equal(leftover.rows[0]?.count, 0, "no throwaway database remains");
  await admin.end();
});

test(
  "an over-cap document save is refused with the typed body limit before any JSON parse",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const path = `/api/artifacts/${doc.id}/document`;
    const revisionsBefore = await revisionCount(doc.id);
    const envelope = (text: string): string => JSON.stringify({ text, expectedRevisionId: doc.revisionId });
    const overhead = Buffer.byteLength(envelope(""));
    const oversized = envelope("a".repeat(MAX_ARTIFACT_BYTES + OVER_CAP_BY - overhead));
    assert.equal(Buffer.byteLength(oversized), MAX_ARTIFACT_BYTES + OVER_CAP_BY, "the save is just over the cap");

    const refused = await read(path, { method: "PUT", headers: MUTATION, body: oversized }, owner);
    assert.deepEqual([refused.status, refused.json], [413, { error: "too_large", maxBytes: MAX_ARTIFACT_BYTES }]);

    const unparseable = "x".repeat(MAX_ARTIFACT_BYTES + OVER_CAP_BY);
    const beforeParse = await read(path, { method: "PUT", headers: MUTATION, body: unparseable }, owner);
    assert.deepEqual([beforeParse.status, beforeParse.json], [413, { error: "too_large", maxBytes: MAX_ARTIFACT_BYTES }]);
    assert.equal(beforeParse.headers.get("content-type")?.startsWith("application/json"), true);

    assert.equal(await revisionCount(doc.id), revisionsBefore, "the refused saves appended no revision");
    assert.equal(await currentRevisionOf(doc.id), doc.revisionId, "the current pointer did not move");
  },
);
