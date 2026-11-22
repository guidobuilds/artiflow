import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";

import {
  ASSET_GC_GRACE_MS,
  ASSET_GC_INTERVAL_MS,
  ASSET_GC_STARTUP_DELAY_MS,
  dropAssetRow,
  startAssetGcLoop,
  sweepAssetOrphans,
  type AssetSweepResult,
  type DropAssetRowFn,
} from "../apps/api/src/domain/gc.ts";
import { deleteArtifact } from "../apps/api/src/domain/deletion.ts";
import {
  artifactAssets,
  artifactRevisions,
  artifacts,
  assets,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { AppDb, Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import {
  ASSET_KEY_PREFIX,
  assetStorageKey,
  REVISION_KEY_PREFIX,
  stagingStorageKey,
} from "../apps/api/src/adapters/storage/s3.ts";
import { createAssetsApp, type AssetsOptions } from "../apps/api/src/routes/assets.ts";

const ORIGIN = "http://127.0.0.1:5173";
const OWNER_ID = "user-owner";
const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-21T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const png = (size = 96): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(Math.max(0, size - 8), 5),
  ]);
const aged = (ageMs = 2 * DAY_MS): Date => new Date(NOW.getTime() - ageMs);

type StoredObject = { bytes: Uint8Array; lastModified: Date };
type StoredAsset = { sha256: string; sizeBytes: number; contentType: string; storageKey: string };
type Reference = { artifactId: string; assetSha256: string };
type Artifact = { id: string; ownerId: string; deletedAt: Date | null };
type Statement = { sql: string; params: unknown[] };
type World = {
  artifacts: Record<string, Artifact>;
  revisions: { artifactId: string; storageKey: string }[];
  assets: Map<string, StoredAsset>;
  references: Reference[];
  objects: Map<string, StoredObject>;
  puts: { key: string; contentType: string }[];
  deletes: string[];
  inserts: { table: unknown; values: Record<string, unknown> }[];
  statements: Statement[];
};

type Chain = Record<string, unknown> & {
  then: (ok?: (value: unknown) => unknown, error?: (reason: unknown) => unknown) => Promise<unknown>;
};

const providerError = (status: number): Error =>
  Object.assign(new Error(`provider ${status}`), { $metadata: { httpStatusCode: status } });
const dialect = new PgDialect();

function world(overrides: Partial<World> = {}): World {
  return {
    artifacts: {
      [ARTIFACT_ID]: { id: ARTIFACT_ID, ownerId: OWNER_ID, deletedAt: null },
      [OTHER_ARTIFACT_ID]: { id: OTHER_ARTIFACT_ID, ownerId: OWNER_ID, deletedAt: null },
    },
    revisions: [],
    assets: new Map(),
    references: [],
    objects: new Map(),
    puts: [],
    deletes: [],
    inserts: [],
    statements: [],
    ...overrides,
  };
}

const seedAsset = (
  state: World,
  bytes: Uint8Array,
  options: { lastModified?: Date; referencedBy?: readonly string[] } = {},
): string => {
  const sha256 = digestOf(bytes);
  const storageKey = assetStorageKey(sha256);
  state.assets.set(sha256, { sha256, sizeBytes: bytes.length, contentType: "image/png", storageKey });
  state.objects.set(storageKey, { bytes, lastModified: options.lastModified ?? NOW });
  for (const artifactId of options.referencedBy ?? []) state.references.push({ artifactId, assetSha256: sha256 });
  return sha256;
};

