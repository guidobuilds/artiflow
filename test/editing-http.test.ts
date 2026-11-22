import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import { createEditingApp, type EditingOptions } from "../apps/api/src/routes/editing.ts";
import { saveDocumentRequestSchema } from "@artiflow/contracts/document";
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
import { getRevisionBytes, isRevisionStorageKey, newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import { copyRevisionBytes } from "../apps/api/src/domain/commit-flow.ts";

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const payload = (size = 128): Buffer => randomBytes(size);

type FakeOptions = { failCommands?: readonly string[] };
type FakeStorage = Storage & { objects: Map<string, Uint8Array> };

const providerError = (status: number): Error =>
  Object.assign(new Error(`provider ${status}`), { $metadata: { httpStatusCode: status } });

function fakeStorage(seed: Record<string, Uint8Array> = {}, options: FakeOptions = {}): FakeStorage {
  const objects = new Map<string, Uint8Array>(Object.entries(seed));
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const name = command.constructor.name;
      if (options.failCommands?.includes(name)) throw providerError(500);
      const key = String(command.input.Key ?? "");
      const stored = objects.get(key);
      if (name === "HeadObjectCommand") {
        if (!stored) throw providerError(404);
        return { ContentLength: stored.length };
      }
      if (name === "PutObjectCommand") {
        objects.set(key, Buffer.from(command.input.Body as Uint8Array));
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

const pinned = (bytes: Uint8Array = payload()): { storageKey: string; sha256: string; bytes: Uint8Array } => ({
  storageKey: newRevisionStorageKey(),
  sha256: digestOf(bytes),
  bytes,
});

test("a restored revision is stored under its own key, never the pinned revision's key", async () => {
  const source = pinned(payload(512));
  const storage = fakeStorage({ [source.storageKey]: source.bytes });
  const copied = await copyRevisionBytes({
    storage,
    storageKey: source.storageKey,
    sha256: source.sha256,
  });
  assert.equal(copied.ok, true);
  if (!copied.ok) return;
  assert.notEqual(copied.value.storageKey, source.storageKey, "the restored revision names a different key");
  assert.equal(isRevisionStorageKey(copied.value.storageKey), true, "the new key keeps the revision key shape");
  assert.equal(copied.value.sha256, source.sha256, "identical bytes keep the pinned row's digest");
  assert.equal(storage.objects.size, 2, "the bytes exist under both keys: the pinned row keeps its own object");
  for (const key of [source.storageKey, copied.value.storageKey]) {
    const got = await getRevisionBytes({ storage, storageKey: key, sha256: source.sha256 });
    assert.equal(got.ok, true, "both revisions remain readable and digest-verified");
    if (got.ok) assert.deepEqual(Buffer.from(got.value.bytes), source.bytes);
  }
});

test("a repeated restore allocates a new key every time", async () => {
  const source = pinned(payload(256));
  const storage = fakeStorage({ [source.storageKey]: source.bytes });
  const keys = new Set([source.storageKey]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const copied = await copyRevisionBytes({ storage, storageKey: source.storageKey, sha256: source.sha256 });
    assert.equal(copied.ok, true);
    if (!copied.ok) return;
    assert.equal(keys.has(copied.value.storageKey), false, "a key is never reused across restores");
    keys.add(copied.value.storageKey);
  }
  assert.equal(storage.objects.size, 3, "three revisions of one content value, three objects");
});

test("a failed read stores nothing and returns the provider's failure kind", async () => {
  const source = pinned(payload(128));
  for (const storage of [
    fakeStorage({}, {}),
    fakeStorage({ [source.storageKey]: source.bytes }, { failCommands: ["GetObjectCommand"] }),
  ]) {
    const before = new Set(storage.objects.keys());
    const copied = await copyRevisionBytes({ storage, storageKey: source.storageKey, sha256: source.sha256 });
    assert.equal(copied.ok, false, "an unreadable pinned body fails the copy instead of storing anything");
    assert.deepEqual([...storage.objects.keys()], [...before], "no key was created");
  }
});

test("pinned bytes that disagree with the pinned row's digest are never re-stored", async () => {
  const source = pinned(payload(128));
  const tampered = payload(128);
  const storage = fakeStorage({ [source.storageKey]: tampered });
  const copied = await copyRevisionBytes({ storage, storageKey: source.storageKey, sha256: source.sha256 });
  assert.equal(copied.ok ? "ok" : copied.kind, "digest_mismatch");
  assert.deepEqual([...storage.objects.keys()], [source.storageKey], "the unverified bytes were not copied");
});

test("a failed put leaves the pinned key untouched and creates no second key", async () => {
  const source = pinned(payload(128));
  const storage = fakeStorage({ [source.storageKey]: source.bytes }, { failCommands: ["PutObjectCommand"] });
  const copied = await copyRevisionBytes({ storage, storageKey: source.storageKey, sha256: source.sha256 });
  assert.equal(copied.ok, false);
  assert.deepEqual([...storage.objects.keys()], [source.storageKey], "only the pinned revision's own object exists");
  const original = await getRevisionBytes({ storage, storageKey: source.storageKey, sha256: source.sha256 });
  assert.equal(original.ok, true, "the pinned revision is still readable");
});

const OWNER_ID = "0f0e6d5c-4b3a-4928-8176-655443322110";
const DOCUMENT_ID = randomUUID();
const DASHBOARD_ORIGIN = "http://127.0.0.1:5173";
const SEEDED = "# Notes\n\nThe second paragraph target text.\n";

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

type Query = Promise<unknown[]> & Record<string, unknown>;

const builder = (results: () => unknown[]) => {
  const chain = (): Query => {
    const methods: Record<string, unknown> = {};
    const query: Query = Object.assign(Promise.resolve().then(results), methods);
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
      query[name] = () => query;
    return query;
  };
  return { select: chain, insert: chain, update: chain };
};

function routeWorld(options: { kind?: string; text?: string; snapshotAgeMs?: number } = {}) {
  const text = options.text ?? SEEDED;
  const bytes = new TextEncoder().encode(text);
  const storage = fakeStorage();
  const storageKey = newRevisionStorageKey();
  storage.objects.set(storageKey, bytes);
  const sha256 = digestOf(bytes);
  const revisionId = randomUUID();
  const artifact: RouteArtifact = {
    id: DOCUMENT_ID,
    ownerId: OWNER_ID,
    kind: options.kind ?? "markdown",
    title: "Notes",
    revisionId,
    revisionNumber: 1,
    storageKey,
    sha256,
    publishedSeq: 0,
    access: "owner",
  };
  const revisions: RouteRevision[] = [
    {
      id: revisionId,
      revision: 1,
      artifactId: DOCUMENT_ID,
      formatVersion: 1,
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
      if (artifactId !== DOCUMENT_ID) return null;
      const mine = revisions.filter((revision) => revision.artifactId === artifactId);
      const current = mine.find((revision) => revision.id === artifact.revisionId);
      return {
        artifactId,
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
        if (artifact.publishedSeq !== input.expectedPublishedSeq) {
          return { committed: false, revisionId: null, revisionNumber: null };
        }
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
  const database = (results: unknown[][] = [[artifact], [{ count: revisions.length }]]) => {
    const db: Record<string, unknown> = queued(results);
    db.transaction = async (run: (tx: unknown) => Promise<unknown>) =>
      run(queued([[{ currentRevisionId: artifact.revisionId, deletedAt: null }], [], [{ id: artifact.id }]]));
    return { db } as unknown as Database;
  };
  const draftText = (): string | null => {
    const draft = drafts.get(DOCUMENT_ID);
    return draft ? (draft.state as { text: string }).text : null;
  };
  return { artifact, revisions, drafts, operations, documents, database, storage, draftText };
}

type World = ReturnType<typeof routeWorld>;

const sessionAuth = {
  api: { getSession: async () => ({ user: { id: OWNER_ID } }) },
} as unknown as EditingOptions["auth"];

const headers = { origin: DASHBOARD_ORIGIN, "content-type": "application/json" };

const appOf = (world: World, options: Partial<EditingOptions> = {}) =>
  createEditingApp({
    database: world.database(),
    auth: sessionAuth,
    storage: world.storage,
    publicOrigin: DASHBOARD_ORIGIN,
    documentStore: world.documents,
    ...options,
  });

const request = (world: World, method: "GET" | "PUT", body?: unknown) =>
  appOf(world).request(`/api/artifacts/${DOCUMENT_ID}/document`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const save = (world: World, body: Record<string, unknown>) => request(world, "PUT", body);
const read = async (world: World) => (await (await request(world, "GET")).json()) as Record<string, unknown>;

const pinnedResults = (world: World, revisionId: string): unknown[][] => {
  const row = world.revisions.find((revision) => revision.id === revisionId);
  return [[world.artifact], row ? [{ storageKey: row.storageKey, sha256: row.sha256 }] : []];
};

const restore = (world: World, revisionId: string, body?: unknown, results = pinnedResults(world, revisionId)) =>
  appOf(world, { database: world.database(results) }).request(
    `/api/artifacts/${DOCUMENT_ID}/revisions/${revisionId}/restore`,
    { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
  );

test("a person's save appends one operation row and writes no snapshot object", async () => {
  const world = routeWorld();
  const before = await read(world);
  assert.deepEqual(Object.keys(before).sort(), [
    "artifactId",
    "kind",
    "publishedSeq",
    "revisionId",
    "revisionNumber",
    "seq",
    "text",
    "title",
  ]);
  assert.deepEqual([before.seq, before.publishedSeq, before.text], [0, 0, SEEDED], "the read carries its sequence");
  assert.deepEqual(
    [before.artifactId, before.kind, before.revisionId, before.revisionNumber, before.title],
    [DOCUMENT_ID, "markdown", world.artifact.revisionId, 1, "Notes"],
    "the existing read fields keep their values",
  );
  const edited = SEEDED.replace("target text", "target words");
  const response = await save(world, { text: edited, expectedSeq: 0 });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual([body.seq, body.publishedSeq], [1, 0], "the save reports its resulting sequence");
  assert.equal(body.revisionId, world.artifact.revisionId, "an unfrozen save keeps the published revision");
  assert.equal(body.revisionNumber, 1);
  assert.equal(world.operations.length, 1, "one row per accepted save");
  assert.deepEqual(
    (world.operations[0]?.ops ?? []).map((operation) => operation.op),
    ["delete_range", "insert_text"],
    "a one-word change is a range deletion plus an insertion",
  );
  assert.equal(world.revisions.length, 1, "no snapshot is written for an ordinary save");
  assert.equal(world.storage.objects.size, 1, "no new storage object");
  assert.equal(world.draftText(), edited);
  const after = await read(world);
  assert.deepEqual([after.text, after.seq, after.publishedSeq], [edited, 1, 0], "the read serves the draft");
});

test("a stale expectedSeq refuses with concurrent_edit and the current sequence, and the retry lands", async () => {
  const world = routeWorld();
  const accepted = SEEDED.replace("target text", "target words");
  assert.equal((await save(world, { text: accepted, expectedSeq: 0 })).status, 200);
  const response = await save(world, { text: "# Rewritten by a stale client", expectedSeq: 0 });
  assert.equal(response.status, 409);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.error, "concurrent_edit");
  assert.equal(body.currentSeq, 1, "the refusal carries the current sequence");
  assert.equal(body.currentRevisionId, world.artifact.revisionId);
  assert.equal(world.operations.length, 1, "a refused save appends no row");
  assert.equal(world.revisions.length, 1, "a refused save writes no snapshot");
  assert.equal(world.storage.objects.size, 1, "a refused save writes no object");
  assert.equal(world.draftText(), accepted, "the accepted text survives the refusal for the client to retry");
  const retry = await save(world, { text: "# Rewritten by a stale client", expectedSeq: 1 });
  assert.equal(retry.status, 200, "the same text saves once the client catches up");
  assert.equal(world.draftText(), "# Rewritten by a stale client");
  assert.equal(world.operations.length, 2);
});

test("a save that crosses the freeze threshold reports the new revision", async () => {
  const world = routeWorld({ snapshotAgeMs: FREEZE_INTERVAL_MS + 60_000 });
  const publishedBefore = world.artifact.revisionId;
  const response = await save(world, { text: `${SEEDED}\nAppended line`, expectedSeq: 0 });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual([body.seq, body.publishedSeq], [1, 1], "the frozen save reports the published sequence");
  assert.notEqual(body.revisionId, publishedBefore, "the frozen save reports the new revision");
  assert.equal(body.revisionId, world.revisions[1]?.id);
  assert.equal(body.revisionNumber, 2);
  assert.equal(world.revisions.length, 2, "the freeze writes exactly one snapshot");
  assert.equal(world.storage.objects.size, 2, "the snapshot is its own object");
  assert.equal(body.sizeBytes, world.revisions[1]?.sizeBytes);
  assert.equal(body.sha256, world.revisions[1]?.sha256);
});

test("a client that omits expectedSeq on a draftless artifact still gets the whole-revision behaviour", async () => {
  const world = routeWorld();
  const response = await save(world, { text: "# Rewritten whole", expectedRevisionId: world.artifact.revisionId });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["artifactId", "revisionId", "revisionNumber", "sha256", "sizeBytes"]);
  assert.notEqual(body.revisionId, world.artifact.revisionId, "the save creates a whole new revision");
  assert.equal(body.revisionNumber, 2);
  assert.equal(typeof body.sizeBytes, "number");
  assert.equal(world.operations.length, 0, "the old path appends no operation row");
  assert.equal(world.drafts.size, 0, "the old path writes no draft");
  assert.equal(world.storage.objects.size, 2, "the whole document is stored as a new revision object");
});

test("a save with no expectedSeq refuses with sequence_required while the draft has pending operations", async () => {
  const world = routeWorld();
  const accepted = SEEDED.replace("target text", "target words");
  assert.equal((await save(world, { text: accepted, expectedSeq: 0 })).status, 200);
  for (const body of [
    { text: "# From an old client" },
    { text: "# From an old client", expectedRevisionId: world.artifact.revisionId },
  ]) {
    const response = await save(world, body);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "sequence_required",
      currentSeq: 1,
      currentRevisionId: world.artifact.revisionId,
    });
  }
  assert.equal(world.operations.length, 1, "a refused save appends no row");
  assert.equal(world.revisions.length, 1, "a refused save writes no snapshot");
  assert.equal(world.storage.objects.size, 1, "a refused save writes no object");
  assert.equal(world.draftText(), accepted, "the draft a legacy client would have overwritten survives");
  const retry = await save(world, { text: "# From a client that read first", expectedSeq: 1 });
  assert.equal(retry.status, 200, "the same save lands once the client sends the sequence it read");
  assert.equal(((await retry.json()) as Record<string, unknown>).seq, 2, "the save advances the shared sequence");
  assert.equal(world.operations.length, 2, "the accepted save appends one row");
  assert.equal(world.draftText(), "# From a client that read first");
});

test("a non-markdown kind still refuses with wrong_kind", async () => {
  const world = routeWorld({ kind: "html" });
  const response = await save(world, { text: "x", expectedRevisionId: world.artifact.revisionId, expectedSeq: 0 });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "wrong_kind" });
  assert.equal(world.operations.length, 0);
  assert.equal(world.drafts.size, 0);
  assert.equal(world.storage.objects.size, 1);
});

test("a malformed expectedRevisionId keeps the refusal the editor already knew", async () => {
  const world = routeWorld();
  const response = await save(world, { text: "# Text", expectedRevisionId: 7 });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "expected_revision_id_required" });
  assert.equal(world.operations.length, 0);
});

