import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ARTIFACT_TOOL_NAMES, DOCUMENT_TOOL_NAMES, SCENE_TOOL_NAMES } from "@artiflow/contracts/artifacts";
import { rendersScene } from "@artiflow/domain/kinds";
import { SCENE_FORMAT_VERSION, canonicalScene, type Scene } from "@artiflow/domain/scene";
import { MAX_SCENE_READ_BYTES, MAX_SCENE_READ_NODES } from "@artiflow/mcp-server/constants";
import type {
  McpBackend,
  McpDocumentDraft,
  McpResult,
  McpSceneApplied,
  McpSceneApplyInput,
} from "@artiflow/mcp-server/ports";

import { createArtifactTools } from "../apps/api/src/mcp/artifact-tools.ts";
import { createMcpBackend } from "../apps/api/src/mcp/backend.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import {
  FREEZE_OPERATION_THRESHOLD,
  applyOperationsAndFreeze,
  openDraft,
  type ArtifactDocumentState,
  type DocumentStore,
  type DraftRecord,
  type OperationRecord,
  type SnapshotRecord,
} from "../apps/api/src/domain/documents/service.ts";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const OWNER = "user-1";
const OTHER = "user-2";
const SCOPES = ["artifacts:write", "artifacts:read"];
const ARTIFACT = "artifact-1";
const CAPS = {
  maxArtifactBytes: 16_777_216,
  maxChunkBytes: 1_048_576,
  maxCommentBody: 2000,
  maxCommentQuote: 500,
};
const noopDatabase = {} as unknown as Database;

type ToolPayload = Record<string, unknown>;
type ToolResult = { isError?: boolean; content?: unknown; structuredContent?: unknown };
type Advertised = { name: string; annotations?: { readOnlyHint?: boolean }; _meta?: { ui?: unknown } };

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const rectNode = (id: string): Record<string, unknown> => ({
  id,
  type: "rect",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  fill: "#eeeeee",
});
const textNode = (id: string, body: string, y = 0): Record<string, unknown> => ({
  id,
  type: "text",
  x: 0,
  y,
  w: 100,
  h: 20,
  text: body,
});
const frameOf = (id: string, name: string, nodes: Record<string, unknown>[], x = 0): Record<string, unknown> => ({
  id,
  name,
  x,
  y: 0,
  w: 100,
  h: 100,
  nodes,
});
const sceneOf = (frames: Record<string, unknown>[]): Scene =>
  ({ formatVersion: SCENE_FORMAT_VERSION, frames }) as unknown as Scene;
const canvasText = (frames: Record<string, unknown>[]): string => canonicalScene(sceneOf(frames));

const HOME = (): Record<string, unknown> => frameOf("f1", "Home", [rectNode("n1")], 100);

type FakeRevision = SnapshotRecord & { id: string; revision: number };
type FakeOperation = OperationRecord & { id: string };
type FakeArtifact = {
  ownerId: string;
  kind: string;
  title: string | null;
  publishedSeq: number;
  currentRevisionId: string | null;
  deletedAt: Date | null;
};

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

