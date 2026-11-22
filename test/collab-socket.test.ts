import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import OriginWebSocket from "ws";

import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import {
  applyOperations,
  type ArtifactDocumentState,
  type DocumentStore,
  type DraftRecord,
  type OperationRecord,
  type SnapshotRecord,
} from "../apps/api/src/domain/documents/service.ts";
import {
  COLLAB_MARKDOWN_FIELD,
  attachRoomsToDocumentWrites,
  createRooms,
  type Rooms,
} from "../apps/api/src/collab/rooms.ts";
import { attachCollabServer, documentAuthorizer, type CollabAuthorizer } from "../apps/api/src/collab/socket.ts";

const NOW = new Date("2026-11-22T09:00:00.000Z");
const START = "# Start\n\nopening";
const AGENT = "# Start\n\nan agent wrote this";

type FakeRevision = SnapshotRecord & { id: string; revision: number };
type FakeOperation = OperationRecord & { id: string };

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

function fakeStorage(): Storage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const providerError = (status: number): Error =>
    Object.assign(new Error(`provider ${status}`), { $metadata: { httpStatusCode: status } });
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

function fakeStore(seed: { artifactId: string; publishedSeq?: number } = { artifactId: "a1" }) {
  const artifacts = new Map<string, { publishedSeq: number; currentRevisionId: string | null; kind: string }>();
  const drafts = new Map<string, DraftRecord>();
  const operations: FakeOperation[] = [];
  const revisions: FakeRevision[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const store: DocumentStore = {
    async readArtifact(artifactId: string): Promise<ArtifactDocumentState | null> {
      const artifact = artifacts.get(artifactId);
      if (!artifact) return null;
      const mine = revisions.filter((revision) => revision.artifactId === artifactId);
      const current = mine.find((revision) => revision.id === artifact.currentRevisionId);
      return {
        artifactId,
        kind: artifact.kind,
        publishedSeq: artifact.publishedSeq,
        currentRevisionId: artifact.currentRevisionId,
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
    async readDraft(artifactId: string): Promise<DraftRecord | null> {
      return drafts.get(artifactId) ?? null;
    },
    async insertDraftIfAbsent(record: DraftRecord): Promise<DraftRecord> {
      if (!drafts.has(record.artifactId)) drafts.set(record.artifactId, record);
      return drafts.get(record.artifactId) as DraftRecord;
    },
    async readOperation(artifactId: string, idempotencyKey: string): Promise<OperationRecord | null> {
      return operations.find((row) => row.artifactId === artifactId && row.idempotencyKey === idempotencyKey) ?? null;
    },
    async readSnapshotAtOrBefore(artifactId: string, seq: number) {
      const candidates = revisions
        .filter((row) => row.artifactId === artifactId && row.seqTo <= seq)
        .sort((left, right) => right.seqTo - left.seqTo || right.revision - left.revision);
      const row = candidates[0];
      return row
        ? { seqTo: row.seqTo, storageKey: row.storageKey, sha256: row.sha256, formatVersion: row.formatVersion }
        : null;
    },
    async readAppliedOperations(artifactId: string, afterSeq: number, toSeq: number): Promise<OperationRecord[]> {
      return operations
        .filter((row) => row.artifactId === artifactId && row.result === "applied")
        .filter((row) => row.seq > afterSeq && row.seq <= toSeq)
        .sort((left, right) => left.seq - right.seq);
    },
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
        const artifact = artifacts.get(input.revision.artifactId);
        if (!artifact) return { committed: false, revisionId: null, revisionNumber: null };
        if (
          artifact.publishedSeq !== input.expectedPublishedSeq ||
          (drafts.get(input.revision.artifactId)?.seq ?? artifact.publishedSeq) !== input.expectedDraftSeq
        )
          return { committed: false, revisionId: null, revisionNumber: null };
        const revisionNumber = revisions.filter((row) => row.artifactId === input.revision.artifactId).length + 1;
        const id = `revision-${revisionNumber}`;
        revisions.push({ ...input.revision, id, revision: revisionNumber });
        artifact.publishedSeq = input.revision.seqTo;
        artifact.currentRevisionId = id;
        return { committed: true, revisionId: id, revisionNumber };
      }),
  };
  artifacts.set(seed.artifactId, {
    publishedSeq: seed.publishedSeq ?? 0,
    currentRevisionId: null,
    kind: "markdown",
  });
  return {
    store,
    drafts,
    operations,
    revisions,
    seedSnapshot: (storage: Storage & { objects: Map<string, Uint8Array> }, text: string): void => {
      const artifactId = seed.artifactId;
      const bytes = new TextEncoder().encode(text);
      const storageKey = `artifacts/revision-${revisions.length + 1}`;
      storage.objects.set(storageKey, bytes);
      const artifact = artifacts.get(artifactId) as {
        publishedSeq: number;
        currentRevisionId: string | null;
        kind: string;
      };
      const id = `revision-${revisions.length + 1}`;
      revisions.push({
        id,
        revision: revisions.length + 1,
        artifactId,
        formatVersion: 1,
        seqFrom: 0,
        seqTo: artifact.publishedSeq,
        sizeBytes: bytes.length,
        sha256: digestOf(text),
        storageKey,
        blockIndex: null,
        createdAt: NOW,
      });
      artifact.currentRevisionId = id;
    },
  };
}

const SESSION_COOKIE = "artiflow.session_token";
const ACCESS = new Map<string, { access: string; kind: string }>([
  ["person-1:a1", { access: "owner", kind: "markdown" }],
  ["person-2:a1", { access: "editor", kind: "markdown" }],
  ["person-3:a1", { access: "reader", kind: "markdown" }],
  ["person-4:a1", { access: "owner", kind: "html" }],
]);

const authorizer: CollabAuthorizer = documentAuthorizer({
  sessionUserId: async (headers: Headers): Promise<string | null> => {
    const cookie = headers.get("cookie") ?? "";
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie);
    return match?.[1] ?? null;
  },
  documentAccess: async (userId: string, artifactId: string) => ACCESS.get(`${userId}:${artifactId}`) ?? null,
});