test("a save over the byte cap still refuses with too_large", async () => {
  const world = routeWorld();
  const response = await appOf(world, { maxArtifactBytes: 16 }).request(`/api/artifacts/${DOCUMENT_ID}/document`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ text: "# ".repeat(32), expectedSeq: 0 }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "too_large", maxBytes: 16 });
  assert.equal(world.operations.length, 0, "a refused oversize save appends no row");
});

test("the wire contract refuses a save that names both a sequence and a revision", () => {
  assert.equal(saveDocumentRequestSchema.safeParse({ text: "x" }).success, true);
  assert.equal(saveDocumentRequestSchema.safeParse({ text: "x", expectedSeq: 0 }).success, true);
  assert.equal(saveDocumentRequestSchema.safeParse({ text: "x", expectedRevisionId: "r1" }).success, true);
  assert.equal(
    saveDocumentRequestSchema.safeParse({ text: "x", expectedSeq: 0, expectedRevisionId: "r1" }).success,
    false,
    "the two identities are mutually exclusive on the wire as well",
  );
});

test("a save that names both identities refuses with unexpected_revision_token and writes nothing", async () => {
  const world = routeWorld();
  const both = await save(world, {
    text: "# Both",
    expectedSeq: 0,
    expectedRevisionId: world.artifact.revisionId,
  });
  assert.equal(both.status, 400);
  assert.deepEqual(await both.json(), { error: "unexpected_revision_token" });
  assert.equal(
    (await save(world, { text: `${SEEDED}\nkept`, expectedSeq: 0 })).status,
    200,
    "the sequence alone is the whole identity",
  );
  const again = await save(world, {
    text: "# Both",
    expectedSeq: 1,
    expectedRevisionId: world.artifact.revisionId,
  });
  assert.deepEqual(
    [again.status, ((await again.json()) as Record<string, unknown>).error],
    [400, "unexpected_revision_token"],
    "the refusal does not depend on the draft state",
  );
  assert.equal(world.operations.length, 1, "neither refusal appends an operation row");
  assert.equal(world.draftText(), `${SEEDED}\nkept`, "neither refusal moves the draft");
  assert.equal(world.revisions.length, 1, "neither refusal writes a snapshot");
});

