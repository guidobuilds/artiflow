import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hono } from "hono";

import {
  McpRollback,
  type McpBackend,
  type McpCommentDocument,
  type McpCommentInsert,
  type McpCommentRow,
} from "@artiflow/mcp-server/ports";
import { SCENE_FORMAT_VERSION, canonicalScene, type Scene } from "@artiflow/domain/scene";

import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import {
  artifactComments,
  artifactRevisions,
  artifacts,
  artifactShares,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import {
  applyOperations,
  openDraft,
  type ArtifactDocumentState,
  type DocumentStore,
  type DraftRecord,
  type OperationRecord,
  type SnapshotRecord,
} from "../apps/api/src/domain/documents/service.ts";
import { createArtifactTools } from "../apps/api/src/mcp/artifact-tools.ts";
import { createCommentsApp } from "../apps/api/src/routes/comments.ts";
import { renderSceneDocument } from "../apps/api/src/viewer/scene.ts";

const CANVAS_ID = "11111111-1111-4111-8111-111111111111";
const HTML_ID = "22222222-2222-4222-8222-222222222222";
const MARKDOWN_ID = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-21T12:00:00.000Z");
const PRINCIPAL = JSON.stringify({ userId: OWNER, scopes: [] });

const FRAME = "frame-home";
const OTHER_FRAME = "frame-away";
const LIVE = "node-live";
const ELSEWHERE = "node-elsewhere";
const ADDED = "node-added";

const SCENE: Scene = {
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: FRAME,
      name: "Home",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      nodes: [{ id: LIVE, type: "rect", x: 40, y: 20, w: 100, h: 60, fill: "#ffffff" }],
    },
    {
      id: OTHER_FRAME,
      name: "Away",
      x: 400,
      y: 0,
      w: 200,
      h: 200,
      nodes: [{ id: ELSEWHERE, type: "rect", x: 10, y: 10, w: 50, h: 50, fill: "#000000" }],
    },
  ],
};

const MARKDOWN = "# Hello world\n\nThe anchored sentence.\n";
const ANCHOR = { kind: "board-point", boardId: FRAME, nodeId: LIVE, x: 0.25, y: 0.5 };

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const providerError = (status: number): Error =>
  Object.assign(new Error(`provider ${status}`), { $metadata: { httpStatusCode: status } });

type FakeStorage = Storage & { objects: Map<string, Uint8Array> };

