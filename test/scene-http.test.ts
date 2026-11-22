import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { sceneDraftResponseSchema, saveSceneRequestSchema, savedSceneSchema } from "@artiflow/contracts/scene";
import { SCENE_FORMAT_VERSION, canonicalScene, type Scene } from "@artiflow/domain/scene";

import { createSceneApp } from "../apps/api/src/routes/scene.ts";
import type { EditingOptions } from "../apps/api/src/routes/editing.ts";
import {
  FREEZE_INTERVAL_MS,
  type ArtifactDocumentState,
  type DocumentStore,
  type DraftRecord,
  type OperationRecord,
  type SnapshotRecord,
} from "../apps/api/src/domain/documents/service.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type FakeStorage = Storage & { objects: Map<string, Uint8Array> };

const providerError = (status: number): Error =>
  Object.assign(new Error(`provider ${status}`), { $metadata: { httpStatusCode: status } });

function fakeStorage(seed: Record<string, Uint8Array> = {}): FakeStorage {
  const objects = new Map<string, Uint8Array>(Object.entries(seed));
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const name = command.constructor.name;
      const key = String(command.input.Key ?? "");
      const stored = objects.get(key);
      if (name === "HeadObjectCommand") {
        if (!stored) throw providerError(404);
        return { ContentLength: stored.length };
      }
      if (name === "PutObjectCommand") {
        objects.set(key, Uint8Array.from(command.input.Body as Uint8Array));
        return {};
      }
      if (name === "GetObjectCommand") {
        if (!stored) throw providerError(404);
        return {
          Body: (async function* (): AsyncIterable<Uint8Array> {
            yield stored;
          })(),
        };
      }
      if (name === "DeleteObjectCommand") {
        objects.delete(key);
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
    objects,
  };
}

const OWNER_ID = "0f0e6d5c-4b3a-4928-8176-655443322110";
const STRANGER_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const CANVAS_ID = randomUUID();
const DASHBOARD_ORIGIN = "http://127.0.0.1:5173";

const rect = (id: string, x: number, y: number): Record<string, unknown> => ({
  id,
  type: "rect",
  x,
  y,
  w: 20,
  h: 20,
  fill: "#eeeeee",
});
const label = (id: string, x: number, y: number): Record<string, unknown> => ({
  id,
  type: "text",
  x,
  y,
  w: 100,
  h: 20,
  text: "Hello",
});
const sceneOf = (nodes: Record<string, unknown>[]): Scene =>
  ({
    formatVersion: SCENE_FORMAT_VERSION,
    frames: [{ id: "f1", name: "Home", x: 40, y: 20, w: 300, h: 200, nodes }],
  }) as unknown as Scene;

const PUBLISHED = sceneOf([rect("n1", 10, 10), label("n2", 10, 60)]);
const DRAFTED = sceneOf([rect("n1", 40, 40), label("n2", 10, 60)]);
const DRAGGED = sceneOf([rect("n1", 120, 60), label("n2", 10, 60)]);
const RETITLED = sceneOf([rect("n1", 10, 10), { ...label("n2", 10, 60), text: "Hello there" }]);
const REORDERED = sceneOf([label("n2", 10, 60), rect("n1", 10, 10)]);

type RouteArtifact = {
  id: string;
  ownerId: string;
  kind: string;
  title: string;
  revisionId: string;
  revisionNumber: number;
  storageKey: string;
  sha256: string;
  publishedSeq: number;
  access: string;
};
type RouteRevision = SnapshotRecord & { id: string; revision: number };
type RouteOperation = OperationRecord & { id: string };

type WorldOptions = {
  kind?: string;
  access?: string;
  visible?: boolean;
  snapshotAgeMs?: number;
  draft?: { seq: number; scene: Scene };
  user?: string;
};

const builder = (results: () => unknown[]) => {
  const query: Record<string, unknown> = {};
  const chain = () => query;
  for (const name of [
    "select",
    "from",
    "leftJoin",
    "innerJoin",
    "where",
    "orderBy",
    "limit",
    "for",
    "set",
    "values",
    "returning",
    "insert",
    "update",
  ])
    query[name] = chain;
  query.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(results()).then(onFulfilled, onRejected);
  return query;
};

