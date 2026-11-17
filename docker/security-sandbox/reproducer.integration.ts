import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";

import { createAuth, createAuthApp } from "../../apps/api/src/auth.ts";
import { createDatabase, type Database } from "../../apps/api/src/adapters/postgres/db/client.ts";
import { artifactRevisions } from "../../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { createStorage, type Storage } from "../../apps/api/src/adapters/storage/client.ts";
import {
  deleteRevisionBytes,
  listRevisionKeys,
  type DeletedRevision,
  type StorageResult,
} from "../../apps/api/src/adapters/storage/s3.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { writeArtifact } from "../../apps/api/src/domain/commit-flow.ts";
import type { DeleteRevisionFn } from "../../apps/api/src/domain/deletion.ts";
import { createLibraryApp } from "../../apps/api/src/routes/library.ts";
import { NOT_FOUND_PAGE } from "../../apps/api/src/viewer/html.ts";
import { trustedSession } from "../../test/helpers/trusted-accounts.ts";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
const DATABASE_PREFIX = "artiflow_shared_blob_race_";
const REQUIRED_ENV = [
  "DATABASE_URL",
  "ARTIFLOW_S3_ENDPOINT",
  "ARTIFLOW_S3_BUCKET",
  "ARTIFLOW_S3_ACCESS_KEY_ID",
  "ARTIFLOW_S3_SECRET_ACCESS_KEY",
  "ARTIFLOW_AUTH_SECRET",
];
const HTML = "<!doctype html><html><body><h1>shared blob</h1><p>identical bytes, two owners</p></body></html>";
const BYTES = Buffer.from(HTML, "utf8");
const SHA256 = createHash("sha256").update(BYTES).digest("hex");
const LISTING_PAGE_KEYS = 200;
const LISTING_MAX_KEYS = 1_000;

type Owner = { cookie: string; userId: string };
type Artifact = { id: string };
type Reply = { status: number; text: string; json: Record<string, unknown> | null };
type RevisionRow = { storageKey: string; sha256: string };

let admin!: Pool;
let pool!: Pool;
let database!: Database;
let storage!: Storage;
let server!: ReturnType<typeof serve>;
let baseUrl = "";
let databaseName = "";
let publicOrigin = "";
let fixtureReady = false;

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};
let holdArmed = false;
const reached = deferred();
const gate = deferred();
const holdingDelete: DeleteRevisionFn = async (input): Promise<StorageResult<DeletedRevision>> => {
  if (holdArmed) {
    holdArmed = false;
    reached.resolve();
    await gate.promise;
  }
  return deleteRevisionBytes(input);
};

const read = async (path: string, init: RequestInit = {}, owner?: Owner): Promise<Reply> => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, ...(owner ? { cookie: owner.cookie } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { status: response.status, text, json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : null };
};
const srcdocOf = (html: string): string =>
  (/srcdoc="([^"]*)"/.exec(html)?.[1] ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
const remove = (owner: Owner, artifactId: string): Promise<Reply> =>
  read(`/api/artifacts/${artifactId}`, { method: "DELETE", headers: { origin: publicOrigin, "content-type": "application/json" }, body: "{}" }, owner);
const seedOwner = async (name: string): Promise<Owner> => {
  const owner = await trustedSession({ database, baseUrl, origin: publicOrigin }, { name, email: `gui598-${randomUUID()}@example.test` });
  return { cookie: owner.cookie, userId: owner.userId };
};
const seed = async (owner: Owner): Promise<Artifact> => {
  const written = await writeArtifact({ database, storage, ownerId: owner.userId, bytes: BYTES, title: "shared bytes", kind: "html" });
  if (!written.ok) throw new Error(`seed refused: ${written.reason}`);
  return { id: written.value.artifactId };
};
const revisionsOf = async (artifactId: string): Promise<RevisionRow[]> =>
  database.db
    .select({ storageKey: artifactRevisions.storageKey, sha256: artifactRevisions.sha256 })
    .from(artifactRevisions)
    .where(eq(artifactRevisions.artifactId, artifactId));