function canvasWorkspace(seed: { ownerId?: string; kind?: string; text: string }) {
  const storage = fakeStorage();
  const artifacts = new Map<string, FakeArtifact>();
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
      const mine = revisions.filter((row) => row.artifactId === artifactId);
      const current = mine.find((row) => row.id === artifact.currentRevisionId);
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
        if (input.operation) {
          if (operations.some((row) => row.idempotencyKey === input.operation?.idempotencyKey))
            return { committed: false, revisionId: null, revisionNumber: null };
          operations.push({ ...input.operation, id: `op-${operations.length + 1}` });
        }
        const revisionNumber = revisions.filter((row) => row.artifactId === input.revision.artifactId).length + 1;
        const id = `revision-${revisionNumber}`;
        revisions.push({ ...input.revision, id, revision: revisionNumber });
        artifact.publishedSeq = input.revision.seqTo;
        artifact.currentRevisionId = id;
        if (input.draft) drafts.set(input.draft.artifactId, input.draft);
        return { committed: true, revisionId: id, revisionNumber };
      }),
  };

  const bytes = new TextEncoder().encode(seed.text);
  const storageKey = "artifacts/artifact-1-1";
  storage.objects.set(storageKey, bytes);
  revisions.push({
    id: "revision-1",
    revision: 1,
    artifactId: ARTIFACT,
    formatVersion: SCENE_FORMAT_VERSION,
    seqFrom: 0,
    seqTo: 0,
    sizeBytes: bytes.length,
    sha256: digestOf(bytes),
    storageKey,
    blockIndex: null,
    createdAt: NOW,
  });
  artifacts.set(ARTIFACT, {
    ownerId: seed.ownerId ?? OWNER,
    kind: seed.kind ?? "canvas",
    title: "Canvas",
    publishedSeq: 0,
    currentRevisionId: "revision-1",
    deletedAt: null,
  });

  const gate = (ownerId: string, artifactId: string): McpResult<{ kind: string }> => {
    const artifact = artifacts.get(artifactId);
    if (!artifact || artifact.ownerId !== ownerId)
      return { ok: false, kind: "not_found", reason: "artifact_not_visible_to_owner" };
    if (artifact.deletedAt) return { ok: false, kind: "gone", reason: "artifact_deleted" };
    if (!rendersScene(artifact.kind))
      return { ok: false, kind: "wrong_kind", reason: "artifact_is_not_a_canvas", artifactKind: artifact.kind };
    return { ok: true, value: { kind: artifact.kind } };
  };
  const backend: McpBackend = {
    ...createMcpBackend(noopDatabase, {} as never, CAPS),
    selectReadRevision: async (_executor, ownerId: string, artifactId: string) => {
      const artifact = artifacts.get(artifactId);
      if (!artifact || artifact.ownerId !== ownerId) return null;
      const revision = revisions.find((row) => row.id === artifact.currentRevisionId);
      return {
        id: revision?.id ?? null,
        revisionNumber: revision?.revision ?? null,
        storageKey: revision?.storageKey ?? null,
        sha256: revision?.sha256 ?? null,
        sizeBytes: revision?.sizeBytes ?? null,
        deletedAt: artifact.deletedAt,
        kind: artifact.kind,
        title: artifact.title,
      };
    },
    documentDraft: async (ownerId: string, artifactId: string): Promise<McpResult<McpDocumentDraft>> => {
      const described = gate(ownerId, artifactId);
      if (!described.ok) return described;
      const opened = await openDraft({ store, storage, artifactId });
      if (!opened.ok) return { ok: false, kind: opened.kind, reason: opened.reason };
      return {
        ok: true,
        value: { artifactId, kind: described.value.kind, seq: opened.value.seq, text: opened.value.text },
      };
    },
    sceneApply: async (input: McpSceneApplyInput): Promise<McpResult<McpSceneApplied>> => {
      const described = gate(input.ownerId, input.artifactId);
      if (!described.ok) return described;
      const applied = await applyOperationsAndFreeze({
        store,
        storage,
        artifactId: input.artifactId,
        authorKind: input.authorKind,
        authorId: input.authorId,
        baseSeq: input.baseSeq,
        idempotencyKey: input.idempotencyKey,
        ops: input.ops,
        now: NOW,
      });
      if (!applied.ok)
        return {
          ok: false,
          kind: applied.kind,
          reason: applied.reason,
          currentSeq: applied.currentSeq,
          opIndex: applied.opIndex,
        };
      return {
        ok: true,
        value: {
          artifactId: input.artifactId,
          seq: applied.value.seq,
          applied: applied.value.applied,
          replayed: applied.value.replayed,
          published: applied.value.published,
          revisionId: applied.value.revisionId,
          boxes: applied.value.boxes,
          violations: applied.value.violations,
        },
      };
    },
  };
  const sceneOfDraft = (): Scene => (drafts.get(ARTIFACT)?.state as { scene: Scene }).scene;
  return { backend, storage, drafts, operations, revisions, sceneOfDraft };
}

const connect = async (
  backend: McpBackend,
  scopes: string[] = SCOPES,
): Promise<{
  callTool: (name: string, args: ToolPayload) => Promise<ToolResult>;
  names: string[];
  tools: Advertised[];
}> => {
  const server = createArtifactTools({
    backend,
    requireScope: "artifacts:write",
    readScope: "artifacts:read",
  })({ userId: OWNER, scopes });
  const client = new Client({ name: "scene-tools-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  const tools = (await client.listTools()).tools as unknown as Advertised[];
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }) as Promise<ToolResult>,
    names: tools.map((tool) => tool.name),
    tools,
  };
};