test("a restore refuses with restore_pending_changes instead of destroying an unpublished draft", async () => {
  const world = routeWorld();
  const seeded = world.revisions[0] as { id: string };
  const edited = SEEDED.replace("target text", "target words");
  assert.equal((await save(world, { text: edited, expectedSeq: 0 })).status, 200);
  const response = await restore(world, seeded.id, { expectedRevisionId: world.artifact.revisionId });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "restore_pending_changes",
    currentSeq: 1,
    currentRevisionId: world.artifact.revisionId,
  });
  assert.equal(world.operations.length, 1, "the refusal appends no operation row");
  assert.equal(world.revisions.length, 1, "the refusal writes no snapshot");
  assert.equal(world.storage.objects.size, 1, "the refusal stores no object");
  assert.equal(world.draftText(), edited, "the unpublished edit survives the refusal");
  assert.equal((await read(world)).text, edited, "and is still what the next read serves");
  const caughtUp = await restore(world, seeded.id, { expectedRevisionId: world.artifact.revisionId });
  assert.equal(caughtUp.status, 409, "a retry without publishing refuses again instead of landing");
  const published = await save(world, { text: `${edited}\nmore`, expectedSeq: 1 });
  assert.equal(published.status, 200, "the pending edit is published forward by the sequence path");
});