const storedKeys = async (): Promise<string[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  while (keys.length < LISTING_MAX_KEYS) {
    const page = await listRevisionKeys({
      storage,
      continuationToken,
      maxKeys: Math.min(LISTING_PAGE_KEYS, LISTING_MAX_KEYS - keys.length),
    });
    if (!page.ok) throw new Error(`storage listing refused: ${page.reason}`);
    const pageKeys = page.value.objects.map((object) => object.storageKey);
    keys.push(...pageKeys);
    continuationToken = page.value.nextToken;
    if (continuationToken === undefined) return keys;
    if (pageKeys.length === 0) throw new Error("storage listing reported an empty page as truncated");
  }
  throw new Error(`storage listing exceeded ${LISTING_MAX_KEYS} revision objects: the fixture is not disposable`);
};
const onlyRevisionOf = async (artifactId: string): Promise<RevisionRow> => {
  const rows = await revisionsOf(artifactId);
  if (rows.length !== 1) throw new Error(`expected one revision row for ${artifactId}, got ${rows.length}`);
  return rows[0] as RevisionRow;
};
const within = async <T>(work: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

before(async () => {
  const missing = REQUIRED_ENV.filter((name) => (process.env[name] ?? "").trim().length === 0);
  assert.deepEqual(missing, [], `missing ${missing.join(", ")}; run scripts/security-sandbox.mjs (this test never skips)`);
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "fixture database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  assert.equal(url.pathname, "/artiflow", "the fixture owns the artiflow database");
  admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
  databaseName = `${DATABASE_PREFIX}${randomUUID().replaceAll("-", "")}`;
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  database = createDatabase(new URL(`/${databaseName}`, url).toString());
  pool = database.pool;
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  const endpoint = new URL(process.env.ARTIFLOW_S3_ENDPOINT ?? "");
  assert.equal(
    ["127.0.0.1", "localhost"].includes(endpoint.hostname) || process.env.ARTIFLOW_TEST_S3 === "1",
    true,
    "fixture storage must be loopback or ARTIFLOW_TEST_S3=1",
  );
  storage = createStorage({
    endpoint: endpoint.origin,
    region: (process.env.ARTIFLOW_S3_REGION ?? "us-east-1").trim() || "us-east-1",
    bucket: process.env.ARTIFLOW_S3_BUCKET ?? "",
    accessKeyId: process.env.ARTIFLOW_S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.ARTIFLOW_S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: true,
  });
  const config = loadConfig(process.env);
  publicOrigin = config.publicOrigin;
  const auth = createAuth(config, database);
  const app = new Hono();
  app.route("/", createAuthApp(auth, config));
  app.route("/", createLibraryApp({ database, auth, storage, deletion: { publicOrigin, deleteRevisionBytes: holdingDelete } }));
  server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    started.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fixtureReady = true;
});

after(async () => {
  if (!fixtureReady) return;
  try {
    for (const storageKey of await storedKeys()) await deleteRevisionBytes({ storage, storageKey });
  } catch {}
  storage.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
  await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
  const leftover = await admin.query<{ count: number }>("select count(*)::int as count from pg_database where datname like $1", [
    `${DATABASE_PREFIX}%`,
  ]);
  assert.equal(leftover.rows[0]?.count, 0, "no throwaway database remains");
  await admin.end();
});

test("control: sequential identical content keeps the survivor readable", { timeout: 120_000 }, async () => {
  const [ownerA, ownerB] = [await seedOwner("Owner A"), await seedOwner("Owner B")];
  const artifactA = await seed(ownerA);
  const artifactB = await seed(ownerB);
  assert.deepEqual(
    [(await read(`/artifact/${artifactA.id}`, {}, ownerA)).status, (await read(`/artifact/${artifactB.id}`, {}, ownerB)).status],
    [200, 200],
    "both owners read their artifact before any delete",
  );
  const [revisionA, revisionB] = [await onlyRevisionOf(artifactA.id), await onlyRevisionOf(artifactB.id)];
  const stored = await storedKeys();
  assert.deepEqual(
    [
      revisionA.sha256,
      revisionB.sha256,
      revisionA.storageKey !== revisionB.storageKey,
      stored.includes(revisionA.storageKey),
      stored.includes(revisionB.storageKey),
    ],
    [SHA256, SHA256, true, true, true],
    "identical content owns two distinct keys, and both objects exist",
  );
  assert.deepEqual([(await remove(ownerA, artifactA.id)).status], [200], "A's delete is the committed soft delete");
  assert.equal((await read(`/artifact/${artifactA.id}`, {}, ownerA)).status, 404, "A is gone from the viewer");
  const survivor = await read(`/artifact/${artifactB.id}`, {}, ownerB);
  assert.deepEqual([survivor.status, srcdocOf(survivor.text)], [200, HTML], "the survivor keeps its own bytes and stays byte-exact");
  const afterDelete = await storedKeys();
  assert.deepEqual(
    [afterDelete.includes(revisionA.storageKey), afterDelete.includes(revisionB.storageKey)],
    [false, true],
    "A's delete removed A's own key and nothing else",
  );
  assert.equal((await remove(ownerB, artifactB.id)).status, 200, "the survivor can still be deleted afterwards");
  assert.equal((await storedKeys()).includes(revisionB.storageKey), false, "the survivor's own key goes with it");
});

test(
  "race: DELETE paused between the ownership decision and the byte delete",
  { timeout: 180_000 },
  async () => {
    const [ownerA, ownerB] = [await seedOwner("Race A"), await seedOwner("Race B")];
    const artifactA = await seed(ownerA);
    const readable = await read(`/artifact/${artifactA.id}`, {}, ownerA);
    assert.deepEqual([readable.status, srcdocOf(readable.text)], [200, HTML], "A is readable before the delete");

    holdArmed = true;
    const pendingDelete = remove(ownerA, artifactA.id);
    pendingDelete.catch(() => {});
    const release = () => gate.resolve();
    try {
      await within(reached.promise, 60_000, "DELETE never reached the byte-delete seam: harness precondition failed");

      const artifactB = await seed(ownerB);
      const preRelease = await read(`/artifact/${artifactB.id}`, {}, ownerB);
      assert.deepEqual(
        [preRelease.status, srcdocOf(preRelease.text)],
        [200, HTML],
        "B is readable with the exact original bytes before A's paused delete resumes",
      );

      const revisionA = await onlyRevisionOf(artifactA.id);
      const revisionB = await onlyRevisionOf(artifactB.id);
      const storedBefore = await storedKeys();
      assert.deepEqual(
        [revisionA.sha256, revisionB.sha256],
        [SHA256, SHA256],
        "both revisions record the same digest for the identical bytes",
      );
      assert.notEqual(
        revisionA.storageKey,
        revisionB.storageKey,
        "byte-identical content is stored under two distinct keys, one per revision",
      );
      assert.deepEqual(
        [storedBefore.includes(revisionA.storageKey), storedBefore.includes(revisionB.storageKey)],
        [true, true],
        "both objects exist before A's paused delete resumes",
      );

      release();
      const deleted = await pendingDelete;
      assert.deepEqual([deleted.status, deleted.json], [200, { ok: true }], "A's soft delete is the whole answer");
      const gone = await read(`/artifact/${artifactA.id}`, {}, ownerA);
      assert.deepEqual([gone.status, gone.text], [404, NOT_FOUND_PAGE], "A is deleted for its owner, as the branded 404 page");

      let survivorFailure: unknown = null;
      try {
        const survivor = await read(`/artifact/${artifactB.id}`, {}, ownerB);
        assert.equal(
          survivor.status,
          200,
          `GUI598_INVARIANT_REGRESSED: GET /artifact/B returned ${survivor.status} ${survivor.text.slice(0, 160)} after A's DELETE`,
        );
        assert.equal(
          srcdocOf(survivor.text),
          HTML,
          "GUI598_INVARIANT_REGRESSED: the survivor does not serve the original bytes",
        );
      } catch (failure) {
        survivorFailure = failure;
      }

      let probeFailure: unknown = null;
      try {
        const storedAfter = await storedKeys();
        const [keyARemoved, keyBKept] = [
          !storedAfter.includes(revisionA.storageKey),
          storedAfter.includes(revisionB.storageKey),
        ];
        console.log(`GUI598_LOCAL_DELETE_PROBE aKeyRemoved=${String(keyARemoved)} bKeyKept=${String(keyBKept)}`);
        assert.deepEqual(
          [keyARemoved, keyBKept],
          [true, true],
          "GUI598_INVARIANT_REGRESSED: A's DELETE did not remove exactly A's own key",
        );
      } catch (failure) {
        probeFailure = failure;
      }

      if (survivorFailure !== null) throw survivorFailure;
      if (probeFailure !== null) throw probeFailure;
    } finally {
      release();
    }
  },
);
