import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";

import { commitUpload } from "../apps/api/src/domain/commit-flow.ts";
import { getRevisionBytes, REVISION_KEY_PREFIX } from "../apps/api/src/adapters/storage/s3.ts";
import { createUpload, putChunk } from "../apps/api/src/domain/staging.ts";
import { createAuth, createAuthApp } from "../apps/api/src/auth.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { createEditingApp } from "../apps/api/src/routes/editing.ts";
import { createSharingApp } from "../apps/api/src/routes/sharing.ts";
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
const SKIP = ENV_READY ? false : "DATABASE_URL or S3 missing; run with --env-file=.env.local";
const config = ENV_READY ? loadConfig(process.env) : undefined;
const publicOrigin = config?.publicOrigin ?? "";
const MUTATION = { "content-type": "application/json", origin: publicOrigin };

type User = { cookie: string; userId: string; email: string };
type Doc = { id: string; revisionId: string };

let admin: Pool, pool: Pool, storage: Storage, server: ReturnType<typeof serve>;
let database: Database;
let baseUrl = "",
  databaseName = "";
let owner: User, reader: User, editor: User, stranger: User;
let doc: Doc, htmlArtifact: Doc;

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
type Reply = { status: number; text: string; json: Record<string, unknown> | null; headers: Headers };
const read = async (path: string, init: RequestInit = {}, user?: User): Promise<Reply> => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, ...(user ? { cookie: user.cookie } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : null,
    headers: response.headers,
  };
};

const seedUser = async (label: string): Promise<User> => {
  const user = await trustedSession(
    { database, baseUrl, origin: publicOrigin },
    { name: `Editing ${label}`, email: `editing-${label}-${randomUUID()}@example.test` },
  );
  return { cookie: user.cookie, userId: user.userId, email: user.email };
};

const seed = async (user: User, text: string, title: string, kind?: "markdown"): Promise<Doc> => {
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
  const committed = await commitUpload({ database, storage, ownerId: user.userId, uploadId, bytes, title, kind });
  if (!committed.ok) throw new Error(`seed refused: ${committed.reason}`);
  return { id: committed.value.artifactId, revisionId: committed.value.revisionId };
};

type RevisionRow = { id: string; storageKey: string; sha256: string };
const revisionRows = async (artifactId: string): Promise<RevisionRow[]> =>
  (
    await pool.query<RevisionRow>(
      `select "id", "storageKey", "sha256" from "artifactRevisions" where "artifactId" = $1 order by "revision"`,
      [artifactId],
    )
  ).rows;

const currentRevisionOf = async (artifactId: string): Promise<string | null> =>
  (
    await pool.query<{ currentRevisionId: string | null }>(`select "currentRevisionId" from artifacts where id = $1`, [
      artifactId,
    ])
  ).rows[0]?.currentRevisionId ?? null;

const grant = async (ownerUser: User, artifactId: string, recipient: User): Promise<void> => {
  const created = await read(
    `/api/artifacts/${artifactId}/shares`,
    { method: "POST", headers: MUTATION, body: JSON.stringify({ email: recipient.email }) },
    ownerUser,
  );
  assert.equal(created.status, 201, `grant failed: ${created.text}`);
};

const DOC_V1 = "# Notas\n\nprimer parrafo\n";

before(async () => {
  if (!config) return;
  const url = new URL(DATABASE_URL);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  admin = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  databaseName = `artiflow_editing_test_${randomUUID().replaceAll("-", "")}`;
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
  const auth = createAuth(config, database);
  const app = new Hono();
  app.route("/", createAuthApp(auth, config));
  app.route("/", createEditingApp({ database, auth, storage, publicOrigin }));
  app.route("/", createSharingApp({ database, auth, publicOrigin }));
  server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    started.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  owner = await seedUser("owner");
  reader = await seedUser("reader");
  editor = await seedUser("editor");
  stranger = await seedUser("stranger");
  doc = await seed(owner, DOC_V1, "Editing doc", "markdown");
  htmlArtifact = await seed(owner, "<!doctype html><p>page</p>", "Html artifact");
  await grant(owner, doc.id, reader);
  await grant(owner, doc.id, editor);
  await pool.query(
    `update "artifactShares" set "role" = 'editor' where "artifactId" = $1 and "sharedWithUserId" = $2`,
    [doc.id, editor.userId],
  );
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
  await admin.end();
});