test("a restore lands one replace operation and publishes the restored revision's bytes", async () => {
  const world = routeWorld();
  const seeded = world.revisions[0] as { id: string; sha256: string };
  assert.equal(world.drafts.size, 0, "the document never kept a draft");
  const response = await restore(world, seeded.id, { expectedRevisionId: world.artifact.revisionId });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(
    [body.restoredFrom, body.revisionNumber, body.seq, body.publishedSeq, body.sha256],
    [seeded.id, 2, 1, 1, seeded.sha256],
    "the restore reports its revision, the pinned digest and the published sequence",
  );
  assert.equal(body.revisionId, world.revisions[1]?.id);
  assert.equal(world.operations.length, 1, "the restore appends exactly one operation row");
  assert.deepEqual(world.operations[0]?.ops, [{ op: "replace_document", text: SEEDED }]);
  assert.equal(world.revisions.length, 2, "the restore writes exactly one snapshot");
  const snapshot = world.revisions[1] as {
    id: string;
    storageKey: string;
    sha256: string;
    seqFrom: number;
    seqTo: number;
  };
  assert.deepEqual([snapshot.seqFrom, snapshot.seqTo], [1, 1], "the snapshot covers the restore operation");
  assert.equal(snapshot.sha256, seeded.sha256, "the published digest is the pinned revision's digest");
  const published = world.storage.objects.get(snapshot.storageKey);
  assert.ok(published, "the snapshot has its own object");
  assert.equal(new TextDecoder().decode(published), SEEDED, "the published bytes are the pinned revision's bytes");
  const after = await read(world);
  assert.deepEqual(
    [after.text, after.seq, after.publishedSeq, after.revisionId],
    [SEEDED, 1, 1, snapshot.id],
    "the next read serves the restored text at the published pointer",
  );
  assert.equal(world.draftText(), SEEDED, "the draft moved with the snapshot");
});