function storageOf(state: World): Storage {
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const name = command.constructor.name;
      const key = String(command.input.Key ?? "");
      if (name === "PutObjectCommand") {
        const bytes = Buffer.from(command.input.Body as Uint8Array);
        state.objects.set(key, { bytes, lastModified: NOW });
        state.puts.push({ key, contentType: String(command.input.ContentType) });
        return {};
      }
      if (name === "ListObjectsV2Command") {
        const prefix = String(command.input.Prefix ?? "");
        const maxKeys = Number(command.input.MaxKeys ?? 1000);
        const cursor = String(command.input.ContinuationToken ?? "");
        const listed = [...state.objects.keys()]
          .filter((candidate) => candidate.startsWith(prefix) && candidate > cursor)
          .sort();
        const page = listed.slice(0, maxKeys);
        const truncated = listed.length > page.length;
        return {
          Contents: page.map((candidate) => ({
            Key: candidate,
            LastModified: state.objects.get(candidate)?.lastModified,
            Size: state.objects.get(candidate)?.bytes.length,
          })),
          IsTruncated: truncated,
          NextContinuationToken: truncated ? page[page.length - 1] : undefined,
        };
      }
      const stored = state.objects.get(key);
      if (name === "HeadObjectCommand") {
        if (!stored) throw providerError(404);
        return { ContentLength: stored.bytes.length };
      }
      if (name === "GetObjectCommand") {
        if (!stored) throw providerError(404);
        return {
          Body: (async function* (): AsyncIterable<Uint8Array> {
            yield stored.bytes;
          })(),
        };
      }
      if (name === "DeleteObjectCommand") {
        state.deletes.push(key);
        state.objects.delete(key);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
  return {
    client: client as unknown as Storage["client"],
    bucket: "test-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  };
}

const paramsOf = (statement: Statement): string[] => statement.params.map((value) => String(value));

const rowsFor = (state: World, table: unknown, statement: Statement): unknown[] => {
  const params = paramsOf(statement);
  if (table === artifacts) {
    const artifact: Artifact | undefined = state.artifacts[params[0] ?? ""];
    if (!artifact || artifact.ownerId !== params[1]) return [];
    if (statement.sql.includes("count("))
      return [
        {
          currentRevisionId: null,
          observedSizeBytes: null,
          deletedAt: artifact.deletedAt,
          revisionCount: 0,
          kind: "canvas",
        },
      ];
    if (artifact.deletedAt !== null) return [];
    if (statement.sql.includes('"artifactShares"')) return [{ id: artifact.id, access: "owner" }];
    return [{ id: artifact.id }];
  }
  if (table === assets) {
    const row = state.assets.get(params[0] ?? "");
    return row ? [{ sha256: row.sha256, sizeBytes: row.sizeBytes, contentType: row.contentType }] : [];
  }
  if (table === artifactRevisions)
    return state.revisions.filter((row) => row.artifactId === params[0]).map((row) => ({ storageKey: row.storageKey }));
  if (table === artifactAssets)
    return state.references
      .filter((row) => params.includes(row.assetSha256))
      .map((row) => ({ sha256: row.assetSha256 }));
  return [];
};

function databaseOf(state: World): Database {
  const select = (): Chain => {
    let table: unknown = null;
    let rows: unknown[] = [];
    const query: Chain = {
      from: (next: unknown) => {
        table = next;
        return query;
      },
      leftJoin: () => query,
      innerJoin: () => query,
      orderBy: () => query,
      groupBy: () => query,
      limit: () => query,
      where: (expression: unknown) => {
        const compiled = dialect.sqlToQuery(expression as SQL);
        const statement = { sql: compiled.sql, params: compiled.params };
        state.statements.push(statement);
        rows = rowsFor(state, table, statement);
        return query;
      },
      then: (ok?: (value: unknown) => unknown, error?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(ok, error),
    };
    return query;
  };
  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>): Chain => {
      const chain: Chain = {
        onConflictDoNothing: () => chain,
        returning: () => chain,
        then: (ok?: (value: unknown) => unknown, error?: (reason: unknown) => unknown) => {
          state.inserts.push({ table, values });
          if (table === assets)
            state.assets.set(String(values.sha256), {
              sha256: String(values.sha256),
              sizeBytes: Number(values.sizeBytes),
              contentType: String(values.contentType),
              storageKey: String(values.storageKey),
            });
          if (table === artifactAssets) {
            const reference = {
              artifactId: String(values.artifactId),
              assetSha256: String(values.assetSha256),
            };
            const known = state.references.some(
              (row) => row.artifactId === reference.artifactId && row.assetSha256 === reference.assetSha256,
            );
            if (!known) state.references.push(reference);
            return Promise.resolve([]).then(ok, error);
          }
          return Promise.resolve([values]).then(ok, error);
        },
      };
      return chain;
    },
  });
  const update = (table: unknown) => ({
    set: () => ({
      where: (expression: unknown) => {
        const compiled = dialect.sqlToQuery(expression as SQL);
        const statement = { sql: compiled.sql, params: compiled.params };
        state.statements.push(statement);
        return {
          returning: (): Promise<unknown[]> => {
            if (table !== artifacts) return Promise.resolve([]);
            const artifact: Artifact | undefined = state.artifacts[paramsOf(statement)[0] ?? ""];
            if (!artifact || artifact.ownerId !== paramsOf(statement)[1]) return Promise.resolve([]);
            artifact.deletedAt ??= NOW;
            return Promise.resolve([{ deletedAt: artifact.deletedAt }]);
          },
        };
      },
    }),
  });
  const remove = (table: unknown) => ({
    where: (expression: unknown): Promise<unknown[]> => {
      const compiled = dialect.sqlToQuery(expression as SQL);
      const statement = { sql: compiled.sql, params: compiled.params };
      state.statements.push(statement);
      const [first] = paramsOf(statement);
      if (table === artifactAssets) state.references = state.references.filter((row) => row.artifactId !== first);
      if (table === assets) state.assets.delete(first ?? "");
      return Promise.resolve([]);
    },
  });
  return { db: { select, insert, update, delete: remove } } as unknown as Database;
}

