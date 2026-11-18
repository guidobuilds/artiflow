import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";

import { commitUpload } from "../apps/api/src/domain/commit-flow.ts";
import {
  deleteRevisionBytes,
  REVISION_KEY_PREFIX,
  type DeletedRevision,
  type StorageResult,
} from "../apps/api/src/adapters/storage/s3.ts";
import { createUpload, putChunk } from "../apps/api/src/domain/staging.ts";
import { NOT_FOUND_PAGE } from "../apps/api/src/viewer/html.ts";
import { createAuth, createAuthApp } from "../apps/api/src/auth.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { DeleteRevisionFn } from "../apps/api/src/domain/deletion.ts";
import { createLibraryApp } from "../apps/api/src/routes/library.ts";
import { canReadArtifact, createShareViewerApp, createSharingApp } from "../apps/api/src/routes/sharing.ts";
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
const publicOrigin = ENV_READY ? loadConfig(process.env).publicOrigin : "";
const HTML_A = `<!doctype html><html><body><h1>Delete A</h1><script>document.title = "pwn"</script></body></html>`;
const HTML_B = `<!doctype html><p>second body</p>`;
const MUTATION = { origin: publicOrigin, "content-type": "application/json" };
const NOT_FOUND = '{"error":"not_found"}';

type Owner = { cookie: string; userId: string; email: string };
type Artifact = { id: string; revisionId: string; sha256: string; storageKey: string };
type Reply = { status: number; text: string; json: Record<string, unknown> | null };
let admin: Pool, pool: Pool, storage: Storage, server: ReturnType<typeof serve>;
let database: Database;
let baseUrl = "",
  databaseName = "",
  failKey = "";
const usedKeys: string[] = [];

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const revisionKeyOf = async (revisionId: string): Promise<string> => {
  const row = await pool.query<{ storageKey: string }>(`select "storageKey" from "artifactRevisions" where "id" = $1`, [
    revisionId,
  ]);
  const storageKey = row.rows[0]?.storageKey;
  assert.ok(typeof storageKey === "string", "the revision row names its own storage key");
  return storageKey;
};
const bytesOf = async (key: string): Promise<Buffer> => {
  const object = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
  const parts: Buffer[] = [];
  for await (const part of object.Body as AsyncIterable<Uint8Array>) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
};
const read = async (path: string, init: RequestInit = {}, owner?: Owner): Promise<Reply> => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, ...(owner ? { cookie: owner.cookie } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
};
const srcdocOf = (html: string): string =>
  (/srcdoc="([^"]*)"/.exec(html)?.[1] ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