test("a restore over a published draft moves the draft and keeps the edit in history", async () => {
  const world = routeWorld({ snapshotAgeMs: FREEZE_INTERVAL_MS + 60_000 });
  const seeded = world.revisions[0] as { id: string; sha256: string };
  const edited = SEEDED.replace("target text", "target words");
  const saved = await save(world, { text: edited, expectedSeq: 0 });
  assert.equal(saved.status, 200);
  assert.deepEqual(
    [((await saved.json()) as Record<string, unknown>).publishedSeq, world.revisions.length],
    [1, 2],
    "the save froze, so the edit is published and nothing is pending",
  );
  const response = await restore(world, seeded.id, { expectedRevisionId: world.artifact.revisionId });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual([body.seq, body.publishedSeq, body.revisionNumber], [2, 2, 3]);
  assert.equal(world.draftText(), SEEDED, "the draft holds the restored text at the published sequence");
  assert.equal(
    new TextDecoder().decode(world.storage.objects.get((world.revisions[1] as { storageKey: string }).storageKey)),
    edited,
    "the person's published edit stays in history instead of being destroyed",
  );
  const legacy = await save(world, { text: `${SEEDED}\nLater`, expectedRevisionId: world.artifact.revisionId });
  assert.equal(legacy.status, 200, "a clean draft still accepts a legacy client, through the operation path");
  const legacyBody = (await legacy.json()) as Record<string, unknown>;
  assert.equal(legacyBody.seq, 3, "the legacy save advances the sequence instead of moving the pointer behind it");
  assert.equal(world.operations.length, 3, "the legacy save lands as an operation, not as a whole revision");
  assert.equal(world.revisions.length, 3, "the legacy save creates no snapshot of its own");
  const recovered = await save(world, { text: `${SEEDED}\nLater again`, expectedSeq: 3 });
  assert.equal(recovered.status, 200, "the sequence path still lands on the restored document");
});