function fakeStorage(): FakeStorage {
  const objects = new Map<string, Uint8Array>();
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const name = command.constructor.name;
      const key = String(command.input.Key ?? "");
      const stored = objects.get(key);
      if (name === "HeadObjectCommand") {
        if (!stored) throw providerError(404);
        return { ContentLength: stored.length };
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

function workspace(input: { text: string; kind: string; formatVersion?: number }) {
  const storage = fakeStorage();
  const bytes = new TextEncoder().encode(input.text);
  const storageKey = newRevisionStorageKey();
  storage.objects.set(storageKey, bytes);
  const revision: SnapshotRecord & { id: string; revision: number } = {
    id: "revision-1",
    revision: 1,
    artifactId: "artifact-one",
    formatVersion: input.formatVersion ?? 1,
    seqFrom: 0,
    seqTo: 1,
    sizeBytes: bytes.length,
    sha256: digestOf(bytes),
    storageKey,
    blockIndex: null,
    createdAt: NOW,
  };
  const drafts = new Map<string, DraftRecord>();
  const operations: OperationRecord[] = [];
  const store: DocumentStore = {
    readArtifact: async (): Promise<ArtifactDocumentState> => ({
      artifactId: "artifact-one",
      kind: input.kind,
      publishedSeq: 1,
      currentRevisionId: revision.id,
      revisionCount: 1,
      latestSnapshot: {
        storageKey,
        sha256: revision.sha256,
        formatVersion: revision.formatVersion,
        createdAt: NOW,
      },
    }),
    readDraft: async (artifactId: string): Promise<DraftRecord | null> => drafts.get(artifactId) ?? null,
    insertDraftIfAbsent: async (record: DraftRecord): Promise<DraftRecord> => {
      if (!drafts.has(record.artifactId)) drafts.set(record.artifactId, record);
      return drafts.get(record.artifactId) as DraftRecord;
    },
    readOperation: async (_artifactId: string, idempotencyKey: string): Promise<OperationRecord | null> =>
      operations.find((row) => row.idempotencyKey === idempotencyKey) ?? null,
    readSnapshotAtOrBefore: async () => null,
    readAppliedOperations: async (): Promise<OperationRecord[]> => [],
    commitOperation: async ({ operation, draft }): Promise<{ committed: boolean }> => {
      operations.push(operation);
      if (draft) drafts.set(draft.artifactId, draft);
      return { committed: true };
    },
    commitSnapshot: async () => ({ committed: false, revisionId: null, revisionNumber: null }),
  };
  return { store, storage, revision, drafts, operations };
}

type CanvasWorld = { store: ReturnType<typeof workspace>; id: string; kind: string };

const canvasWorld = (): CanvasWorld => ({
  store: workspace({ kind: "canvas", text: canonicalScene(SCENE) }),
  id: CANVAS_ID,
  kind: "canvas",
});

type CommentRecord = McpCommentRow & { artifactId: string };

type CommentWorld = {
  doc: McpCommentDocument;
  revision: { id: string; storageKey: string; sha256: string };
  comments: CommentRecord[];
};

function commentWorld(
  kind: string,
  id: string,
  revision: { id: string; storageKey: string; sha256: string },
): CommentWorld {
  return {
    doc: { id, kind, ownerId: OWNER, access: "owner", deletedAt: null },
    revision: { id: revision.id, storageKey: revision.storageKey, sha256: revision.sha256 },
    comments: [],
  };
}

type SelectChain = Promise<unknown[]> & {
  leftJoin: (joined: unknown) => SelectChain;
  innerJoin: (joined: unknown) => SelectChain;
  where: () => SelectChain;
  orderBy: () => SelectChain;
  limit: () => SelectChain;
  for: () => SelectChain;
  $dynamic: () => SelectChain;
};

function commentsDatabase(world: CommentWorld): Database {
  const select = () => ({
    from: (table: unknown) => {
      const joins = new Set<unknown>();
      const read = (): unknown[] => {
        if (table === artifacts && joins.has(artifactShares)) return [{ ...world.doc }];
        if (table === artifacts && joins.has(artifactRevisions)) return [{ ...world.revision }];
        if (table === artifactComments) return [...world.comments];
        return [];
      };
      const node: SelectChain = Object.assign(Promise.resolve().then(read), {
        leftJoin: (joined: unknown) => {
          joins.add(joined);
          return node;
        },
        innerJoin: (joined: unknown) => {
          joins.add(joined);
          return node;
        },
        where: () => node,
        orderBy: () => node,
        limit: () => node,
        for: () => node,
        $dynamic: () => node,
      });
      return node;
    },
  });
  const insert = () => ({
    values: (values: McpCommentInsert & { revisionId: string | null }) => ({
      returning: (): Promise<unknown[]> => {
        const id = `comment-${world.comments.length + 1}`;
        world.comments.push({
          id,
          authorId: values.authorId,
          authorName: null,
          authorImage: null,
          anchor: values.anchor,
          body: values.body,
          parentId: values.parentId,
          resolvedAt: null,
          createdAt: NOW,
          artifactId: values.artifactId,
        });
        return Promise.resolve([{ id }]);
      },
    }),
  });
  const db = {
    select,
    insert,
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return db as unknown as Database;
}

const commentsApp = (world: CanvasWorld, state: CommentWorld) => {
  const app = new Hono();
  app.route(
    "/",
    createCommentsApp({
      database: { db: commentsDatabase(state) } as unknown as Database,
      auth: {} as never,
      storage: world.store.storage,
      publicOrigin: "https://app.test",
      principal: true,
      documentStore: world.store.store,
    }),
  );
  return app;
};

const pathOf = (id: string) => `/api/artifacts/${id}/comments`;
const call = (app: Hono, id: string, method: "GET" | "POST", body?: unknown): Promise<Response> =>
  Promise.resolve(
    app.request(pathOf(id), {
      method,
      headers: { "x-artiflow-principal": PRINCIPAL, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

type ThreadPayload = {
  anchor: unknown;
  body: string;
  orphaned?: boolean;
  replies: unknown[];
};

const listed = async (app: Hono, id: string): Promise<{ canComment: boolean; comments: ThreadPayload[] }> => {
  const response = await call(app, id, "GET");
  assert.equal(response.status, 200, "the comment list answers");
  return (await response.json()) as { canComment: boolean; comments: ThreadPayload[] };
};

const anchorOf = (overrides: Record<string, unknown> = {}) => ({ ...ANCHOR, ...overrides });

test("a board-point anchor names its node and reads back unchanged", async () => {
  const world = canvasWorld();
  const app = commentsApp(world, commentWorld("canvas", CANVAS_ID, world.store.revision));
  const created = await call(app, CANVAS_ID, "POST", {
    anchor: ANCHOR,
    body: "A pin on the live node",
    expectedRevisionId: world.store.revision.id,
  });
  assert.equal(created.status, 201, await created.text());
  const body = await listed(app, CANVAS_ID);
  assert.equal(body.canComment, true);
  assert.deepEqual(body.comments[0]?.anchor, ANCHOR, "the normalized point and its node survive the round trip");
  assert.equal(body.comments[0]?.orphaned, false, "a node the current scene holds is not orphaned");
});

test("a point outside its node, a blank nodeId and a non-finite coordinate refuse by name", async () => {
  const world = canvasWorld();
  const state = commentWorld("canvas", CANVAS_ID, world.store.revision);
  const app = commentsApp(world, state);
  for (const anchor of [
    anchorOf({ x: 1.5 }),
    anchorOf({ y: -0.1 }),
    anchorOf({ x: null }),
    anchorOf({ nodeId: "" }),
    anchorOf({ boardId: "" }),
  ]) {
    const response = await call(app, CANVAS_ID, "POST", { anchor, body: "Refused" });
    assert.equal(response.status, 400, `${JSON.stringify(anchor)} refuses`);
    assert.deepEqual(await response.json(), { error: "invalid_anchor" }, `${JSON.stringify(anchor)} names its reason`);
  }
  assert.deepEqual(state.comments, [], "a refused anchor writes no row");
});

test("an unknown node, and a frame that does not contain it, refuse by name and write nothing", async () => {
  const world = canvasWorld();
  const state = commentWorld("canvas", CANVAS_ID, world.store.revision);
  const app = commentsApp(world, state);
  for (const anchor of [
    anchorOf({ nodeId: "node-unknown" }),
    anchorOf({ nodeId: ELSEWHERE }),
    anchorOf({ nodeId: "   " }),
  ]) {
    const response = await call(app, CANVAS_ID, "POST", { anchor, body: "Refused" });
    assert.equal(response.status, 400, `${JSON.stringify(anchor)} refuses`);
    assert.deepEqual(await response.json(), { error: "unknown_node" }, `${JSON.stringify(anchor)} names its reason`);
  }
  assert.deepEqual(state.comments, [], "an anchor that points nowhere writes no row");
  assert.deepEqual((await listed(app, CANVAS_ID)).comments, [], "and the thread is not stored");
});

test("the anchor resolves against the draft, not the published snapshot", async () => {
  const world = canvasWorld();
  const state = commentWorld("canvas", CANVAS_ID, world.store.revision);
  const app = commentsApp(world, state);
  const added = await applyOperations({
    store: world.store.store,
    storage: world.store.storage,
    artifactId: CANVAS_ID,
    authorKind: "person",
    authorId: OWNER,
    baseSeq: 1,
    idempotencyKey: "add-node",
    ops: [
      {
        op: "add_node",
        frameId: FRAME,
        node: { id: ADDED, type: "rect", x: 200, y: 100, w: 40, h: 40, fill: "#ff0000" },
      },
    ],
  });
  assert.equal(added.ok, true, "the node is added through the scene service");
  const created = await call(app, CANVAS_ID, "POST", {
    anchor: anchorOf({ nodeId: ADDED }),
    body: "Draft node",
    expectedRevisionId: world.store.revision.id,
  });
  assert.equal(created.status, 201, "a node the draft holds is a valid target");
  const body = await listed(app, CANVAS_ID);
  assert.equal(body.comments[0]?.orphaned, false);
});

test("a node an operation removed leaves its thread orphaned, not hidden", async () => {
  const world = canvasWorld();
  const state = commentWorld("canvas", CANVAS_ID, world.store.revision);
  const app = commentsApp(world, state);
  const created = await call(app, CANVAS_ID, "POST", {
    anchor: ANCHOR,
    body: "A pin",
    expectedRevisionId: world.store.revision.id,
  });
  assert.equal(created.status, 201, await created.text());
  assert.equal((await listed(app, CANVAS_ID)).comments[0]?.orphaned, false, "the live node is not orphaned");
  const removed = await applyOperations({
    store: world.store.store,
    storage: world.store.storage,
    artifactId: CANVAS_ID,
    authorKind: "person",
    authorId: OWNER,
    baseSeq: 1,
    idempotencyKey: "remove-live",
    ops: [{ op: "remove_node", id: LIVE }],
  });
  assert.equal(removed.ok, true, "the node is removed through the scene service");
  const body = await listed(app, CANVAS_ID);
  assert.equal(body.comments[0]?.orphaned, true, "the thread says its node is gone");
  assert.deepEqual(body.comments[0]?.anchor, ANCHOR, "the anchor is reported unchanged instead of hidden");
});

const pinPosition = (document: string): { left: number; top: number } | null => {
  const found = /class="scene-pin"[^>]*style="left:(-?[\d.]+)px;top:(-?[\d.]+)px"/.exec(document);
  return found === null ? null : { left: Number(found[1]), top: Number(found[2]) };
};

const draftScene = async (world: ReturnType<typeof workspace>) => {
  const opened = await openDraft({ store: world.store, storage: world.storage, artifactId: CANVAS_ID });
  assert.equal(opened.ok, true, "the canvas draft opens");
  if (!opened.ok) throw new Error("the canvas draft must open");
  const scene = opened.value.scene;
  assert.ok(scene !== null, "the canvas draft carries a scene");
  return scene;
};

test("a pin follows the node move_node moved, and vanishes when the node is gone", async () => {
  const world = canvasWorld();
  const thread = { id: "comment-one", anchor: ANCHOR };
  const start = pinPosition(renderSceneDocument(await draftScene(world.store), undefined, undefined, [thread]));
  assert.deepEqual(start, { left: 65, top: 50 }, "40 + 0.25*100 and 20 + 0.5*60");

  const moved = await applyOperations({
    store: world.store.store,
    storage: world.store.storage,
    artifactId: CANVAS_ID,
    authorKind: "person",
    authorId: OWNER,
    baseSeq: 1,
    idempotencyKey: "move-live",
    ops: [{ op: "move_node", id: LIVE, x: 140, y: 90 }],
  });
  assert.equal(moved.ok, true, "the node moves through the scene service");
  const end = pinPosition(renderSceneDocument(await draftScene(world.store), undefined, undefined, [thread]));
  assert.deepEqual(end, { left: 165, top: 120 }, "140 + 0.25*100 and 90 + 0.5*60");
  assert.notDeepEqual(end, start, "both numbers moved with the node");

  const removed = await applyOperations({
    store: world.store.store,
    storage: world.store.storage,
    artifactId: CANVAS_ID,
    authorKind: "person",
    authorId: OWNER,
    baseSeq: 2,
    idempotencyKey: "remove-live",
    ops: [{ op: "remove_node", id: LIVE }],
  });
  assert.equal(removed.ok, true, "the node is removed through the scene service");
  const document = renderSceneDocument(await draftScene(world.store), undefined, undefined, [thread]);
  assert.equal(pinPosition(document), null, "no pin is drawn at a stale position");
  assert.ok(document.includes("Thread 1 points at something that no longer exists in this canvas."), document);
});

test("html element anchors and markdown text ranges keep their existing payloads", async () => {
  const html = workspace({ kind: "html", text: "<p>Static</p>" });
  const htmlState = commentWorld("html", HTML_ID, html.revision);
  htmlState.comments.push({
    id: "comment-one",
    authorId: OWNER,
    authorName: "Ann",
    authorImage: null,
    anchor: { kind: "element", selector: "p", point: { x: 0.5, y: 0.5 }, textHint: "Static", viewportWidth: 800 },
    body: "Element note",
    parentId: null,
    resolvedAt: null,
    createdAt: NOW,
    artifactId: HTML_ID,
  });
  const htmlApp = commentsApp({ store: html, id: HTML_ID, kind: "html" }, htmlState);
  const pinned = (await listed(htmlApp, HTML_ID)).comments[0];
  assert.deepEqual(
    Object.keys(pinned ?? {}).sort(),
    ["anchor", "author", "authorId", "body", "canDelete", "createdAt", "id", "replies", "resolvedAt"],
    "the html payload gains no orphan field",
  );
  assert.deepEqual(pinned?.anchor, htmlState.comments[0]?.anchor, "the element anchor is unchanged");

  const markdown = workspace({ kind: "markdown", text: MARKDOWN });
  const markdownState = commentWorld("markdown", MARKDOWN_ID, markdown.revision);
  const markdownApp = commentsApp({ store: markdown, id: MARKDOWN_ID, kind: "markdown" }, markdownState);
  const range = {
    kind: "text-range",
    startLine: 3,
    startCol: 5,
    endLine: 3,
    endCol: 22,
    quotedText: "anchored sentence",
  };
  const created = await call(markdownApp, MARKDOWN_ID, "POST", {
    anchor: range,
    body: "Quoted",
    expectedRevisionId: markdown.revision.id,
  });
  assert.equal(created.status, 201, await created.text());
  const mismatched = await call(markdownApp, MARKDOWN_ID, "POST", {
    anchor: { ...range, quotedText: "something else" },
    body: "Wrong quote",
  });
  assert.equal(mismatched.status, 400, "a text range is still verified against the stored source");
  assert.deepEqual(await mismatched.json(), { error: "anchor_mismatch" });
  const thread = (await listed(markdownApp, MARKDOWN_ID)).comments[0];
  assert.equal(thread?.orphaned, undefined, "the markdown payload gains no orphan field");
  assert.deepEqual(thread?.anchor, range);
});

const mcpComments = (world: ReturnType<typeof workspace>) => {
  const comments: McpCommentRow[] = [];
  const backend = {
    caps: { maxArtifactBytes: 1_000_000, maxChunkBytes: 262_144, maxCommentBody: 4000, maxCommentQuote: 2000 },
    commentDocument: async (): Promise<McpCommentDocument> => ({
      id: CANVAS_ID,
      kind: "canvas",
      ownerId: OWNER,
      access: "owner",
      deletedAt: null,
    }),
    findComment: async () => null,
    insertComment: async (_executor: unknown, input: McpCommentInsert): Promise<{ id: string }> => {
      const id = `comment-${comments.length + 1}`;
      comments.push({
        id,
        authorId: input.authorId,
        authorName: null,
        authorImage: null,
        anchor: input.anchor,
        body: input.body,
        parentId: input.parentId,
        resolvedAt: null,
        createdAt: NOW,
      });
      return { id };
    },
    listComments: async (): Promise<McpCommentRow[]> => [...comments],
    setCommentResolved: async (): Promise<undefined> => undefined,
    currentRevision: async () => ({
      id: world.revision.id,
      storageKey: world.revision.storageKey,
      sha256: world.revision.sha256,
    }),
    commentTransaction: async (run: (tx: unknown) => Promise<unknown>) => {
      try {
        return await run(undefined);
      } catch (error) {
        if (error instanceof McpRollback) return error.carried;
        throw error;
      }
    },
    selectReadRevision: async () => ({
      id: world.revision.id,
      revisionNumber: 1,
      storageKey: world.revision.storageKey,
      sha256: world.revision.sha256,
      sizeBytes: world.revision.sizeBytes,
      deletedAt: null,
      kind: "canvas",
      title: null,
    }),
    documentDraft: async () => {
      const opened = await openDraft({ store: world.store, storage: world.storage, artifactId: CANVAS_ID });
      if (!opened.ok) return { ok: false as const, kind: opened.kind, reason: opened.reason };
      return {
        ok: true as const,
        value: { artifactId: CANVAS_ID, kind: "canvas", seq: opened.value.seq, text: opened.value.text },
      };
    },
  } as unknown as McpBackend;
  return { backend, comments };
};

type ToolResult = { isError?: boolean; content?: unknown };

const connect = async (backend: McpBackend) => {
  const server = createArtifactTools({ backend, requireScope: "artifacts:write", readScope: "artifacts:read" })({
    userId: OWNER,
    scopes: ["artifacts:write", "artifacts:read"],
  });
  const client = new Client({ name: "scene-comments-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  return (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    client.callTool({ name, arguments: args }) as Promise<ToolResult>;
};

const payloadOf = (result: ToolResult): Record<string, unknown> =>
  JSON.parse(((result.content ?? []) as { text?: string }[])[0]?.text ?? "{}") as Record<string, unknown>;

test("the agent surface refuses a board-point whose node the scene does not hold", async () => {
  const world = workspace({ kind: "canvas", text: canonicalScene(SCENE) });
  const { backend, comments } = mcpComments(world);
  const callTool = await connect(backend);
  const refused = await callTool("artifact_add_comment", {
    artifactId: CANVAS_ID,
    anchor: anchorOf({ nodeId: "node-unknown" }),
    body: "A pin",
  });
  assert.equal(refused.isError, true, "an anchor that points nowhere is a refusal");
  assert.equal(payloadOf(refused).error, "unknown_node", "the refusal names the reason");
  assert.deepEqual(comments, [], "the refusal stores no threaded row");
});

test("the agent surface accepts a live node and lists it un-orphaned", async () => {
  const world = workspace({ kind: "canvas", text: canonicalScene(SCENE) });
  const { backend, comments } = mcpComments(world);
  const callTool = await connect(backend);
  const accepted = await callTool("artifact_add_comment", { artifactId: CANVAS_ID, anchor: ANCHOR, body: "A pin" });
  assert.equal(accepted.isError ?? false, false, JSON.stringify(payloadOf(accepted)));
  assert.equal(comments.length, 1, "the accepted anchor is stored once");
  comments.push({
    id: "comment-lost",
    authorId: OWNER,
    authorName: null,
    authorImage: null,
    anchor: anchorOf({ nodeId: "node-unknown" }),
    body: "Lost",
    parentId: null,
    resolvedAt: null,
    createdAt: NOW,
  });
  const listed = payloadOf(await callTool("artifact_list_comments", { artifactId: CANVAS_ID }));
  const threads = listed.comments as ThreadPayload[];
  assert.deepEqual(
    threads.map((thread) => [thread.orphaned, thread.anchor]),
    [
      [false, ANCHOR],
      [true, anchorOf({ nodeId: "node-unknown" })],
    ],
    "each thread says whether its node is still in the current scene",
  );
});