const appDbOf = (state: World): AppDb => (databaseOf(state) as unknown as { db: AppDb }).db;

const sessionAuth = (userId: string | null) =>
  ({
    api: { getSession: async () => (userId === null ? null : { user: { id: userId } }) },
  }) as unknown as AssetsOptions["auth"];

const uploadApp = (state: World): Hono => {
  const app = new Hono();
  app.route(
    "/",
    createAssetsApp({
      database: databaseOf(state),
      auth: sessionAuth(OWNER_ID),
      storage: storageOf(state),
      publicOrigin: ORIGIN,
    }),
  );
  return app;
};

const reupload = (state: World, bytes: Uint8Array, artifactId = ARTIFACT_ID) =>
  uploadApp(state).request(`/api/artifacts/${artifactId}/assets`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "image/png",
      "content-length": String(bytes.length),
    },
    body: bytes,
  });

const assetKeyOf = (bytes: Uint8Array): string => `${ASSET_KEY_PREFIX}${digestOf(bytes)}`;

test("deleting one of two artifacts that share an asset drops only its reference and no asset object", async () => {
  const state = world();
  const bytes = png();
  const shared = seedAsset(state, bytes, { lastModified: aged(), referencedBy: [ARTIFACT_ID, OTHER_ARTIFACT_ID] });
  state.revisions.push({ artifactId: ARTIFACT_ID, storageKey: `${REVISION_KEY_PREFIX}rev-a` });

  const outcome = await deleteArtifact(
    { database: databaseOf(state), storage: storageOf(state) },
    ARTIFACT_ID,
    OWNER_ID,
  );
  assert.equal(outcome.ok, true, "the owner deletes the artifact");
  assert.deepEqual(
    state.references.map((row) => row.artifactId),
    [OTHER_ARTIFACT_ID],
    "only the deleted artifact's reference is dropped",
  );
  assert.equal(state.assets.has(shared), true, "the assets row survives: another artifact still references it");
  assert.equal(state.objects.has(assetKeyOf(bytes)), true, "the stored object survives untouched");
  assert.deepEqual(
    state.deletes.filter((key) => key.startsWith(ASSET_KEY_PREFIX)),
    [],
    "deleting an artifact never deletes an asset object",
  );
  assert.deepEqual(
    state.deletes,
    [`${REVISION_KEY_PREFIX}rev-a`],
    "the deleted artifact's own revision blob is still collected",
  );

  const swept = await sweepAssetOrphans({ db: appDbOf(state), storage: storageOf(state), now: NOW });
  assert.deepEqual(swept, { examined: 1, candidates: 0, deleted: 0, failed: 0, kept: 0, listFailed: false });
  assert.equal(state.assets.has(shared), true, "the sweep keeps an asset another artifact references");
});

test("an unreferenced asset older than the grace window leaves storage and the table, and a young one stays", async () => {
  const state = world();
  const bytes = png(96);
  const young = png(120);
  const oldDigest = seedAsset(state, bytes, { lastModified: aged(2 * DAY_MS) });
  const youngDigest = seedAsset(state, young, { lastModified: aged(HOUR_MS) });

  const result = await sweepAssetOrphans({ db: appDbOf(state), storage: storageOf(state), now: NOW });
  assert.deepEqual(result, {
    examined: 2,
    candidates: 1,
    deleted: 1,
    failed: 0,
    kept: 0,
    listFailed: false,
  });
  assert.equal(state.objects.has(assetKeyOf(bytes)), false, "the aged object is removed from storage");
  assert.equal(state.assets.has(oldDigest), false, "the aged row is removed from the assets table");
  assert.equal(state.objects.has(assetKeyOf(young)), true, "an asset younger than the grace window is never removed");
  assert.equal(state.assets.has(youngDigest), true, "its row stays too");
});

