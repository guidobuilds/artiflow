import assert from "node:assert/strict";
import { test } from "node:test";

import {
  artifacts,
  artifactChunks,
  artifactRevisions,
  artifactUploads,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { commitUpload, writeArtifact, type CommitFlowResult } from "../apps/api/src/domain/commit-flow.ts";

const OWNER = "3f1e4d5c-6b7a-4891-9a2c-4d5e6f7a8b9c";
const ARTIFACT = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const UPLOAD = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const REVISION = "c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f";
const encoder = new TextEncoder();
const EMPTY_DESIGN = JSON.stringify({ formatVersion: 1, frames: [] });
const FRAMED_DESIGN = JSON.stringify({
  formatVersion: 1,
  frames: [{ id: "home", name: "Checkout A", x: 0, y: 0, w: 375, h: 812, nodes: [] }],
});

type Row = {
  id: string;
  ownerId: string;
  title: string | null;
  kind: string;
  currentRevisionId: string | null;
  observedSizeBytes: number;
  deletedAt: Date | null;
  updatedAt: Date;
};

type Upload = { id: string; ownerId: string; status: string; declaredSizeBytes: number; expiresAt: Date };
type World = {
  artifact: Row | null;
  revisions: Record<string, unknown>[];
  upload: Upload | null;
  chunks: { uploadId: string; chunkIndex: number; sizeBytes: number }[];
  objects: Map<string, Uint8Array>;
  mutations: string[];
};

const world = (seed: Partial<Row> | null = null): World => ({
  artifact:
    seed === null
      ? null
      : {
          id: ARTIFACT,
          ownerId: OWNER,
          title: "Checkout options",
          kind: "canvas",
          currentRevisionId: REVISION,
          observedSizeBytes: 0,
          deletedAt: null,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          ...seed,
        },
  revisions: [],
  upload: null,
  chunks: [],
  objects: new Map(),
  mutations: [],
});

const rowsFor = (held: World, tables: readonly unknown[], projection?: Record<string, unknown>): unknown[] => {
  if (tables.includes(artifacts)) {
    const row = held.artifact;
    if (row === null) return [];
    if (projection !== undefined && "kind" in projection)
      return [{ ...row, revisionCount: held.revisions.length + (row.currentRevisionId === null ? 0 : 1) }];
    if (projection !== undefined && "ownerId" in projection)
      return [{ ownerId: row.ownerId, currentRevisionId: row.currentRevisionId }];
    if (projection !== undefined && "deletedAt" in projection)
      return [{ currentRevisionId: row.currentRevisionId, deletedAt: row.deletedAt }];
    return [row];
  }
  if (tables.includes(artifactChunks)) return held.chunks;
  if (tables.includes(artifactUploads)) return held.upload === null ? [] : [held.upload];
  if (tables.includes(artifactRevisions)) return held.revisions;
  return [];
};

type Chain = PromiseLike<unknown[]> & Record<string, unknown>;

const selectBuilder = (
  held: World,
  tables: readonly unknown[],
  projection?: Record<string, unknown>,
): Chain => {
  const next = (added: readonly unknown[]): Chain => selectBuilder(held, added, projection);
  let builder: Chain;
  const chain: Record<string, unknown> = {
    from: (table: unknown) => next([...tables, table]),
    leftJoin: (table: unknown) => next([...tables, table]),
    innerJoin: (table: unknown) => next([...tables, table]),
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    groupBy: () => builder,
    for: () => builder,
    $dynamic: () => builder,
  };
  builder = Object.assign(Promise.resolve().then(() => rowsFor(held, tables, projection)), chain) as Chain;
  return builder;
};

const insertBuilder = (held: World, table: unknown): Chain => {
  const inserted: Record<string, unknown>[] = [];
  let builder: Chain;
  const chain: Record<string, unknown> = {
    values: (values: Record<string, unknown>) => {
      if (table === artifacts) {
        held.mutations.push("insert:artifacts");
        if (held.artifact === null) {
          held.artifact = {
            id: String(values.id),
            ownerId: String(values.ownerId),
            title: (values.title ?? null) as string | null,
            kind: String(values.kind),
            currentRevisionId: null,
            observedSizeBytes: 0,
            deletedAt: null,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          };
          inserted.push({ id: values.id });
        }
      } else if (table === artifactRevisions) {
        held.mutations.push("insert:artifactRevisions");
        held.revisions.push(values);
      }
      return builder;
    },
    onConflictDoNothing: () => builder,
    returning: () => Promise.resolve(inserted),
  };
  builder = Object.assign(Promise.resolve().then(() => inserted), chain) as Chain;
  return builder;
};

const updateBuilder = (held: World, table: unknown): Chain => {
  const rows: Record<string, unknown>[] = [];
  let builder: Chain;
  const chain: Record<string, unknown> = {
    set: (values: Record<string, unknown>) => {
      if (table === artifacts) {
        held.mutations.push("update:artifacts");
        if (held.artifact !== null) {
          held.artifact = { ...held.artifact, ...values } as Row;
          rows.splice(0, rows.length, { id: held.artifact.id });
        }
      } else if (table === artifactUploads) {
        held.mutations.push("update:artifactUploads");
        if (held.upload !== null) {
          held.upload = { ...held.upload, ...values } as Upload;
          rows.splice(0, rows.length, { ...held.upload });
        }
      }
      return builder;
    },
    where: () => builder,
    returning: () => Promise.resolve().then(() => rows),
  };
  builder = Object.assign(Promise.resolve().then(() => rows), chain) as Chain;
  return builder;
};

const fakeDatabase = (held: World): Database => {
  const db = {
    select: (projection?: Record<string, unknown>) => selectBuilder(held, [], projection),
    insert: (table: unknown) => insertBuilder(held, table),
    update: (table: unknown) => updateBuilder(held, table),
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return { db } as unknown as Database;
};

const fakeStorage = (held: World): Storage =>
  ({
    client: {
      send: async (command: { constructor: { name: string }; input?: Record<string, unknown> }) => {
        const name = command.constructor.name;
        const key = String(command.input?.Key ?? "");
        const stored = held.objects.get(key);
        if (name === "PutObjectCommand") {
          held.objects.set(key, command.input?.Body as Uint8Array);
          return {};
        }
        if (name === "HeadObjectCommand") {
          if (stored === undefined) throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
          return { ContentLength: stored.length };
        }
        if (name === "GetObjectCommand") {
          if (stored === undefined) throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
          return {
            ContentLength: stored.length,
            Body: (async function* () {
              yield stored;
            })(),
          };
        }
        throw new Error(`unexpected command ${name}`);
      },
    },
    bucket: "test-bucket",
    checkBucket: async () => undefined,
    destroy: () => undefined,
  }) as unknown as Storage;

const stage = (held: World, bytes: Uint8Array): void => {
  held.upload = {
    id: UPLOAD,
    ownerId: OWNER,
    status: "open",
    declaredSizeBytes: bytes.length,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  };
  held.chunks = [{ uploadId: UPLOAD, chunkIndex: 0, sizeBytes: bytes.length }];
};

const refusalOf = (result: CommitFlowResult): { kind: string; reason: string } => {
  if (result.ok) assert.fail("the publish must be refused");
  return result;
};

test("a Design whose bytes are not a scene is refused before any revision is stored", async () => {
  const held = world();
  const result = await writeArtifact({
    database: fakeDatabase(held),
    storage: fakeStorage(held),
    ownerId: OWNER,
    bytes: encoder.encode("This is an HTML page, not a scene at all"),
    title: "Checkout options",
    kind: "canvas",
  });
  const refusal = refusalOf(result);
  assert.equal(refusal.kind, "validation");
  assert.equal(refusal.reason, "malformed_scene");
  assert.equal(held.artifact, null, "no artifact row is created");
  assert.deepEqual(held.revisions, [], "no revision row is written");
  assert.equal(held.objects.size, 0, "no object is stored for bytes the viewer cannot draw");
});

test("a Design with no formatVersion is refused instead of publishing an unopenable link", async () => {
  const held = world();
  const result = await writeArtifact({
    database: fakeDatabase(held),
    storage: fakeStorage(held),
    ownerId: OWNER,
    bytes: encoder.encode('{"frames":[]}'),
    kind: "canvas",
  });
  const refusal = refusalOf(result);
  assert.equal(refusal.kind, "validation");
  assert.equal(refusal.reason, "missing_format_version");
  assert.deepEqual(held.mutations, [], "the refusal touches no table");
});

test("the staged path refuses an invalid scene before the upload is consumed", async () => {
  const bytes = encoder.encode("<!doctype html><html></html>");
  const held = world();
  stage(held, bytes);
  const result = await commitUpload({
    database: fakeDatabase(held),
    storage: fakeStorage(held),
    ownerId: OWNER,
    uploadId: UPLOAD,
    bytes,
    kind: "canvas",
  });
  assert.equal(refusalOf(result).kind, "validation", "an invalid scene must not complete the staged upload");
  assert.equal(held.upload?.status, "open", "the upload stays open so the client can retry");
  assert.deepEqual(held.revisions, []);
  assert.equal(held.objects.size, 0);
});

test("revising an existing Design with kind omitted refuses invalid scene bytes and keeps the revision", async () => {
  const held = world({ currentRevisionId: REVISION });
  const before = held.artifact?.currentRevisionId;
  const result = await writeArtifact({
    database: fakeDatabase(held),
    storage: fakeStorage(held),
    ownerId: OWNER,
    bytes: encoder.encode("not a scene at all"),
    artifactId: ARTIFACT,
    expectedRevisionId: REVISION,
    title: "Checkout options",
  });
  assert.equal(refusalOf(result).kind, "validation", "the kind of an existing Design still gates its bytes");
  assert.equal(held.artifact?.currentRevisionId, before, "the current revision never moves");
  assert.deepEqual(held.revisions, []);
  assert.equal(held.objects.size, 0);
});

test("an empty Design still publishes and stores exactly the scene", async () => {
  const held = world();
  const result = await writeArtifact({
    database: fakeDatabase(held),
    storage: fakeStorage(held),
    ownerId: OWNER,
    bytes: encoder.encode(EMPTY_DESIGN),
    title: "Checkout options",
    kind: "canvas",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(held.artifact?.kind, "canvas");
  assert.equal(held.revisions.length, 1);
  assert.deepEqual([...held.objects.values()], [encoder.encode(EMPTY_DESIGN)]);
});

test("a framed Design still publishes through the staged path", async () => {
  const bytes = encoder.encode(FRAMED_DESIGN);
  const held = world();
  stage(held, bytes);
  const result = await commitUpload({
    database: fakeDatabase(held),
    storage: fakeStorage(held),
    ownerId: OWNER,
    uploadId: UPLOAD,
    bytes,
    title: "Checkout options",
    kind: "canvas",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(held.artifact?.kind, "canvas");
  assert.equal(held.upload?.status, "complete");
});

test("revising an existing Design with kind omitted still accepts a valid scene", async () => {
  const held = world({ currentRevisionId: REVISION });
  const result = await writeArtifact({
    database: fakeDatabase(held),
    storage: fakeStorage(held),
    ownerId: OWNER,
    bytes: encoder.encode(FRAMED_DESIGN),
    artifactId: ARTIFACT,
    expectedRevisionId: REVISION,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(held.revisions.length, 1, "the new revision is written");
  assert.notEqual(held.artifact?.currentRevisionId, REVISION, "the pointer advances");
});

test("a Page keeps publishing without scene validation", async () => {
  const held = world();
  const html = encoder.encode("<!doctype html><html><title>Quarterly report</title></html>");
  const result = await writeArtifact({
    database: fakeDatabase(held),
    storage: fakeStorage(held),
    ownerId: OWNER,
    bytes: html,
    title: "Quarterly report",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(held.artifact?.kind, "html", "an omitted kind still creates the default Page");
  assert.deepEqual([...held.objects.values()], [html]);
});

test("scene bytes that are not UTF-8 text are refused", async () => {
  const held = world();
  const result = await writeArtifact({
    database: fakeDatabase(held),
    storage: fakeStorage(held),
    ownerId: OWNER,
    bytes: new Uint8Array([0xff, 0xfe, 0x00]),
    kind: "canvas",
  });
  assert.equal(refusalOf(result).kind, "validation");
  assert.equal(held.objects.size, 0);
});