function routeWorld(options: WorldOptions = {}) {
  const bytes = new TextEncoder().encode(canonicalScene(PUBLISHED));
  const storage = fakeStorage();
  const storageKey = newRevisionStorageKey();
  storage.objects.set(storageKey, bytes);
  const sha256 = digestOf(bytes);
  const revisionId = randomUUID();
  const artifact: RouteArtifact = {
    id: CANVAS_ID,
    ownerId: OWNER_ID,
    kind: options.kind ?? "canvas",
    title: "Home",
    revisionId,
    revisionNumber: 1,
    storageKey,
    sha256,
    publishedSeq: 0,
    access: options.access ?? "owner",
  };
  const revisions: RouteRevision[] = [
    {
      id: revisionId,
      revision: 1,
      artifactId: CANVAS_ID,
      formatVersion: SCENE_FORMAT_VERSION,
      seqFrom: 0,
      seqTo: 0,
      sizeBytes: bytes.length,
      sha256,
      storageKey,
      blockIndex: null,
      createdAt: new Date(Date.now() - (options.snapshotAgeMs ?? 0)),
    },
  ];
  const drafts = new Map<string, DraftRecord>();
  if (options.draft)
    drafts.set(CANVAS_ID, {
      artifactId: CANVAS_ID,
      seq: options.draft.seq,
      formatVersion: SCENE_FORMAT_VERSION,
      state: { formatVersion: SCENE_FORMAT_VERSION, scene: options.draft.scene },
      updatedByUserId: null,
      updatedAt: new Date(),
    });
  const operations: RouteOperation[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const documents: DocumentStore = {
    readArtifact: async (artifactId: string): Promise<ArtifactDocumentState | null> => {
      if (artifactId !== CANVAS_ID) return null;
      const mine = revisions.filter((revision) => revision.artifactId === artifactId);
      const current = mine.find((revision) => revision.id === artifact.revisionId);
      return {
        artifactId,
        kind: artifact.kind,
        publishedSeq: artifact.publishedSeq,
        currentRevisionId: artifact.revisionId,
        revisionCount: mine.length,
        latestSnapshot: current
          ? {
              storageKey: current.storageKey,
              sha256: current.sha256,
              formatVersion: current.formatVersion,
              createdAt: current.createdAt,
            }
          : null,
      };
    },
    readDraft: async (artifactId: string) => drafts.get(artifactId) ?? null,
    insertDraftIfAbsent: async (record: DraftRecord) => {
      if (!drafts.has(record.artifactId)) drafts.set(record.artifactId, record);
      return drafts.get(record.artifactId) as DraftRecord;
    },
    readOperation: async (artifactId: string, idempotencyKey: string) =>
      operations.find((row) => row.artifactId === artifactId && row.idempotencyKey === idempotencyKey) ?? null,
    readSnapshotAtOrBefore: async (artifactId: string, seq: number) => {
      const row = revisions
        .filter((revision) => revision.artifactId === artifactId && revision.seqTo <= seq)
        .sort((left, right) => right.seqTo - left.seqTo || right.revision - left.revision)[0];
      return row
        ? { seqTo: row.seqTo, storageKey: row.storageKey, sha256: row.sha256, formatVersion: row.formatVersion }
        : null;
    },
    readAppliedOperations: async (artifactId: string, afterSeq: number, toSeq: number) =>
      operations
        .filter((row) => row.artifactId === artifactId && row.result === "applied")
        .filter((row) => row.seq > afterSeq && row.seq <= toSeq)
        .sort((left, right) => left.seq - right.seq),
    commitOperation: (input) =>
      serial(async () => {
        if (operations.some((row) => row.idempotencyKey === input.operation.idempotencyKey))
          return { committed: false };
        if (
          input.draft &&
          operations.some(
            (row) =>
              row.artifactId === input.operation.artifactId &&
              row.result === "applied" &&
              row.seq === input.operation.seq,
          )
        )
          return { committed: false };
        operations.push({ ...input.operation, id: `op-${operations.length + 1}` });
        if (input.draft) drafts.set(input.draft.artifactId, input.draft);
        return { committed: true };
      }),
    commitSnapshot: (input) =>
      serial(async () => {
        if (artifact.publishedSeq !== input.expectedPublishedSeq)
          return { committed: false, revisionId: null, revisionNumber: null };
        if ((drafts.get(input.revision.artifactId)?.seq ?? artifact.publishedSeq) !== input.expectedDraftSeq)
          return { committed: false, revisionId: null, revisionNumber: null };
        if (input.operation) {
          if (operations.some((row) => row.idempotencyKey === input.operation?.idempotencyKey))
            return { committed: false, revisionId: null, revisionNumber: null };
          operations.push({ ...input.operation, id: `op-${operations.length + 1}` });
        }
        const revisionNumber = revisions.filter((row) => row.artifactId === input.revision.artifactId).length + 1;
        const id = randomUUID();
        revisions.push({ ...input.revision, id, revision: revisionNumber });
        artifact.publishedSeq = input.revision.seqTo;
        artifact.revisionId = id;
        artifact.revisionNumber = revisionNumber;
        if (input.draft) drafts.set(input.draft.artifactId, input.draft);
        return { committed: true, revisionId: id, revisionNumber };
      }),
  };
  const queued = (results: unknown[][]) => {
    let index = 0;
    return builder(() => results[index++] ?? []);
  };
  const database = (results?: unknown[][]) => {
    const rows = results ?? [options.visible === false ? [] : [artifact]];
    const db: Record<string, unknown> = queued(rows);
    db.transaction = async (run: (tx: unknown) => Promise<unknown>) =>
      run(queued([[{ currentRevisionId: artifact.revisionId, deletedAt: null }], [], [{ id: artifact.id }]]));
    return { db } as unknown as Database;
  };
  const draftScene = (): Scene | null => {
    const record = drafts.get(CANVAS_ID);
    return record ? (record.state as { scene: Scene }).scene : null;
  };
  return {
    artifact,
    revisions,
    drafts,
    operations,
    documents,
    database,
    storage,
    draftScene,
    user: options.user ?? OWNER_ID,
  };
}

type World = ReturnType<typeof routeWorld>;

const sessionFor = (userId: string) =>
  ({ api: { getSession: async () => ({ user: { id: userId } }) } }) as unknown as EditingOptions["auth"];

const headers = { origin: DASHBOARD_ORIGIN, "content-type": "application/json" };

const appOf = (world: World, options: Partial<EditingOptions> = {}) =>
  createSceneApp({
    database: world.database(),
    auth: sessionFor(world.user),
    storage: world.storage,
    publicOrigin: DASHBOARD_ORIGIN,
    documentStore: world.documents,
    ...options,
  });

const read = (world: World, options: Partial<EditingOptions> = {}, extra: Record<string, string> = {}) =>
  appOf(world, options).request(`/api/artifacts/${CANVAS_ID}/scene`, {
    method: "GET",
    headers: { origin: DASHBOARD_ORIGIN, ...extra },
  });

const save = (world: World, body: unknown, options: Partial<EditingOptions> = {}, extra: Record<string, string> = {}) =>
  appOf(world, options).request(`/api/artifacts/${CANVAS_ID}/scene`, {
    method: "PUT",
    headers: { ...headers, ...extra },
    body: JSON.stringify(body),
  });

const bodyOf = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

test("a GET on a canvas with no draft returns the published scene and its sequences", async () => {
  const world = routeWorld();
  const response = await read(world);
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(Object.keys(body).sort(), ["artifactId", "kind", "publishedSeq", "revisionId", "scene", "seq"]);
  assert.deepEqual(
    [body.kind, body.artifactId, body.revisionId, body.seq, body.publishedSeq],
    ["canvas", CANVAS_ID, world.artifact.revisionId, 0, 0],
    "the published pointer is the sequence a client sends back",
  );
  assert.deepEqual(body.scene, PUBLISHED, "the scene is materialised from the published snapshot");
  assert.deepEqual(sceneDraftResponseSchema.parse(body), body, "the read matches the wire contract");
  assert.equal(world.operations.length, 0, "a read appends no operation row");
  const draft = world.drafts.get(CANVAS_ID);
  assert.equal(draft?.seq, 0, "a read with no draft materialises one at the published sequence");
  assert.deepEqual(world.draftScene(), PUBLISHED);
});

test("a GET on a canvas with a draft returns the draft scene and the draft sequence", async () => {
  const world = routeWorld({ draft: { seq: 3, scene: DRAFTED } });
  const response = await read(world);
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual([body.seq, body.publishedSeq], [3, 0], "the draft sequence is what the editor must send back");
  assert.deepEqual(body.scene, DRAFTED, "the read follows the draft, not the published snapshot");
  assert.equal(body.revisionId, world.artifact.revisionId, "the revision is still the published one");
  assert.deepEqual(world.drafts.size, 1, "a read over an existing draft writes nothing");
});

test("a PUT with the right sequence applies and answers the new sequence", async () => {
  const world = routeWorld();
  const response = await save(world, { scene: RETITLED, expectedSeq: 0 });
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(Object.keys(body).sort(), ["applied", "artifactId", "frozen", "publishedSeq", "revisionId", "seq"]);
  assert.deepEqual(
    [body.seq, body.publishedSeq, body.frozen, body.applied, body.revisionId],
    [1, 0, false, 1, world.artifact.revisionId],
    "an unfrozen save reports the draft sequence and keeps the published revision",
  );
  assert.deepEqual(savedSceneSchema.parse(body), body, "the save matches the wire contract");
  assert.deepEqual(world.draftScene(), RETITLED);
  const again = await save(world, { scene: RETITLED, expectedSeq: 1 });
  assert.equal(again.status, 200);
  const repeated = await bodyOf(again);
  assert.deepEqual([repeated.seq, repeated.applied], [1, 0], "a save that changes nothing moves nothing");
  assert.equal(world.operations.length, 1, "a save that changes nothing appends no row");
});

test("a PUT that changes one node's position appends one move and no snapshot", async () => {
  const world = routeWorld();
  const response = await save(world, { scene: DRAGGED, expectedSeq: 0 });
  assert.equal(response.status, 200);
  assert.equal(world.operations.length, 1, "a drag is one operation row");
  const row = world.operations[0];
  assert.equal(row?.authorKind, "person", "the editor writes as a person");
  assert.equal(row?.authorId, OWNER_ID);
  assert.deepEqual(
    row?.ops,
    [{ op: "move_node", id: "n1", x: 120, y: 60 }],
    "the row carries the difference, not the scene",
  );
  assert.equal(world.revisions.length, 1, "a drag writes no snapshot");
  assert.equal(world.storage.objects.size, 1, "a drag stores no object");
  assert.deepEqual(world.draftScene(), DRAGGED);
  const after = await bodyOf(await read(world));
  assert.deepEqual([after.seq, after.publishedSeq], [1, 0]);
  assert.deepEqual(after.scene, DRAGGED, "the next read serves the dragged scene");
});

test("a stale sequence refuses with concurrent_edit and the current sequence, and changes nothing", async () => {
  const world = routeWorld();
  assert.equal((await save(world, { scene: DRAFTED, expectedSeq: 0 })).status, 200);
  const response = await save(world, { scene: DRAGGED, expectedSeq: 0 });
  assert.equal(response.status, 409);
  assert.deepEqual(await bodyOf(response), {
    error: "concurrent_edit",
    currentSeq: 1,
    currentRevisionId: world.artifact.revisionId,
  });
  assert.equal(world.operations.length, 1, "a refused save appends no row");
  assert.equal(world.revisions.length, 1, "a refused save writes no snapshot");
  assert.equal(world.storage.objects.size, 1, "a refused save stores no object");
  assert.deepEqual(world.draftScene(), DRAFTED, "the accepted scene survives the refusal");
  const retry = await save(world, { scene: DRAGGED, expectedSeq: 1 });
  assert.equal(retry.status, 200, "the same scene lands once the client catches up");
  assert.deepEqual(world.draftScene(), DRAGGED);
  assert.equal(world.operations.length, 2);
});

test("a missing sequence refuses with sequence_required and writes nothing", async () => {
  const world = routeWorld();
  const clean = await save(world, { scene: DRAFTED });
  assert.equal(clean.status, 409);
  assert.deepEqual(await bodyOf(clean), {
    error: "sequence_required",
    currentSeq: 0,
    currentRevisionId: world.artifact.revisionId,
  });
  assert.equal((await save(world, { scene: DRAFTED, expectedSeq: 0 })).status, 200);
  const pending = await save(world, { scene: DRAGGED });
  assert.equal(pending.status, 409);
  assert.deepEqual(await bodyOf(pending), {
    error: "sequence_required",
    currentSeq: 1,
    currentRevisionId: world.artifact.revisionId,
  });
  assert.equal(world.operations.length, 1, "neither refusal appends an operation row");
  assert.deepEqual(world.draftScene(), DRAFTED, "neither refusal moves the draft");
});

test("a PUT that crosses the freeze threshold reports the new revision id", async () => {
  const world = routeWorld({ snapshotAgeMs: FREEZE_INTERVAL_MS + 60_000 });
  const publishedBefore = world.artifact.revisionId;
  const response = await save(world, { scene: DRAGGED, expectedSeq: 0 });
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.deepEqual(
    [body.seq, body.publishedSeq, body.frozen],
    [1, 1, true],
    "the frozen save reports the published sequence",
  );
  assert.notEqual(body.revisionId, publishedBefore, "the frozen save reports the new revision");
  assert.equal(body.revisionId, world.revisions[1]?.id);
  assert.equal(world.revisions.length, 2, "the freeze writes exactly one snapshot");
  assert.equal(world.storage.objects.size, 2, "the snapshot is its own object");
  assert.equal(
    new TextDecoder().decode(world.storage.objects.get((world.revisions[1] as { storageKey: string }).storageKey)),
    canonicalScene(DRAGGED),
    "the snapshot publishes the scene the editor asked for",
  );
});

test("a markdown artifact refuses with wrong_kind on both routes", async () => {
  const world = routeWorld({ kind: "markdown" });
  const readResponse = await read(world);
  assert.deepEqual([readResponse.status, await bodyOf(readResponse)], [409, { error: "wrong_kind" }]);
  const saveResponse = await save(world, { scene: DRAFTED, expectedSeq: 0 });
  assert.deepEqual([saveResponse.status, await bodyOf(saveResponse)], [409, { error: "wrong_kind" }]);
  assert.equal(world.operations.length, 0);
  assert.equal(world.drafts.size, 0, "neither refusal opens a draft");
  assert.equal(world.storage.objects.size, 1);
});

test("a caller without the editor grant refuses with forbidden on both routes", async () => {
  const world = routeWorld({ access: "viewer" });
  const readResponse = await read(world);
  assert.deepEqual([readResponse.status, await bodyOf(readResponse)], [403, { error: "forbidden" }]);
  const saveResponse = await save(world, { scene: DRAFTED, expectedSeq: 0 });
  assert.deepEqual([saveResponse.status, await bodyOf(saveResponse)], [403, { error: "forbidden" }]);
  assert.equal(world.operations.length, 0);
  assert.equal(world.drafts.size, 0);
  assert.equal(world.storage.objects.size, 1);
});

test("another owner's canvas is not found on either route", async () => {
  const world = routeWorld({ access: "none", visible: false, user: STRANGER_ID });
  const readResponse = await read(world);
  assert.deepEqual([readResponse.status, await bodyOf(readResponse)], [404, { error: "not_found" }]);
  const saveResponse = await save(world, { scene: DRAFTED, expectedSeq: 0 });
  assert.deepEqual([saveResponse.status, await bodyOf(saveResponse)], [404, { error: "not_found" }]);
  assert.equal(world.operations.length, 0);
  assert.equal(world.drafts.size, 0);
});

test("an anonymous caller refuses with unauthorized on both routes", async () => {
  const world = routeWorld();
  const anonymous = { api: { getSession: async () => null } } as unknown as EditingOptions["auth"];
  assert.equal((await read(world, { auth: anonymous })).status, 401);
  assert.equal((await save(world, { scene: DRAFTED, expectedSeq: 0 }, { auth: anonymous })).status, 401);
  assert.equal(world.operations.length, 0);
});

test("the scene PUT keeps the origin and JSON guards the document save has", async () => {
  const world = routeWorld();
  const wrongOrigin = await save(world, { scene: DRAFTED, expectedSeq: 0 }, {}, { origin: "https://evil.example" });
  assert.deepEqual([wrongOrigin.status, await bodyOf(wrongOrigin)], [403, { error: "origin_not_allowed" }]);
  const wrongType = await save(world, { scene: DRAFTED, expectedSeq: 0 }, {}, { "content-type": "text/plain" });
  assert.deepEqual([wrongType.status, await bodyOf(wrongType)], [415, { error: "json_content_type_required" }]);
  assert.equal(world.operations.length, 0, "a refused save appends no row");
  assert.equal(world.drafts.size, 0, "a refused save opens no draft");
});

test("an oversize scene refuses with too_large and writes nothing", async () => {
  const world = routeWorld();
  const response = await save(world, { scene: DRAFTED, expectedSeq: 0 }, { maxArtifactBytes: 16 });
  assert.deepEqual([response.status, await bodyOf(response)], [413, { error: "too_large", maxBytes: 16 }]);
  assert.equal(world.operations.length, 0);
  assert.equal(world.drafts.size, 0);
});

test("an invalid scene keeps the operation_rejected vocabulary and writes nothing", async () => {
  const world = routeWorld();
  const outside = {
    formatVersion: SCENE_FORMAT_VERSION,
    frames: [{ id: "f1", name: "Home", x: 0, y: 0, w: 100, h: 100, nodes: [rect("n1", 200, 0)] }],
  };
  const response = await save(world, { scene: outside, expectedSeq: 0 });
  assert.equal(response.status, 409);
  assert.deepEqual(await bodyOf(response), {
    error: "operation_rejected",
    kind: "validation",
    reason: "outside_frame_bounds",
    path: "frames[0].nodes[0]",
  });
  assert.equal(world.operations.length, 0, "an invalid scene appends no row");
  assert.equal(world.revisions.length, 1, "an invalid scene writes no snapshot");
});

test("a change the operations cannot express falls back to one replace_scene", async () => {
  const world = routeWorld();
  const response = await save(world, { scene: REORDERED, expectedSeq: 0 });
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.applied, 1);
  assert.deepEqual(
    world.operations[0]?.ops,
    [{ op: "replace_scene", scene: REORDERED }],
    "a reordering the diff cannot express is refused by the replay check and replaced whole",
  );
  assert.deepEqual(world.draftScene(), REORDERED);
});