test("the grace boundary is exclusive and a referenced asset is never a candidate", async () => {
  const state = world();
  const boundary = png(64);
  const referenced = png(80);
  seedAsset(state, boundary, { lastModified: new Date(NOW.getTime() - ASSET_GC_GRACE_MS) });
  seedAsset(state, referenced, { lastModified: aged(30 * DAY_MS), referencedBy: [ARTIFACT_ID] });

  const result = await sweepAssetOrphans({ db: appDbOf(state), storage: storageOf(state), now: NOW });
  assert.deepEqual(result, { examined: 2, candidates: 0, deleted: 0, failed: 0, kept: 0, listFailed: false });
  assert.equal(state.objects.has(assetKeyOf(boundary)), true, "only strictly older keys are candidates");
  assert.equal(state.objects.has(assetKeyOf(referenced)), true, "a reference of any age protects the object");
  assert.deepEqual(state.deletes, [], "the run deletes nothing at all");
});

test("a reference that appears before the row is dropped keeps the object", async () => {
  const state = world();
  const bytes = png();
  const digest = seedAsset(state, bytes, { lastModified: aged(3 * DAY_MS) });
  const keptRow: DropAssetRowFn = async (db, sha256) => {
    state.references.push({ artifactId: OTHER_ARTIFACT_ID, assetSha256: sha256 });
    return dropAssetRow(db, sha256);
  };
  const result = await sweepAssetOrphans({
    db: appDbOf(state),
    storage: storageOf(state),
    now: NOW,
    dropAssetRowFn: keptRow,
  });
  assert.deepEqual(result, { examined: 1, candidates: 1, deleted: 0, failed: 0, kept: 1, listFailed: false });
  assert.equal(state.objects.has(assetKeyOf(bytes)), true, "the object survives a reference that arrived in time");
  assert.equal(state.assets.has(digest), true, "and so does its row");
  assert.deepEqual(state.deletes, []);
});

test("one failed object delete neither aborts the sweep nor loses the next candidate", async () => {
  const state = world();
  const failing = png(64);
  const healthy = png(72);
  seedAsset(state, failing, { lastModified: aged(5 * DAY_MS) });
  seedAsset(state, healthy, { lastModified: aged(5 * DAY_MS) });
  const failingKey = assetKeyOf(failing);

  const first = await sweepAssetOrphans({
    db: appDbOf(state),
    storage: storageOf(state),
    now: NOW,
    deleteAssetBytesFn: async (input) => {
      if (input.storageKey === failingKey) return { ok: false, kind: "conflict", reason: "injected storage failure" };
      state.objects.delete(input.storageKey);
      return { ok: true, value: { storageKey: input.storageKey } };
    },
  });
  assert.deepEqual(first, { examined: 2, candidates: 2, deleted: 1, failed: 1, kept: 0, listFailed: false });
  assert.equal(state.objects.has(failingKey), true, "the failed object stays for the next run");

  const second = await sweepAssetOrphans({
    db: appDbOf(state),
    storage: storageOf(state),
    now: NOW,
    deleteAssetBytesFn: async (input) => {
      state.objects.delete(input.storageKey);
      return { ok: true, value: { storageKey: input.storageKey } };
    },
  });
  assert.deepEqual(second, { examined: 1, candidates: 1, deleted: 1, failed: 0, kept: 0, listFailed: false });
  assert.equal(state.objects.has(failingKey), false, "the retry collects the object the first run could not");
  assert.equal((await sweepAssetOrphans({ db: appDbOf(state), storage: storageOf(state), now: NOW })).examined, 0);
});

test("the sweep never lists or deletes anything outside the asset prefix", async () => {
  const state = world();
  const bytes = png();
  const digest = seedAsset(state, bytes, { lastModified: aged() });
  state.objects.set(`${REVISION_KEY_PREFIX}rev-a`, { bytes: png(32), lastModified: aged() });
  state.objects.set(stagingStorageKey("a".repeat(64)), { bytes: png(32), lastModified: aged() });
  state.objects.set(`${ASSET_KEY_PREFIX}not-a-digest`, { bytes: png(32), lastModified: aged() });

  const result = await sweepAssetOrphans({ db: appDbOf(state), storage: storageOf(state), now: NOW });
  assert.deepEqual(result, { examined: 1, candidates: 1, deleted: 1, failed: 0, kept: 0, listFailed: false });
  assert.equal(state.objects.has(assetKeyOf(bytes)), false, "the one real orphan key is collected");
  assert.deepEqual(
    [...state.objects.keys()].sort(),
    [`${ASSET_KEY_PREFIX}not-a-digest`, `${REVISION_KEY_PREFIX}rev-a`, stagingStorageKey("a".repeat(64))].sort(),
    "a revision key, a staging key and a malformed asset key are out of scope",
  );
  assert.equal(state.assets.has(digest), false, "the collected row is gone");
});