const payloadOf = (result: ToolResult): ToolPayload =>
  JSON.parse(((result.content ?? []) as { text?: string }[])[0]?.text ?? "{}") as ToolPayload;
const ok = (result: ToolResult): ToolPayload => {
  assert.equal(result.isError ?? false, false, JSON.stringify(payloadOf(result)));
  return payloadOf(result);
};
const refused = (result: ToolResult, error: string): ToolPayload => {
  assert.equal(result.isError, true, `expected a typed refusal, got ${JSON.stringify(payloadOf(result))}`);
  const payload = payloadOf(result);
  assert.equal(payload.error, error, JSON.stringify(payload));
  return payload;
};

test("scene_outline answers one entry per frame and never a node body", async () => {
  const frames = Array.from({ length: 12 }, (_, index) =>
    frameOf(`frame-${index + 1}`, `Screen ${index + 1}`, [
      rectNode(`node-alpha-${index + 1}`),
      textNode(`text-${index + 1}`, "secret-node-body"),
    ]),
  );
  const { callTool } = await connect(canvasWorkspace({ text: canvasText(frames) }).backend);
  const outline = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  assert.equal(outline.artifactId, ARTIFACT);
  assert.equal(outline.revisionId, "revision-1");
  assert.equal(outline.seq, 0, "the outline names the draft sequence it read");
  assert.equal(outline.formatVersion, SCENE_FORMAT_VERSION);
  assert.equal(outline.frameCount, 12);
  const listed = outline.frames as ToolPayload[];
  assert.equal(listed.length, 12, "twelve frames are twelve entries");
  for (const entry of listed)
    assert.deepEqual(Object.keys(entry).sort(), ["bbox", "id", "name", "nodeCount"], "an entry is a frame header");
  assert.deepEqual(
    listed.map((entry) => entry.id),
    frames.map((frame) => frame.id),
    "the outline keeps the scene order",
  );
  assert.equal(listed[0]?.nodeCount, 2);
  const serialized = JSON.stringify(outline);
  assert.equal(serialized.includes("secret-node-body"), false, "no node body reaches the wire");
  assert.equal(serialized.includes("node-alpha"), false, "no node id reaches the wire");
});

test("scene_outline costs one line per frame on a 200-node scene", async () => {
  const frames = Array.from({ length: 4 }, (_, frameIndex) =>
    frameOf(
      `frame-${frameIndex + 1}`,
      `Screen ${frameIndex + 1}`,
      Array.from({ length: 50 }, (_, nodeIndex) => rectNode(`node-${frameIndex + 1}-${nodeIndex + 1}`)),
      frameIndex * 100,
    ),
  );
  const text = canvasText(frames);
  const { callTool } = await connect(canvasWorkspace({ text }).backend);
  const outline = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  const observedBytes = Buffer.byteLength(JSON.stringify(outline), "utf8");
  assert.equal(
    (outline.frames as ToolPayload[]).reduce((sum, entry) => sum + Number(entry.nodeCount), 0),
    200,
    "the scene really holds two hundred nodes",
  );
  assert.ok(observedBytes < 2048, `the outline of a 200-node scene is ${observedBytes} bytes`);
  assert.ok(
    observedBytes * 10 < Buffer.byteLength(text, "utf8"),
    "the outline is an order of magnitude smaller than the scene document it summarises",
  );
});