test(
  "GET document returns the markdown text and revision pointers for every reader",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    for (const user of [owner, reader, editor]) {
      const reply = await read(`/api/artifacts/${doc.id}/document`, {}, user);
      assert.equal(reply.status, 200, reply.text);
      assert.deepEqual([reply.json?.text, reply.json?.revisionId], [DOC_V1, doc.revisionId]);
      assert.equal(reply.json?.revisionNumber, 1);
      assert.equal(reply.json?.kind, "markdown");
    }
    assert.equal((await read(`/api/artifacts/${doc.id}/document`, {}, stranger)).status, 404);
    assert.equal((await read(`/api/artifacts/${doc.id}/document`)).status, 401);
    const wrongKind = await read(`/api/artifacts/${htmlArtifact.id}/document`, {}, owner);
    assert.deepEqual([wrongKind.status, wrongKind.json?.error], [409, "wrong_kind"]);
  },
);

test(
  "PUT document autosaves as a new revision and refuses a stale base revision",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const saveOne = await read(
      `/api/artifacts/${doc.id}/document`,
      {
        method: "PUT",
        headers: MUTATION,
        body: JSON.stringify({ text: `${DOC_V1}\neditado\n`, expectedRevisionId: doc.revisionId }),
      },
      owner,
    );
    assert.equal(saveOne.status, 200, saveOne.text);
    assert.equal(saveOne.json?.revisionNumber, 2);
    assert.notEqual(saveOne.json?.revisionId, doc.revisionId);
    const reread = await read(`/api/artifacts/${doc.id}/document`, {}, owner);
    assert.equal(reread.json?.text, `${DOC_V1}\neditado\n`);
    const stale = await read(
      `/api/artifacts/${doc.id}/document`,
      { method: "PUT", headers: MUTATION, body: JSON.stringify({ text: "x", expectedRevisionId: doc.revisionId }) },
      owner,
    );
    assert.deepEqual(
      [stale.status, stale.json?.error, stale.json?.currentRevisionId],
      [409, "concurrent_edit", saveOne.json?.revisionId],
    );
    assert.equal(
      (await read(`/api/artifacts/${doc.id}/document`, {}, owner)).json?.revisionId,
      saveOne.json?.revisionId,
    );
  },
);

test(
  "PUT document is editor-only: readers get 403, strangers 404, and the mutation guard applies",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    assert.equal(
      (
        await read(
          `/api/artifacts/${doc.id}/document`,
          { method: "PUT", headers: MUTATION, body: JSON.stringify({ text: "x", expectedRevisionId: doc.revisionId }) },
          reader,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await read(
          `/api/artifacts/${doc.id}/document`,
          { method: "PUT", headers: MUTATION, body: JSON.stringify({ text: "x", expectedRevisionId: doc.revisionId }) },
          stranger,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await read(`/api/artifacts/${doc.id}/document`, {
          method: "PUT",
          headers: MUTATION,
          body: JSON.stringify({ text: "x", expectedRevisionId: doc.revisionId }),
        })
      ).status,
      401,
    );
    const foreignOrigin = await read(
      `/api/artifacts/${doc.id}/document`,
      {
        method: "PUT",
        headers: { ...MUTATION, origin: "https://evil.example" },
        body: JSON.stringify({ text: "x", expectedRevisionId: doc.revisionId }),
      },
      owner,
    );
    assert.equal(foreignOrigin.status, 403);
    const htmlSave = await read(
      `/api/artifacts/${htmlArtifact.id}/document`,
      {
        method: "PUT",
        headers: MUTATION,
        body: JSON.stringify({ text: "# x", expectedRevisionId: htmlArtifact.revisionId }),
      },
      owner,
    );
    assert.deepEqual([htmlSave.status, htmlSave.json?.error], [409, "wrong_kind"]);
  },
);

test(
  "an editor share can autosave (S7) and the revision history lists newest first",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const current = await read(`/api/artifacts/${doc.id}/document`, {}, editor);
    const saved = await read(
      `/api/artifacts/${doc.id}/document`,
      {
        method: "PUT",
        headers: MUTATION,
        body: JSON.stringify({ text: `${DOC_V1}editor\n`, expectedRevisionId: current.json?.revisionId }),
      },
      editor,
    );
    assert.equal(saved.status, 200, saved.text);
    const history = await read(`/api/artifacts/${doc.id}/revisions`, {}, reader);
    assert.equal(history.status, 200);
    const revisions = (history.json?.revisions ?? []) as Record<string, unknown>[];
    assert.deepEqual(
      revisions.map((revision) => revision.revisionNumber),
      [3, 2, 1],
    );
    assert.ok(revisions.every((revision) => typeof revision.id === "string" && typeof revision.createdAt === "string"));
  },
);