test("a failed listing page ends the run with no delete instead of guessing", async () => {
  const state = world();
  const bytes = png();
  seedAsset(state, bytes, { lastModified: aged() });
  const result = await sweepAssetOrphans({
    db: appDbOf(state),
    storage: storageOf(state),
    now: NOW,
    listAssetKeysFn: async () => ({ ok: false, kind: "conflict", reason: "injected listing failure" }),
  });
  assert.deepEqual(result, { examined: 0, candidates: 0, deleted: 0, failed: 0, kept: 0, listFailed: true });
  assert.equal(state.objects.has(assetKeyOf(bytes)), true, "an unreadable listing deletes nothing");
  assert.equal(state.deletes.length, 0);
});

test("the per-run cap pages the listing instead of sweeping the whole bucket", async () => {
  const state = world();
  const bytes = Array.from({ length: 6 }, (_, index) => png(48 + index));
  for (const body of bytes) seedAsset(state, body, { lastModified: aged() });
  const result = await sweepAssetOrphans({ db: appDbOf(state), storage: storageOf(state), now: NOW, maxKeysPerRun: 2 });
  assert.deepEqual(result, { examined: 2, candidates: 2, deleted: 2, failed: 0, kept: 0, listFailed: false });
  assert.equal(state.objects.size, 4, "the run stops at the cap and leaves the rest of the bucket");
});

test("re-uploading collected bytes stores them again and answers the same digest", async () => {
  const state = world();
  const bytes = png(140);
  const sha256 = digestOf(bytes);
  assert.equal(seedAsset(state, bytes, { lastModified: aged() }), sha256);
  const collected = await sweepAssetOrphans({ db: appDbOf(state), storage: storageOf(state), now: NOW });
  assert.equal(collected.deleted, 1);
  assert.equal(state.assets.has(sha256), false, "the row is gone, so the upload cannot assume one exists");
  assert.equal(state.objects.has(assetKeyOf(bytes)), false, "the object is gone too");

  const response = await reupload(state, bytes);
  assert.deepEqual(
    [response.status, await response.json()],
    [201, { id: sha256, sizeBytes: bytes.length, contentType: "image/png" }],
    "the same bytes are stored again under the same digest",
  );
  assert.equal(state.objects.has(assetKeyOf(bytes)), true, "the object is written back");
  assert.equal(state.assets.get(sha256)?.storageKey, assetKeyOf(bytes), "the row is recreated");
  assert.deepEqual(state.references, [{ artifactId: ARTIFACT_ID, assetSha256: sha256 }], "and referenced again");

  const after = await sweepAssetOrphans({ db: appDbOf(state), storage: storageOf(state), now: NOW });
  assert.deepEqual(after, { examined: 1, candidates: 0, deleted: 0, failed: 0, kept: 0, listFailed: false });
  assert.equal(state.objects.has(assetKeyOf(bytes)), true, "the fresh upload is younger than the grace window");
});

test("the asset sweep has its own grace window and cadence, logged per run and stoppable", async () => {
  assert.equal(ASSET_GC_GRACE_MS, DAY_MS, "an asset unreferenced for less than a day is never a candidate");
  assert.equal(ASSET_GC_INTERVAL_MS, DAY_MS);
  assert.equal(ASSET_GC_STARTUP_DELAY_MS > 0 && ASSET_GC_STARTUP_DELAY_MS < ASSET_GC_INTERVAL_MS, true);
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const lines: string[] = [];
    const calls: number[] = [];
    const loop = startAssetGcLoop({
      database: { db: {} } as unknown as Database,
      storage: {} as never,
      sweepFn: async (): Promise<AssetSweepResult> => {
        calls.push(1);
        return { examined: 4, candidates: 2, deleted: 2, failed: 0, kept: 0, listFailed: false };
      },
      log: (line) => lines.push(line),
    });
    const flush = async (): Promise<void> => {
      for (let index = 0; index < 3; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    };
    mock.timers.tick(ASSET_GC_STARTUP_DELAY_MS);
    await flush();
    assert.equal(calls.length, 1, "one sweep shortly after start");
    assert.match(lines[0] ?? "", /^\[asset-gc\] examined=4 candidates=2 deleted=2 failed=0 kept=0 listFailed=false/);
    mock.timers.tick(ASSET_GC_INTERVAL_MS);
    await flush();
    assert.equal(calls.length, 2, "the interval fires the next sweep");
    loop.stop();
    mock.timers.tick(ASSET_GC_INTERVAL_MS * 3);
    await flush();
    assert.equal(calls.length, 2, "stop() clears both timers");
  } finally {
    mock.timers.reset();
  }
});