test("the acceptance budget: a 200-node scene is inspected without reading it in full", async () => {
  const frames = Array.from({ length: 10 }, (_, frameIndex) =>
    frameOf(
      `frame-${frameIndex + 1}`,
      `Screen ${frameIndex + 1}`,
      Array.from({ length: 20 }, (_, nodeIndex) => rectNode(`node-${frameIndex + 1}-${nodeIndex + 1}`)),
      frameIndex * 100,
    ),
  );
  const text = canvasText(frames);
  const { callTool } = await connect(canvasWorkspace({ text }).backend);
  const outline = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  const read = ok(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "frame-1" }));
  const storedBytes = Buffer.byteLength(text, "utf8");
  const outlineBytes = Buffer.byteLength(JSON.stringify(outline), "utf8");
  const readBytes = Buffer.byteLength(JSON.stringify(read), "utf8");
  const inspectedBytes = outlineBytes + readBytes;
  assert.equal(
    (outline.frames as ToolPayload[]).reduce((sum, entry) => sum + Number(entry.nodeCount), 0),
    200,
    "the scene holds two hundred nodes",
  );
  assert.equal((read.frame as ToolPayload).nodeCount, 20, "one frame, not the whole scene");
  assert.ok(inspectedBytes <= 3072, `outline plus one read costs ${inspectedBytes} bytes, under the 3072 ceiling`);
  assert.ok(
    inspectedBytes * 5 <= storedBytes,
    `${inspectedBytes} inspected bytes stay at least five times below the ${storedBytes} stored bytes`,
  );
});

test("scene_read returns exactly one frame with its own nodes", async () => {
  const frames = [
    frameOf("home", "Home", [rectNode("home-node"), textNode("home-text", "Home body")]),
    frameOf("checkout", "Checkout", [rectNode("checkout-node"), textNode("checkout-text", "Pay now")]),
  ];
  const { callTool } = await connect(canvasWorkspace({ text: canvasText(frames) }).backend);
  const read = ok(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "checkout" }));
  assert.equal(read.artifactId, ARTIFACT);
  assert.equal(read.revisionId, "revision-1");
  assert.equal(read.seq, 0);
  const frame = read.frame as ToolPayload;
  assert.equal(frame.id, "checkout");
  assert.equal(frame.name, "Checkout");
  assert.equal(frame.nodeCount, 2);
  assert.deepEqual(
    (frame.nodes as ToolPayload[]).map((node) => node.id),
    ["checkout-node", "checkout-text"],
    "the frame carries its own nodes and nothing from the sibling frame",
  );
  assert.deepEqual(frame.bbox, { x: 0, y: 0, w: 100, h: 20 });
  assert.equal(JSON.stringify(read).includes("home-node"), false, "the other frame is absent");
});

test("scene_read narrows to the requested nodeIds and refuses an id the frame does not hold", async () => {
  const frames = [
    frameOf("home", "Home", [rectNode("a"), rectNode("b"), rectNode("c")]),
    frameOf("checkout", "Checkout", [rectNode("other")]),
  ];
  const { callTool } = await connect(canvasWorkspace({ text: canvasText(frames) }).backend);
  const narrowed = ok(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "home", nodeIds: ["c", "a"] }));
  const frame = narrowed.frame as ToolPayload;
  assert.deepEqual(
    (frame.nodes as ToolPayload[]).map((node) => node.id),
    ["a", "c"],
    "only the requested nodes come back, in frame order",
  );
  assert.equal(frame.nodeCount, 2);
  const refusedNode = refused(
    await callTool("scene_read", { artifactId: ARTIFACT, frameId: "home", nodeIds: ["a", "missing"] }),
    "unknown_node",
  );
  assert.equal(refusedNode.message, "node_not_in_frame");
  assert.equal(refusedNode.nodeId, "missing");
});

test("scene_read refuses an unknown frame id by name", async () => {
  const { callTool } = await connect(canvasWorkspace({ text: canvasText([frameOf("home", "Home", [])]) }).backend);
  const payload = refused(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "missing" }), "unknown_frame");
  assert.equal(payload.message, "frame_not_in_scene");
  assert.equal(payload.frameId, "missing");
});

test("the scene tools refuse every kind that is not a scene with wrong_kind", async () => {
  const markdown = canvasText([frameOf("home", "Home", [rectNode("a")])]);
  for (const kind of ["markdown", "html"] as const) {
    const { callTool } = await connect(canvasWorkspace({ kind, text: markdown }).backend);
    for (const [name, args] of [
      ["scene_outline", { artifactId: ARTIFACT }],
      ["scene_read", { artifactId: ARTIFACT, frameId: "home" }],
      ["scene_apply", { artifactId: ARTIFACT, baseSeq: 0, idempotencyKey: "k", ops: [{ op: "remove_node", id: "a" }] }],
    ] as [string, ToolPayload][]) {
      const payload = refused(await callTool(name, args), "wrong_kind");
      assert.equal(payload.message, "artifact_is_not_a_canvas", `${name} names its existing reason`);
      assert.equal(payload.kind, kind, `${name} names the refused kind`);
      assert.equal(payload.artifactId, ARTIFACT);
    }
  }
});