const revisionKeys = async (): Promise<string[]> => {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await storage.client.send(
      new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: REVISION_KEY_PREFIX, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return keys;
};
const seedOwner = async (name: string): Promise<Owner> => {
  const owner = await trustedSession(
    { database, baseUrl, origin: publicOrigin },
    { name, email: `i5b4-${randomUUID()}@example.test` },
  );
  return { cookie: owner.cookie, email: owner.email, userId: owner.userId };
};
const seed = async (
  owner: Owner,
  html: string,
  title: string | null = null,
  previous?: Artifact,
): Promise<Artifact> => {
  const bytes = Buffer.from(html, "utf8"),
    uploadId = `upload-${randomUUID()}`,
    sha256 = digestOf(bytes);
  assert.equal(
    (
      await createUpload(database.db, {
        ownerId: owner.userId,
        uploadId,
        declaredSizeBytes: bytes.length,
        declaredSha256: sha256,
      })
    ).ok,
    true,
  );
  assert.equal(
    (await putChunk(database.db, { ownerId: owner.userId, uploadId, chunkIndex: 0, sizeBytes: bytes.length, sha256 }))
      .ok,
    true,
  );
  const committed = await commitUpload({
    database,
    storage,
    ownerId: owner.userId,
    uploadId,
    bytes,
    title,
    ...(previous ? { artifactId: previous.id, expectedRevisionId: previous.revisionId } : {}),
  });
  if (!committed.ok) throw new Error(`seed refused: ${committed.reason}`);
  assert.equal(
    await revisionKeyOf(committed.value.revisionId),
    committed.value.storageKey,
    "the committed key is the one persisted on the revision row",
  );
  usedKeys.push(committed.value.storageKey);
  return {
    id: committed.value.artifactId,
    revisionId: committed.value.revisionId,
    sha256,
    storageKey: committed.value.storageKey,
  };
};
const remove = (owner: Owner, artifactId: string): Promise<Reply> =>
  read(`/api/artifacts/${artifactId}`, { method: "DELETE", headers: MUTATION, body: "{}" }, owner);
const deletedAtOf = async (artifactId: string): Promise<Date | null> =>
  (await pool.query<{ deletedAt: Date | null }>(`select "deletedAt" from "artifacts" where "id" = $1`, [artifactId]))
    .rows[0]?.deletedAt ?? null;

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
  databaseName = `artiflow_delete_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  database = createDatabase(new URL(`/${databaseName}`, DATABASE_URL).toString());
  pool = database.pool;
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
  const config = loadConfig(process.env),
    auth = createAuth(config, database),
    app = new Hono();
  const deleting: DeleteRevisionFn = async (input): Promise<StorageResult<DeletedRevision>> => {
    if (input.storageKey === failKey) throw new Error("injected cleanup failure");
    return deleteRevisionBytes(input);
  };
  app.route("/", createAuthApp(auth, config));
  app.route("/", createShareViewerApp({ database, storage }));
  app.route("/", createSharingApp({ database, auth, publicOrigin }));
  app.route(
    "/",
    createLibraryApp({ database, auth, storage, deletion: { publicOrigin, deleteRevisionBytes: deleting } }),
  );
  server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    started.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  if (!ENV_READY) return;
  for (const key of usedKeys) {
    await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
    const left = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key })).then(
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
    ["artiflow_delete_test_%"],
  );
  assert.equal(leftover.rows[0]?.count, 0, "no throwaway database remains");
  await admin.end();
});

test("(k) cleanup exposes no cross-artifact reference decision", async () => {
  const surface = await import("../apps/api/src/domain/deletion.ts");
  assert.deepEqual(
    Object.keys(surface).filter((name) => /referenc/i.test(name)),
    [],
    "no reference query is exported, and none is used to decide a key",
  );
  assert.equal("selectUnreferencedKeys" in surface, false, "the per-key reference decision is gone");
});

test("(a) an owner DELETE soft-deletes and answers {ok:true}", { skip: SKIP, timeout: 60_000 }, async () => {
  const owner = await seedOwner("Delete Owner A"),
    artifact = await seed(owner, HTML_A, "Doomed");
  const reply = await remove(owner, artifact.id);
  assert.deepEqual([reply.status, reply.json], [200, { ok: true }], "one explicit DELETE is the whole contract");
  assert.equal((await deletedAtOf(artifact.id)) instanceof Date, true, "the soft delete is committed");
});

test(
  "(b) a repeat, a foreign owner and a malformed id are one identical 404",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const [owner, stranger] = [await seedOwner("Delete Owner B"), await seedOwner("Delete Stranger B")];
    const artifact = await seed(owner, HTML_A, "Repeated"),
      foreign = await seed(stranger, HTML_B, "Foreign");
    assert.equal((await remove(owner, artifact.id)).status, 200, "delete once");
    const repeat = await remove(owner, artifact.id);
    const notMine = await remove(owner, foreign.id);
    const malformed = await remove(owner, "not-a-uuid");
    const missing = await remove(owner, randomUUID());
    assert.deepEqual(
      [repeat.status, notMine.status, malformed.status, missing.status],
      [404, 404, 404, 404],
      "never a 500, never 200",
    );
    assert.deepEqual(
      [repeat.text, notMine.text, malformed.text, missing.text],
      Array.from({ length: 4 }, () => NOT_FOUND),
      "byte-identical refusals",
    );
    assert.equal(await deletedAtOf(foreign.id), null, "a foreign artifact is never deleted");
  },
);

test(
  "(e) a deleted artifact leaves the library, the viewer and every access path",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const owner = await seedOwner("Delete Owner E"),
      recipient = await seedOwner("Delete Recipient E");
    const artifact = await seed(owner, HTML_A, "Revoked access");
    const grant = await read(
      `/api/artifacts/${artifact.id}/shares`,
      { method: "POST", headers: MUTATION, body: JSON.stringify({ email: recipient.email }) },
      owner,
    );
    const link = await read(
      `/api/artifacts/${artifact.id}/links`,
      { method: "POST", headers: MUTATION, body: "{}" },
      owner,
    );
    const token = link.json?.token as string;
    assert.deepEqual(
      [
        grant.status,
        link.status,
        (await read(`/share/${token}`)).status,
        await canReadArtifact(database.db, recipient.userId, artifact.id),
      ],
      [201, 201, 200, true],
      "readable before deletion",
    );
    assert.equal((await remove(owner, artifact.id)).status, 200);
    const listed = ((await read("/api/artifacts", {}, owner)).json?.artifacts ?? []) as Record<string, unknown>[];
    const shared = await read(`/share/${token}`);
    assert.deepEqual(
      [
        listed.some((row) => row.id === artifact.id),
        (await read(`/api/artifacts/${artifact.id}`, {}, owner)).status,
        (await read(`/artifact/${artifact.id}`, {}, owner)).status,
      ],
      [false, 404, 404],
      "list, metadata and viewer are gone",
    );
    assert.deepEqual(
      [await canReadArtifact(database.db, recipient.userId, artifact.id), shared.status, shared.text],
      [false, 404, NOT_FOUND_PAGE],
      "the grant and the live link stop delivering, as the branded 404 page",
    );
  },
);

test("(f) deletion removes the artifact's own revision key", { skip: SKIP, timeout: 60_000 }, async () => {
  const owner = await seedOwner("Delete Owner F"),
    artifact = await seed(owner, `<!doctype html><p>unique ${randomUUID()}</p>`, "Unique bytes");
  const key = await revisionKeyOf(artifact.revisionId);
  assert.equal((await revisionKeys()).includes(key), true, "the key exists before deletion");
  assert.equal((await remove(owner, artifact.id)).status, 200);
  assert.equal((await revisionKeys()).includes(key), false, "the artifact's own key is removed from S3");
});

test(
  "(g) byte-identical artifacts get distinct keys, so deleting one leaves the other intact",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const owner = await seedOwner("Delete Owner G"),
      html = `<!doctype html><p>identical ${randomUUID()}</p>`;
    const [first, second] = [await seed(owner, html, "Identical A"), await seed(owner, html, "Identical B")];
    const [firstKey, secondKey] = [await revisionKeyOf(first.revisionId), await revisionKeyOf(second.revisionId)];
    const before = await revisionKeys();
    assert.deepEqual(
      [first.sha256 === second.sha256, firstKey === secondKey, before.includes(firstKey), before.includes(secondKey)],
      [true, false, true, true],
      "identical content, one key per revision, both stored",
    );
    assert.equal((await remove(owner, first.id)).status, 200);
    const survivor = await read(`/artifact/${second.id}`, {}, owner);
    const after = await revisionKeys();
    assert.deepEqual(
      [after.includes(firstKey), after.includes(secondKey)],
      [false, true],
      "only the deleted artifact's own key is gone",
    );
    assert.deepEqual(
      [survivor.status, srcdocOf(survivor.text).startsWith(html)],
      [200, true],
      "the survivor is still readable through the real viewer",
    );
    assert.equal((await bytesOf(secondKey)).equals(Buffer.from(html, "utf8")), true, "and its stored bytes are exact");
    assert.equal((await remove(owner, second.id)).status, 200);
    assert.equal((await revisionKeys()).includes(secondKey), false, "the survivor's own key goes with it");
  },
);

test("(h) a multi-revision artifact loses every one of its own keys", { skip: SKIP, timeout: 60_000 }, async () => {
  const owner = await seedOwner("Delete Owner H");
  const first = await seed(owner, `<!doctype html><p>rev one ${randomUUID()}</p>`, "Two revisions");
  const second = await seed(owner, `<!doctype html><p>rev two ${randomUUID()}</p>`, null, first);
  const keys = [await revisionKeyOf(first.revisionId), await revisionKeyOf(second.revisionId)],
    before = await revisionKeys();
  assert.deepEqual(
    keys.map((key) => before.includes(key)),
    [true, true],
    "both revisions are stored under their own keys",
  );
  assert.equal((await remove(owner, first.id)).status, 200);
  const after = await revisionKeys();
  assert.deepEqual(
    keys.map((key) => after.includes(key)),
    [false, false],
    "both of the artifact's own keys are removed",
  );
});

test(
  "(i) DELETE is a cookie mutation: exact Origin plus a JSON body or nothing happens",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const owner = await seedOwner("Delete Owner I"),
      artifact = await seed(owner, HTML_A, "Guarded");
    const replies = await Promise.all([
      read(
        `/api/artifacts/${artifact.id}`,
        { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" },
        owner,
      ),
      read(
        `/api/artifacts/${artifact.id}`,
        { method: "DELETE", headers: { ...MUTATION, origin: "http://127.0.0.1:1" }, body: "{}" },
        owner,
      ),
      read(
        `/api/artifacts/${artifact.id}`,
        { method: "DELETE", headers: { origin: publicOrigin, "content-type": "text/plain" }, body: "{}" },
        owner,
      ),
    ]);
    assert.deepEqual(
      replies.map((reply) => [reply.status, reply.json?.error]),
      [
        [403, "origin_not_allowed"],
        [403, "origin_not_allowed"],
        [415, "json_content_type_required"],
      ],
      "missing, foreign and non-JSON are all refused",
    );
    assert.equal(await deletedAtOf(artifact.id), null, "a refused mutation deletes nothing");
  },
);

test("(j) cleanup survives a throwing byte delete and still answers 200", { skip: SKIP, timeout: 60_000 }, async () => {
  const owner = await seedOwner("Delete Owner J"),
    artifact = await seed(owner, `<!doctype html><p>orphan ${randomUUID()}</p>`, "Orphan");
  failKey = artifact.storageKey;
  const reply = await remove(owner, artifact.id);
  failKey = "";
  assert.deepEqual(
    [reply.status, reply.json, (await deletedAtOf(artifact.id)) instanceof Date],
    [200, { ok: true }, true],
    "the committed soft delete is the answer",
  );
  assert.equal(
    (await revisionKeys()).includes(await revisionKeyOf(artifact.revisionId)),
    true,
    "the failed cleanup left the documented orphan for a later sweep",
  );
});