test("a restore whose pinned object is missing writes no draft row", async () => {
  const world = routeWorld();
  const seeded = world.revisions[0] as { id: string; storageKey: string };
  world.storage.objects.delete(seeded.storageKey);
  const response = await restore(world, seeded.id, { expectedRevisionId: world.artifact.revisionId });
  assert.deepEqual(
    [response.status, ((await response.json()) as Record<string, unknown>).error],
    [500, "artifact_unavailable"],
    "a failed read is not a restore",
  );
  assert.equal(world.drafts.size, 0, "the failed read opens no draft row");
  assert.equal(world.operations.length, 0, "the failed read appends no operation row");
  assert.equal(world.revisions.length, 1, "the failed read writes no snapshot");
  assert.equal(world.storage.objects.size, 0, "the failed read stores no object");
  assert.equal(world.artifact.revisionId, seeded.id, "the pointer did not move");
});

test("the restore refusals keep their codes, statuses and write nothing", async () => {
  const world = routeWorld();
  const seeded = world.revisions[0] as { id: string };
  const cases = [
    [await restore(world, seeded.id, { expectedRevisionId: 7 }), 400, "expected_revision_id_required"],
    [await restore(world, seeded.id, { expectedRevisionId: randomUUID() }), 409, "concurrent_edit"],
    [
      await restore(world, "not-a-revision", { expectedRevisionId: world.artifact.revisionId }),
      404,
      "revision_not_found",
    ],
    [await restore(world, randomUUID(), { expectedRevisionId: world.artifact.revisionId }), 404, "revision_not_found"],
  ] as const;
  for (const [response, status, error] of cases) {
    assert.deepEqual([response.status, ((await response.json()) as Record<string, unknown>).error], [status, error]);
  }
  assert.equal(world.operations.length, 0, "a refused restore appends no row");
  assert.equal(world.revisions.length, 1, "a refused restore writes no snapshot");
  assert.equal(world.drafts.size, 0, "a refused restore opens no draft");
  assert.equal(world.storage.objects.size, 1, "a refused restore writes no object");
  assert.equal(world.artifact.revisionId, seeded.id, "a refused restore leaves the published pointer alone");
});