test("a deck opens its scene draft, applies one batch and reads it back through scene_outline", async () => {
  const workspace = canvasWorkspace({ kind: "deck", text: canvasText([HOME()]) });
  const { callTool } = await connect(workspace.backend);
  const before = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  assert.equal(before.seq, 0, "the deck opens the same draft a canvas opens");
  assert.equal(before.formatVersion, SCENE_FORMAT_VERSION);
  assert.deepEqual(
    (before.frames as ToolPayload[]).map((entry) => entry.id),
    ["f1"],
    "the deck's slides are its frames, in order",
  );
  const applied = ok(
    await callTool("scene_apply", {
      artifactId: ARTIFACT,
      baseSeq: before.seq,
      idempotencyKey: "deck-1",
      ops: [
        { op: "move_node", id: "n1", x: 40, y: 30 },
        { op: "add_node", frameId: "f1", node: { id: "n2", type: "rect", x: 5, y: 6, w: 7, h: 8, fill: "#0af" } },
      ],
    }),
  );
  assert.equal(applied.seq, 1, "the batch advances the deck draft once");
  assert.equal(applied.applied, 2);
  assert.equal(applied.replayed, false);
  assert.equal(applied.published, false, "one small batch publishes nothing");
  assert.deepEqual(applied.boxes, [
    { id: "n1", frameId: "f1", x: 140, y: 30, w: 10, h: 10 },
    { id: "n2", frameId: "f1", x: 105, y: 6, w: 7, h: 8 },
  ]);
  assert.deepEqual(applied.violations, []);
  const outline = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  assert.equal(outline.seq, 1, "the outline reads the deck draft, not the published snapshot");
  assert.equal((outline.frames as ToolPayload[])[0]?.nodeCount, 2, "the added node is in the deck's slide");
  const read = ok(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "f1" }));
  assert.deepEqual(
    ((read.frame as ToolPayload).nodes as ToolPayload[]).map((node) => node.id),
    ["n1", "n2"],
    "the read shows what the deck accepted",
  );
  assert.equal(workspace.operations.length, 1, "one operation row per accepted deck batch");
  assert.equal(workspace.revisions.length, 1, "below the freeze threshold a deck publishes nothing");
});

test("a deck accepts the replace_scene escape hatch the canvas accepts", async () => {
  const workspace = canvasWorkspace({ kind: "deck", text: canvasText([HOME()]) });
  const { callTool } = await connect(workspace.backend);
  const replacement = [frameOf("slide-2", "Second", [rectNode("n9")]), frameOf("slide-1", "First", [])];
  const applied = ok(
    await callTool("scene_apply", {
      artifactId: ARTIFACT,
      baseSeq: 0,
      idempotencyKey: "deck-restore",
      ops: [{ op: "replace_scene", scene: sceneOf(replacement) }],
    }),
  );
  assert.equal(applied.applied, 1);
  assert.deepEqual(
    applied.boxes,
    [{ id: "n9", frameId: "slide-2", x: 0, y: 0, w: 10, h: 10 }],
    "the escape hatch reports the boxes of the whole new deck",
  );
  const outline = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  assert.deepEqual(
    (outline.frames as ToolPayload[]).map((entry) => entry.id),
    ["slide-2", "slide-1"],
    "the deck keeps the order the replacement named",
  );
});

test("the scene tools refuse an artifact the caller does not own", async () => {
  const { callTool } = await connect(
    canvasWorkspace({ ownerId: OTHER, text: canvasText([frameOf("home", "Home", [])]) }).backend,
  );
  for (const [name, args] of [
    ["scene_outline", { artifactId: ARTIFACT }],
    ["scene_read", { artifactId: ARTIFACT, frameId: "home" }],
    [
      "scene_apply",
      { artifactId: ARTIFACT, baseSeq: 0, idempotencyKey: "k", ops: [{ op: "remove_frame", id: "home" }] },
    ],
  ] as [string, ToolPayload][]) {
    const payload = refused(await callTool(name, args), "not_found");
    assert.equal(payload.message, "artifact_not_visible_to_owner", `${name} reports the ownership gate`);
  }
});