async function waitFor(check: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function socketFor(cookie: string): typeof OriginWebSocket {
  return class extends OriginWebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    }
  } as unknown as typeof OriginWebSocket;
}

type Harness = {
  baseUrl: string;
  rooms: Rooms;
  close: () => Promise<void>;
};

async function startHarness(rooms: Rooms): Promise<Harness> {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const collab = attachCollabServer({ server, rooms, authorize: authorizer });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `ws://127.0.0.1:${port}/api/collab`,
    rooms,
    close: async (): Promise<void> => {
      await collab.close();
      await rooms.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function collabFor(seeded: ReturnType<typeof fakeStore>, storage: Storage) {
  return createRooms({ store: seeded.store, storage, debounceMs: 25, log: (): void => undefined });
}

type Refusal = { code: number | null; reason: string; messages: number };

async function refusalOf(url: string, cookie: string | null): Promise<Refusal> {
  const socket =
    cookie === null
      ? new OriginWebSocket(url)
      : new OriginWebSocket(url, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
  const messages: unknown[] = [];
  let code: number | null = null;
  let reason = "";
  socket.on("message", (data) => messages.push(data));
  socket.on("close", (closed: number, why: Buffer) => {
    code = closed;
    reason = why.toString("utf8");
  });
  socket.on("error", () => undefined);
  await waitFor(() => code !== null, `the socket to close (${cookie ?? "no cookie"})`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return { code, reason, messages: messages.length };
}

test("two clients join the same document, load its draft and converge on an update", async () => {
  const seeded = fakeStore({ artifactId: "a1", publishedSeq: 2 });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, START);
  const rooms = collabFor(seeded, storage);
  const harness = await startHarness(rooms);
  const first = new Y.Doc();
  const second = new Y.Doc();
  const firstProvider = new WebsocketProvider(harness.baseUrl, "a1", first, {
    disableBc: true,
    WebSocketPolyfill: socketFor("person-1") as never,
  });
  const secondProvider = new WebsocketProvider(harness.baseUrl, "a1", second, {
    disableBc: true,
    WebSocketPolyfill: socketFor("person-2") as never,
  });
  try {
    await waitFor(() => firstProvider.synced, "the first client to sync");
    await waitFor(() => secondProvider.synced, "the second client to sync");
    assert.equal(first.getText(COLLAB_MARKDOWN_FIELD).toString(), START, "the room loads the draft text");
    assert.equal(second.getText(COLLAB_MARKDOWN_FIELD).toString(), START);
    assert.equal(rooms.size(), 1, "both clients share one room");
    first.getText(COLLAB_MARKDOWN_FIELD).insert(START.length, "\n\nwritten by the first client");
    await waitFor(
      () => second.getText(COLLAB_MARKDOWN_FIELD).toString().includes("written by the first client"),
      "the update to reach the second client",
    );
    second.getText(COLLAB_MARKDOWN_FIELD).insert(0, "reply\n");
    await waitFor(
      () => first.getText(COLLAB_MARKDOWN_FIELD).toString().startsWith("reply\n"),
      "the update to reach the first client",
    );
  } finally {
    firstProvider.destroy();
    secondProvider.destroy();
    first.destroy();
    second.destroy();
    await harness.close();
  }
});

test("an unauthorized, foreign or read-only socket is closed with a policy code and receives no document", async () => {
  const seeded = fakeStore({ artifactId: "a1", publishedSeq: 2 });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, START);
  const rooms = collabFor(seeded, storage);
  const harness = await startHarness(rooms);
  const url = `${harness.baseUrl}/a1`;
  try {
    assert.deepEqual(await refusalOf(url, null), { code: 4401, reason: "unauthorized", messages: 0 });
    assert.deepEqual(await refusalOf(url, "person-9"), { code: 4404, reason: "not_found", messages: 0 });
    assert.deepEqual(await refusalOf(url, "person-3"), { code: 4403, reason: "forbidden", messages: 0 });
    assert.deepEqual(await refusalOf(url, "person-4"), { code: 4403, reason: "not_a_document", messages: 0 });
    assert.equal(rooms.size(), 0, "a refused socket opens no room");
  } finally {
    await harness.close();
  }
});

test("an agent write reaches the room and its connected clients after invalidation", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const rooms = collabFor(seeded, storage);
  const detach = attachRoomsToDocumentWrites(rooms);
  const harness = await startHarness(rooms);
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(harness.baseUrl, "a1", doc, {
    disableBc: true,
    WebSocketPolyfill: socketFor("person-1") as never,
  });
  try {
    await waitFor(() => provider.synced, "the human client to sync");
    doc.getText(COLLAB_MARKDOWN_FIELD).insert(0, "typed before the agent\n");
    await waitFor(() => seeded.operations.length === 1, "the human edit to flush");
    const applied = await applyOperations({
      store: seeded.store,
      storage,
      artifactId: "a1",
      authorKind: "agent",
      authorId: "agent-1",
      baseSeq: 1,
      idempotencyKey: "agent-key-1",
      ops: [{ op: "replace_document", text: AGENT }],
      now: NOW,
    });
    assert.equal(applied.ok, true, applied.ok ? "" : applied.reason);
    await waitFor(() => doc.getText(COLLAB_MARKDOWN_FIELD).toString() === AGENT, "the agent text to reach the client");
  } finally {
    detach();
    provider.destroy();
    doc.destroy();
    await harness.close();
  }
});

test("a human flush that landed first makes the racing agent write refuse instead of merging", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const rooms = collabFor(seeded, storage);
  const harness = await startHarness(rooms);
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(harness.baseUrl, "a1", doc, {
    disableBc: true,
    WebSocketPolyfill: socketFor("person-1") as never,
  });
  try {
    await waitFor(() => provider.synced, "the human client to sync");
    doc.getText(COLLAB_MARKDOWN_FIELD).insert(0, "the human wrote first\n");
    await waitFor(() => seeded.operations.length === 1, "the human edit to flush");
    const refused = await applyOperations({
      store: seeded.store,
      storage,
      artifactId: "a1",
      authorKind: "agent",
      authorId: "agent-1",
      baseSeq: 0,
      idempotencyKey: "agent-key-1",
      ops: [{ op: "replace_document", text: AGENT }],
      now: NOW,
    });
    assert.equal(refused.ok, false, "the agent's base sequence is stale");
    if (refused.ok) return;
    assert.equal(refused.kind, "concurrent_edit");
    assert.equal(refused.currentSeq, 1);
    assert.equal(seeded.operations.length, 1, "the refused agent write appends no row");
  } finally {
    provider.destroy();
    doc.destroy();
    await harness.close();
  }
});