test("the replay check keeps an expressible difference out of the fallback", async () => {
  const world = routeWorld();
  const renamed = sceneOf([rect("n1", 10, 10), label("n2", 10, 60), rect("n3", 60, 10)]);
  assert.equal((await save(world, { scene: renamed, expectedSeq: 0 })).status, 200);
  assert.deepEqual(
    world.operations[0]?.ops,
    [{ op: "add_node", frameId: "f1", node: rect("n3", 60, 10) }],
    "an addition stays one add_node instead of a whole-scene replacement",
  );
  const removed = sceneOf([rect("n1", 10, 10)]);
  assert.equal((await save(world, { scene: removed, expectedSeq: 1 })).status, 200);
  assert.deepEqual(
    world.operations[1]?.ops,
    [
      { op: "remove_node", id: "n2" },
      { op: "remove_node", id: "n3" },
    ],
    "removals stay id-addressed",
  );
});

test("an untidy scene body keeps the refusal vocabulary the wire already knows", async () => {
  const world = routeWorld();
  const missing = await save(world, { expectedSeq: 0 });
  assert.deepEqual([missing.status, await bodyOf(missing)], [400, { error: "scene_required" }]);
  const notAnObject = await save(world, { scene: "not a scene", expectedSeq: 0 });
  assert.deepEqual([notAnObject.status, await bodyOf(notAnObject)], [400, { error: "scene_required" }]);
  const badSequence = await save(world, { scene: DRAFTED, expectedSeq: -1 });
  assert.deepEqual([badSequence.status, await bodyOf(badSequence)], [400, { error: "expected_seq_invalid" }]);
  assert.equal(world.operations.length, 0);
  assert.equal(world.drafts.size, 0);
});

test("the wire contract names the scene envelope and refuses a body without one", () => {
  assert.equal(saveSceneRequestSchema.safeParse({ scene: DRAFTED }).success, true);
  assert.equal(saveSceneRequestSchema.safeParse({ scene: DRAFTED, expectedSeq: 0 }).success, true);
  assert.equal(saveSceneRequestSchema.safeParse({ expectedSeq: 0 }).success, false, "the scene is required");
  assert.equal(saveSceneRequestSchema.safeParse({ scene: "x" }).success, false, "a scene is an object");
  assert.equal(saveSceneRequestSchema.safeParse({ scene: DRAFTED, expectedSeq: -1 }).success, false);
  assert.equal(saveSceneRequestSchema.safeParse({ scene: DRAFTED, expectedSeq: 1.5 }).success, false);
});