test("the scene tools refuse a canvas whose stored bytes are not a scene", async () => {
  const { callTool } = await connect(canvasWorkspace({ text: "not a scene" }).backend);
  for (const [name, args] of [
    ["scene_outline", { artifactId: ARTIFACT }],
    ["scene_read", { artifactId: ARTIFACT, frameId: "home" }],
  ] as [string, ToolPayload][]) {
    const payload = refused(await callTool(name, args), "invalid_scene");
    assert.equal(payload.message, "malformed_scene", `${name} names the scene refusal`);
  }
});

test("scene_read refuses a frame past the node cap and still serves a narrow read of it", async () => {
  const nodes = Array.from({ length: MAX_SCENE_READ_NODES + 1 }, (_, index) => rectNode(`node-${index + 1}`));
  const { callTool } = await connect(canvasWorkspace({ text: canvasText([frameOf("big", "Big", nodes)]) }).backend);
  const payload = refused(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "big" }), "too_large");
  assert.equal(payload.message, "read_window_exceeds_the_node_cap");
  assert.equal(payload.maxNodes, MAX_SCENE_READ_NODES);
  assert.equal(payload.requestedNodes, MAX_SCENE_READ_NODES + 1);
  const narrowed = ok(
    await callTool("scene_read", { artifactId: ARTIFACT, frameId: "big", nodeIds: ["node-1", "node-2"] }),
  );
  assert.equal((narrowed.frame as ToolPayload).nodeCount, 2, "the cap bounds one read, not the scene");
});

test("scene_read refuses a frame past the byte cap instead of truncating it", async () => {
  const nodes = Array.from({ length: 5 }, (_, index) => textNode(`text-${index + 1}`, "x".repeat(20_000), index * 20));
  const { callTool } = await connect(canvasWorkspace({ text: canvasText([frameOf("heavy", "Heavy", nodes)]) }).backend);
  const payload = refused(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "heavy" }), "too_large");
  assert.equal(payload.message, "read_window_exceeds_the_byte_cap");
  assert.equal(payload.maxBytes, MAX_SCENE_READ_BYTES);
  assert.ok(Number(payload.observedBytes) > MAX_SCENE_READ_BYTES, "the observed size is reported, not hidden");
  const narrowed = ok(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "heavy", nodeIds: ["text-1"] }));
  assert.equal((narrowed.frame as ToolPayload).nodeCount, 1);
});