test(
  "restore creates a NEW revision with the old bytes, under the same editor rule",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const current = await read(`/api/artifacts/${doc.id}/document`, {}, owner);
    const firstRevision = (
      ((await read(`/api/artifacts/${doc.id}/revisions`, {}, owner)).json?.revisions ?? []) as Record<string, unknown>[]
    ).at(-1) as Record<string, unknown>;
    const stale = await read(
      `/api/artifacts/${doc.id}/revisions/${String(firstRevision.id)}/restore`,
      { method: "POST", headers: MUTATION, body: JSON.stringify({ expectedRevisionId: doc.revisionId }) },
      owner,
    );
    assert.deepEqual([stale.status, stale.json?.error], [409, "concurrent_edit"]);
    const restored = await read(
      `/api/artifacts/${doc.id}/revisions/${String(firstRevision.id)}/restore`,
      { method: "POST", headers: MUTATION, body: JSON.stringify({ expectedRevisionId: current.json?.revisionId }) },
      owner,
    );
    assert.equal(restored.status, 200, restored.text);
    const rows = await revisionRows(doc.id);
    const pinnedRow = rows.find((row) => row.id === firstRevision.id);
    const restoredRow = rows.find((row) => row.id === restored.json?.revisionId);
    assert.ok(pinnedRow && restoredRow, "both the pinned and the restored revision rows exist");
    assert.notEqual(
      restoredRow.storageKey,
      pinnedRow.storageKey,
      "the restored revision never names the pinned revision's key",
    );
    assert.equal(restoredRow.storageKey.startsWith(REVISION_KEY_PREFIX), true);
    assert.equal(restoredRow.sha256, pinnedRow.sha256, "restored bytes keep the pinned row's digest");
    for (const row of [pinnedRow, restoredRow]) {
      const got = await getRevisionBytes({ storage, storageKey: row.storageKey, sha256: row.sha256 });
      assert.equal(got.ok, true, "both revisions remain readable");
      if (got.ok) assert.equal(digestOf(got.value.bytes), row.sha256, "each read verifies against its own row");
    }
    const reread = await read(`/api/artifacts/${doc.id}/document`, {}, owner);
    assert.equal(reread.json?.text, DOC_V1, "restoring the first revision restores its exact text");
    assert.equal(reread.json?.revisionNumber, 4, "restore appends a revision, never rewrites history");
    assert.equal(
      (
        await read(
          `/api/artifacts/${doc.id}/revisions/${String(firstRevision.id)}/restore`,
          { method: "POST", headers: MUTATION, body: JSON.stringify({ expectedRevisionId: reread.json?.revisionId }) },
          reader,
        )
      ).status,
      403,
    );
    const htmlRestore = await read(
      `/api/artifacts/${htmlArtifact.id}/revisions/${String(htmlArtifact.revisionId)}/restore`,
      { method: "POST", headers: MUTATION, body: JSON.stringify({ expectedRevisionId: htmlArtifact.revisionId }) },
      owner,
    );
    assert.deepEqual([htmlRestore.status, htmlRestore.json?.error], [409, "wrong_kind"]);
  },
);

test(
  "restoring the same revision twice allocates a key for each restore",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const repeat = await seed(owner, "# repetido\n", "Repeat doc", "markdown");
    let expectedRevisionId = repeat.revisionId;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const restored = await read(
        `/api/artifacts/${repeat.id}/revisions/${repeat.revisionId}/restore`,
        { method: "POST", headers: MUTATION, body: JSON.stringify({ expectedRevisionId }) },
        owner,
      );
      assert.equal(restored.status, 200, restored.text);
      expectedRevisionId = String(restored.json?.revisionId);
    }
    const rows = await revisionRows(repeat.id);
    assert.equal(rows.length, 3, "two restores appended two revisions");
    const keys = new Set(rows.map((row) => row.storageKey));
    assert.equal(keys.size, 3, "no restore reused a key, so no two rows share one object");
    for (const row of rows) {
      const got = await getRevisionBytes({ storage, storageKey: row.storageKey, sha256: row.sha256 });
      assert.equal(got.ok, true, "every revision of the repeat doc is readable");
    }
  },
);

test(
  "a restore whose pinned body is gone fails closed and appends no revision",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const victim = await seed(owner, "# victima\n", "Victim doc", "markdown");
    const rows = await revisionRows(victim.id);
    assert.equal(rows.length, 1, "a freshly seeded document has exactly one revision");
    const onlyRow = rows[0];
    if (!onlyRow) return;
    await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: onlyRow.storageKey }));
    const reply = await read(
      `/api/artifacts/${victim.id}/revisions/${victim.revisionId}/restore`,
      { method: "POST", headers: MUTATION, body: JSON.stringify({ expectedRevisionId: victim.revisionId }) },
      owner,
    );
    assert.deepEqual(
      [reply.status, reply.json?.error],
      [500, "artifact_unavailable"],
      "a failed read is not a restore",
    );
    assert.equal((await revisionRows(victim.id)).length, 1, "the failed read persisted no revision row");
    assert.equal(await currentRevisionOf(victim.id), victim.revisionId, "the current pointer did not move");
  },
);