test("the scene tools are registered as two reads and one writer next to the artifact tools", async () => {
  const { names, tools } = await connect(canvasWorkspace({ text: canvasText([HOME()]) }).backend);
  assert.deepEqual(names.slice().sort(), [...ARTIFACT_TOOL_NAMES].sort());
  assert.deepEqual([...SCENE_TOOL_NAMES], ["scene_outline", "scene_read", "scene_apply"]);
  for (const name of ["scene_outline", "scene_read"] as const) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is advertised`);
    assert.equal(tool?.annotations?.readOnlyHint, true, `${name} reads and says so`);
    assert.equal(tool?._meta?.ui, undefined, `${name} binds no UI resource`);
  }
  const apply = tools.find((candidate) => candidate.name === "scene_apply");
  assert.ok(apply, "scene_apply is advertised");
  assert.equal(apply?.annotations, undefined, "scene_apply writes, so it carries no annotations");
  assert.equal(apply?._meta?.ui, undefined, "scene_apply binds no UI resource");
  for (const name of SCENE_TOOL_NAMES) {
    assert.equal(DOCUMENT_TOOL_NAMES.includes(name as never), false, `${name} is not a document tool`);
    assert.equal(ARTIFACT_TOOL_NAMES.includes(name as never), true, `${name} is on the artifact surface`);
  }
});

test("scene_apply requires the write scope and the scene reads require the read scope", async () => {
  const workspace = canvasWorkspace({ text: canvasText([HOME()]) });
  const writer = await connect(workspace.backend, ["artifacts:write"]);
  for (const [name, args] of [
    ["scene_outline", { artifactId: ARTIFACT }],
    ["scene_read", { artifactId: ARTIFACT, frameId: "f1" }],
  ] as [string, ToolPayload][]) {
    const payload = refused(await writer.callTool(name, args), "insufficient_scope");
    assert.equal(payload.scope, "artifacts:read", `${name} requires the read scope`);
  }
  const reader = await connect(workspace.backend, ["artifacts:read"]);
  const payload = refused(
    await reader.callTool("scene_apply", {
      artifactId: ARTIFACT,
      baseSeq: 0,
      idempotencyKey: "k",
      ops: [{ op: "remove_node", id: "n1" }],
    }),
    "insufficient_scope",
  );
  assert.equal(payload.scope, "artifacts:write", "scene_apply requires the write scope");
});

test("scene_apply applies a batch, answers the boxes and both reads show the change", async () => {
  const workspace = canvasWorkspace({ text: canvasText([HOME()]) });
  const { callTool } = await connect(workspace.backend);
  const before = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  assert.equal(before.seq, 0);
  assert.equal((before.frames as ToolPayload[])[0]?.nodeCount, 1);
  const applied = ok(
    await callTool("scene_apply", {
      artifactId: ARTIFACT,
      baseSeq: before.seq,
      idempotencyKey: "canvas-1",
      ops: [
        { op: "move_node", id: "n1", x: 40, y: 30 },
        { op: "add_node", frameId: "f1", node: { id: "n2", type: "rect", x: 5, y: 6, w: 7, h: 8, fill: "#0af" } },
      ],
    }),
  );
  assert.deepEqual(Object.keys(applied).sort(), [
    "applied",
    "artifactId",
    "baseSeq",
    "boxes",
    "published",
    "replayed",
    "revisionId",
    "seq",
    "violations",
  ]);
  assert.equal(applied.artifactId, ARTIFACT);
  assert.equal(applied.baseSeq, 0);
  assert.equal(applied.seq, 1, "the batch advances the draft sequence once");
  assert.equal(applied.applied, 2, "two operations applied");
  assert.equal(applied.replayed, false);
  assert.equal(applied.published, false);
  assert.equal(applied.revisionId, null);
  assert.deepEqual(applied.boxes, [
    { id: "n1", frameId: "f1", x: 140, y: 30, w: 10, h: 10 },
    { id: "n2", frameId: "f1", x: 105, y: 6, w: 7, h: 8 },
  ]);
  assert.deepEqual(applied.violations, [], "an accepted batch verifies clean");
  assert.equal(workspace.operations.length, 1, "one operation row per accepted batch");
  const outline = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  assert.equal(outline.seq, 1, "the outline reads the draft, not the published snapshot");
  assert.equal((outline.frames as ToolPayload[])[0]?.nodeCount, 2, "the added node is in the outline");
  const read = ok(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "f1" }));
  assert.equal(read.seq, 1, "the read follows the draft too");
  const nodes = (read.frame as ToolPayload).nodes as ToolPayload[];
  assert.deepEqual(
    nodes.map((node) => node.id),
    ["n1", "n2"],
    "the read shows what the batch changed",
  );
  assert.deepEqual([nodes[0]?.x, nodes[0]?.y], [40, 30], "the moved node reads at its new position");
  assert.equal(workspace.revisions.length, 1, "below the freeze threshold nothing is published");
  assert.equal(workspace.storage.objects.size, 1, "no snapshot object without a freeze");
});

test("a stale baseSeq refuses with the current sequence and changes nothing", async () => {
  const workspace = canvasWorkspace({ text: canvasText([HOME()]) });
  const { callTool } = await connect(workspace.backend);
  ok(
    await callTool("scene_apply", {
      artifactId: ARTIFACT,
      baseSeq: 0,
      idempotencyKey: "canvas-1",
      ops: [{ op: "move_node", id: "n1", x: 40, y: 30 }],
    }),
  );
  const sceneBefore = canonicalScene(workspace.sceneOfDraft());
  const stale = refused(
    await callTool("scene_apply", {
      artifactId: ARTIFACT,
      baseSeq: 0,
      idempotencyKey: "canvas-2",
      ops: [{ op: "move_node", id: "n1", x: 0, y: 0 }],
    }),
    "concurrent_edit",
  );
  assert.equal(stale.message, "base_sequence_is_stale");
  assert.equal(stale.currentSeq, 1, "the refusal carries the sequence to rebase on");
  assert.equal(workspace.operations.length, 1, "a refused batch appends no row");
  assert.equal(canonicalScene(workspace.sceneOfDraft()), sceneBefore, "the scene is untouched");
  const outline = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  assert.equal(outline.seq, 1, "the draft sequence did not move");
});

test("an idempotency replay answers once and applies once", async () => {
  const workspace = canvasWorkspace({ text: canvasText([HOME()]) });
  const { callTool } = await connect(workspace.backend);
  const input = {
    artifactId: ARTIFACT,
    baseSeq: 0,
    idempotencyKey: "canvas-same",
    ops: [{ op: "move_node", id: "n1", x: 40, y: 30 }],
  };
  const first = ok(await callTool("scene_apply", input));
  const replay = ok(await callTool("scene_apply", input));
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true, "the replay says it replayed");
  assert.deepEqual(
    [replay.seq, replay.applied, replay.boxes],
    [first.seq, first.applied, []],
    "a replay answers the recorded sequence and applies nothing new",
  );
  assert.equal(workspace.operations.length, 1, "the replay adds no row");
  assert.deepEqual(
    workspace.sceneOfDraft().frames[0]?.nodes[0],
    { id: "n1", type: "rect", x: 40, y: 30, w: 10, h: 10, fill: "#eeeeee" },
    "the scene is applied exactly once",
  );
});

test("a batch whose second operation fails names the index and leaves the scene byte-identical", async () => {
  const workspace = canvasWorkspace({ text: canvasText([HOME()]) });
  const { callTool } = await connect(workspace.backend);
  ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  const sceneBefore = canonicalScene(workspace.sceneOfDraft());
  const rejected = refused(
    await callTool("scene_apply", {
      artifactId: ARTIFACT,
      baseSeq: 0,
      idempotencyKey: "canvas-rejected",
      ops: [
        { op: "move_node", id: "n1", x: 40, y: 30 },
        { op: "move_node", id: "n1", x: 500, y: 0 },
      ],
    }),
    "invalid_operation",
  );
  assert.equal(rejected.message, "outside_frame_bounds", "the engine reason reaches the caller");
  assert.equal(rejected.opIndex, 1, "the failing index is named");
  assert.equal(rejected.currentSeq, 0, "the sequence the caller should retry from is named");
  assert.equal(canonicalScene(workspace.sceneOfDraft()), sceneBefore, "the first operation was rolled back");
  const outline = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  assert.equal(outline.seq, 0, "a refused batch does not advance the draft");
  assert.equal(workspace.revisions.length, 1, "a refused batch publishes nothing");
});

test("crossing the freeze threshold publishes and the outline still reads the draft", async () => {
  const workspace = canvasWorkspace({ text: canvasText([HOME()]) });
  const { callTool } = await connect(workspace.backend);
  let seq = 0;
  const published: boolean[] = [];
  for (let index = 1; index <= FREEZE_OPERATION_THRESHOLD; index += 1) {
    const applied = ok(
      await callTool("scene_apply", {
        artifactId: ARTIFACT,
        baseSeq: seq,
        idempotencyKey: `canvas-${index}`,
        ops: [{ op: "move_node", id: "n1", x: index % 80, y: 0 }],
      }),
    );
    seq = Number(applied.seq);
    published.push(applied.published === true);
    if (applied.published !== true) assert.equal(applied.revisionId, null);
  }
  assert.deepEqual([...new Set(published.slice(0, FREEZE_OPERATION_THRESHOLD - 1))], [false], "nothing freezes below");
  assert.equal(published[FREEZE_OPERATION_THRESHOLD - 1], true, "the operation that crosses the threshold freezes");
  assert.equal(workspace.revisions.length, 2, "one extra snapshot covers the batch history");
  const outline = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  assert.equal(outline.revisionId, "revision-2", "the outline names the revision the freeze published");
  assert.equal(outline.seq, FREEZE_OPERATION_THRESHOLD, "and still reads the draft sequence");
  const read = ok(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "f1" }));
  const nodes = (read.frame as ToolPayload).nodes as ToolPayload[];
  assert.equal(nodes[0]?.x, FREEZE_OPERATION_THRESHOLD % 80, "the read sees the last edit made after the freeze");
});
