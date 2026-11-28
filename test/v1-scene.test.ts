import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";

import { SCENE_FORMAT_VERSION, canonicalScene, type Scene } from "@artiflow/domain/scene";
import { MAX_SCENE_READ_BYTES, MAX_SCENE_READ_NODES } from "@artiflow/mcp-server/constants";

import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import {
  artifactRevisions,
  artifacts,
  documentDrafts,
  documentOperations,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { createSceneV1App } from "../apps/api/src/routes/v1/scene.ts";

const CANVAS = "11111111-1111-4111-8111-111111111111";
const MARKDOWN = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const NOW = new Date();
const READ_PRINCIPAL = JSON.stringify({ userId: OWNER, scopes: ["artifacts:read"] });
const WRITE_PRINCIPAL = JSON.stringify({ userId: OWNER, scopes: ["artifacts:read", "artifacts:write"] });

const FRAME = "frame-home";
const NODE = "node-live";
const LOOSE = "node-canvas";
const CANVAS_KEY = "artifacts/canvas-1";
const MARKDOWN_KEY = "artifacts/markdown-1";

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
      nodes: [{ id: NODE, type: "rect", x: 40, y: 20, w: 100, h: 60, fill: "#ffffff" }],
    },
  ],
  nodes: [{ id: LOOSE, type: "rect", x: 0, y: 0, w: 20, h: 20, fill: "#dddddd" }],
};

const MARKDOWN_TEXT = "# Hello\n";
const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const restated = () => JSON.parse(canonicalScene(SCENE)) as { frames: Record<string, unknown>[]; nodes: unknown[] };

type ArtifactRow = {
  id: string;
  ownerId: string;
  kind: string;
  title: string | null;
  publishedSeq: number;
  currentRevisionId: string | null;
  deletedAt: Date | null;
  observedSizeBytes: number | null;
};
type RevisionRow = {
  id: string;
  artifactId: string;
  revision: number;
  formatVersion: number;
  seqFrom: number;
  seqTo: number;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  createdAt: Date;
};
type DraftRow = {
  artifactId: string;
  seq: number;
  formatVersion: number;
  state: unknown;
  updatedByUserId: string | null;
  updatedAt: Date;
};
type OperationRow = {
  id: string;
  artifactId: string;
  seq: number;
  baseSeq: number;
  authorKind: string;
  authorId: string;
  ops: unknown;
  result: string;
  idempotencyKey: string;
  createdAt: Date;
};

type World = {
  artifacts: Map<string, ArtifactRow>;
  revisions: RevisionRow[];
  drafts: Map<string, DraftRow>;
  operations: OperationRow[];
  objects: Map<string, Uint8Array>;
};

function seed(): World {
  const world: World = {
    artifacts: new Map(),
    revisions: [],
    drafts: new Map(),
    operations: [],
    objects: new Map(),
  };
  const canvasBytes = new TextEncoder().encode(canonicalScene(SCENE));
  const markdownBytes = new TextEncoder().encode(MARKDOWN_TEXT);
  world.objects.set(CANVAS_KEY, canvasBytes);
  world.objects.set(MARKDOWN_KEY, markdownBytes);
  world.revisions.push({
    id: "revision-1",
    artifactId: CANVAS,
    revision: 1,
    formatVersion: SCENE_FORMAT_VERSION,
    seqFrom: 0,
    seqTo: 0,
    sizeBytes: canvasBytes.length,
    sha256: digestOf(canvasBytes),
    storageKey: CANVAS_KEY,
    createdAt: NOW,
  });
  world.revisions.push({
    id: "revision-2",
    artifactId: MARKDOWN,
    revision: 1,
    formatVersion: 1,
    seqFrom: 0,
    seqTo: 0,
    sizeBytes: markdownBytes.length,
    sha256: digestOf(markdownBytes),
    storageKey: MARKDOWN_KEY,
    createdAt: NOW,
  });
  world.artifacts.set(CANVAS, {
    id: CANVAS,
    ownerId: OWNER,
    kind: "canvas",
    title: "Canvas",
    publishedSeq: 0,
    currentRevisionId: "revision-1",
    deletedAt: null,
    observedSizeBytes: canvasBytes.length,
  });
  world.artifacts.set(MARKDOWN, {
    id: MARKDOWN,
    ownerId: OWNER,
    kind: "markdown",
    title: "Notes",
    publishedSeq: 0,
    currentRevisionId: "revision-2",
    deletedAt: null,
    observedSizeBytes: markdownBytes.length,
  });
  return world;
}

const dialect = new PgDialect();

class SelectChain<T> extends Promise<T> {
  readonly joins = new Set<unknown>();
  table: unknown = null;
  compiled: { sql: string; params: unknown[] } = { sql: "", params: [] };
  grouped = false;

  from(table: unknown): this {
    this.table = table;
    return this;
  }

  leftJoin(table: unknown): this {
    this.joins.add(table);
    return this;
  }

  innerJoin(table: unknown): this {
    this.joins.add(table);
    return this;
  }

  where(expression: unknown): this {
    this.compiled = dialect.sqlToQuery(expression as SQL);
    return this;
  }

  groupBy(): this {
    this.grouped = true;
    return this;
  }

  orderBy(): this {
    return this;
  }

  limit(): this {
    return this;
  }

  for(): this {
    return this;
  }
}

function fakeDatabase(world: World): Database {
  const select = (): SelectChain<unknown[]> => {
    let query!: SelectChain<unknown[]>;
    query = new SelectChain<unknown[]>((resolve) => {
      queueMicrotask(() => resolve(rows(query)));
    });
    return query;
  };

  const rows = (query: SelectChain<unknown[]>): unknown[] => {
    if (query.table === artifacts && query.joins.has(artifactRevisions)) {
      const artifactId = String(query.compiled.params[0]);
      const ownerId = String(query.compiled.params[1]);
      const artifact = world.artifacts.get(artifactId);
      if (!artifact || artifact.ownerId !== ownerId) return [];
      if (query.grouped)
        return [
          {
            ...artifact,
            revisionCount: world.revisions.filter((row) => row.artifactId === artifactId).length,
          },
        ];
      const revision = world.revisions.find((row) => row.id === artifact.currentRevisionId);
      return [
        {
          ...artifact,
          id: revision?.id ?? null,
          revisionNumber: revision?.revision ?? null,
          sha256: revision?.sha256 ?? null,
          sizeBytes: revision?.sizeBytes ?? null,
          storageKey: revision?.storageKey ?? null,
        },
      ];
    }
    if (query.table === artifacts) {
      const artifact = world.artifacts.get(String(query.compiled.params[0]));
      return artifact ? [{ ...artifact }] : [];
    }
    if (query.table === artifactRevisions) {
      if (query.compiled.sql.includes("count("))
        return [
          {
            count: world.revisions.filter((row) => row.artifactId === String(query.compiled.params[0])).length,
          },
        ];
      if (query.compiled.sql.includes('"storageKey"'))
        return world.revisions
          .filter((row) => row.storageKey === String(query.compiled.params[0]))
          .map((row) => ({ sha256: row.sha256 }));
      return world.revisions.filter((row) => row.id === String(query.compiled.params[0]));
    }
    if (query.table === documentDrafts) {
      const draft = world.drafts.get(String(query.compiled.params[0]));
      return draft ? [{ ...draft }] : [];
    }
    if (query.table === documentOperations)
      return world.operations.filter(
        (row) =>
          row.artifactId === String(query.compiled.params[0]) &&
          row.idempotencyKey === String(query.compiled.params[1]),
      );
    return [];
  };

  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      const chain = {
        onConflictDoNothing: () => chain,
        returning: (): Promise<unknown[]> => {
          if (table === documentDrafts) {
            const artifactId = String(values.artifactId);
            if (world.drafts.has(artifactId)) return Promise.resolve([]);
            const row = { ...values } as unknown as DraftRow;
            world.drafts.set(artifactId, row);
            return Promise.resolve([row]);
          }
          if (table === documentOperations) {
            const artifactId = String(values.artifactId);
            const key = String(values.idempotencyKey);
            if (world.operations.some((row) => row.artifactId === artifactId && row.idempotencyKey === key))
              return Promise.resolve([]);
            const row = { ...values, id: `operation-${world.operations.length + 1}` } as unknown as OperationRow;
            world.operations.push(row);
            return Promise.resolve([{ id: row.id }]);
          }
          return Promise.resolve([{}]);
        },
      };
      return chain;
    },
  });
  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: (expression: unknown): Promise<unknown[]> => {
        const compiled = dialect.sqlToQuery(expression as SQL);
        if (table === documentDrafts) {
          const draft = world.drafts.get(String(compiled.params[0]));
          if (draft) world.drafts.set(draft.artifactId, { ...draft, ...values });
        }
        return Promise.resolve([]);
      },
    }),
  });
  const db = {
    select,
    insert,
    update,
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return { db } as unknown as Database;
}

function fakeStorage(world: World): Storage {
  const providerError = (status: number): Error =>
    Object.assign(new Error(`provider ${status}`), { $metadata: { httpStatusCode: status } });
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const name = command.constructor.name;
      const key = String(command.input.Key ?? "");
      const stored = world.objects.get(key);
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
      if (name === "PutObjectCommand") {
        world.objects.set(key, Uint8Array.from(command.input.Body as Uint8Array));
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

const appOf = (world: World): Hono => {
  const app = new Hono();
  app.route("/", createSceneV1App({ database: fakeDatabase(world), storage: fakeStorage(world) }));
  return app;
};

const call = (
  app: Hono,
  method: "GET" | "POST",
  path: string,
  options: { principal?: string; body?: unknown } = {},
): Promise<Response> =>
  Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "x-artiflow-principal": options.principal ?? READ_PRINCIPAL,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const applyOf = (
  ops: unknown[],
  baseSeq = 0,
  idempotencyKey = "op-1",
): { baseSeq: number; idempotencyKey: string; ops: unknown[] } => ({
  baseSeq,
  idempotencyKey,
  ops,
});

test("the outline route answers one entry per frame and the draft it read", async () => {
  const response = await call(appOf(seed()), "GET", `/api/artifacts/${CANVAS}/scene/outline`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    artifactId: CANVAS,
    revisionId: "revision-1",
    seq: 0,
    formatVersion: SCENE_FORMAT_VERSION,
    frameCount: 1,
    looseNodeCount: 1,
    frames: [{ id: FRAME, name: "Home", nodeCount: 1, bbox: { x: 40, y: 20, w: 100, h: 60 } }],
    pageCount: 0,
    pages: [],
    guides: null,
  });
});

test("the read route answers the canvas level when it names no frame", async () => {
  const scene = restated();
  const bare = await call(appOf(seed()), "GET", `/api/artifacts/${CANVAS}/scene/read`);
  assert.equal(bare.status, 200);
  assert.deepEqual(await bare.json(), {
    artifactId: CANVAS,
    revisionId: "revision-1",
    seq: 0,
    canvas: { nodeCount: 1, nodes: scene.nodes },
  });
  const empty = await call(appOf(seed()), "GET", `/api/artifacts/${CANVAS}/scene/read?frameId=&nodeIds=`);
  assert.equal(empty.status, 200, "an empty query value is ignored rather than refused");
  assert.deepEqual(
    await empty.json(),
    await json(await call(appOf(seed()), "GET", `/api/artifacts/${CANVAS}/scene/read`)),
  );
});

test("the read route answers exactly one frame when it names one", async () => {
  const frame = restated().frames[0] as Record<string, unknown>;
  const response = await call(appOf(seed()), "GET", `/api/artifacts/${CANVAS}/scene/read?frameId=${FRAME}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    artifactId: CANVAS,
    revisionId: "revision-1",
    seq: 0,
    frame: {
      id: FRAME,
      name: "Home",
      x: frame.x,
      y: frame.y,
      w: frame.w,
      h: frame.h,
      bbox: { x: 40, y: 20, w: 100, h: 60 },
      nodeCount: 1,
      nodes: frame.nodes,
    },
  });
  const narrowed = await call(
    appOf(seed()),
    "GET",
    `/api/artifacts/${CANVAS}/scene/read?frameId=${FRAME}&nodeIds=${NODE}`,
  );
  assert.equal(narrowed.status, 200);
  assert.equal(((await json(narrowed)).frame as Record<string, unknown>).nodeCount, 1);
});

test("a non-canvas artifact refuses every scene route with wrong_kind", async () => {
  const app = appOf(seed());
  for (const path of ["scene/outline", "scene/read"]) {
    const response = await call(app, "GET", `/api/artifacts/${MARKDOWN}/${path}`);
    assert.equal(response.status, 409, path);
    assert.deepEqual(await json(response), {
      error: "wrong_kind",
      message: "artifact_is_not_a_canvas",
      artifactId: MARKDOWN,
      kind: "markdown",
    });
  }
});

test("an id the scene does not hold refuses with unknown_frame or unknown_node and a 404", async () => {
  const app = appOf(seed());
  const frame = await call(app, "GET", `/api/artifacts/${CANVAS}/scene/read?frameId=frame-missing`);
  assert.equal(frame.status, 404);
  assert.deepEqual(await json(frame), {
    error: "unknown_frame",
    message: "frame_not_in_scene",
    artifactId: CANVAS,
    frameId: "frame-missing",
  });
  const node = await call(app, "GET", `/api/artifacts/${CANVAS}/scene/read?nodeIds=node-missing`);
  assert.equal(node.status, 404);
  assert.deepEqual(await json(node), {
    error: "unknown_node",
    message: "node_not_in_scene",
    artifactId: CANVAS,
    nodeId: "node-missing",
  });
});

test("a read window wider than the node cap is too_large and 413", async () => {
  const ids = Array.from({ length: MAX_SCENE_READ_NODES + 1 }, (_, index) => `node-${index + 1}`);
  const response = await call(appOf(seed()), "GET", `/api/artifacts/${CANVAS}/scene/read?nodeIds=${ids.join(",")}`);
  assert.equal(response.status, 413);
  assert.deepEqual(await json(response), {
    error: "too_large",
    message: "read_window_exceeds_the_node_cap",
    artifactId: CANVAS,
    maxNodes: MAX_SCENE_READ_NODES,
    requestedNodes: MAX_SCENE_READ_NODES + 1,
  });
});

test("apply answers the applied batch with the new sequence and the touched box", async () => {
  const world = seed();
  const response = await call(appOf(world), "POST", `/api/artifacts/${CANVAS}/scene/apply`, {
    principal: WRITE_PRINCIPAL,
    body: applyOf([{ op: "move_node", id: NODE, x: 10, y: 20 }]),
  });
  const body = await json(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, {
    artifactId: CANVAS,
    baseSeq: 0,
    seq: 1,
    applied: 1,
    replayed: false,
    published: false,
    revisionId: null,
    boxes: [{ id: NODE, frameId: FRAME, x: 10, y: 20, w: 100, h: 60 }],
    violations: [],
  });
  assert.equal(world.drafts.get(CANVAS)?.seq, 1, "the draft sequence advanced once");
});

test("a stale baseSeq refuses with concurrent_edit and the current sequence", async () => {
  const world = seed();
  const response = await call(appOf(world), "POST", `/api/artifacts/${CANVAS}/scene/apply`, {
    principal: WRITE_PRINCIPAL,
    body: applyOf([{ op: "move_node", id: NODE, x: 10, y: 20 }], 4),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await json(response), {
    error: "concurrent_edit",
    message: "base_sequence_is_stale",
    artifactId: CANVAS,
    currentSeq: 0,
  });
  assert.equal(world.operations.length, 0, "a stale batch records no operation");
});

test("a missing write scope is refused before any write reaches the store", async () => {
  const world = seed();
  const app = appOf(world);
  const response = await call(app, "POST", `/api/artifacts/${CANVAS}/scene/apply`, {
    principal: READ_PRINCIPAL,
    body: applyOf([{ op: "move_node", id: NODE, x: 10, y: 20 }]),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await json(response), { error: "unauthorized" });
  assert.equal(world.operations.length, 0, "no operation was recorded");
  assert.equal(world.drafts.size, 0, "no draft was written");
  const read = await call(app, "GET", `/api/artifacts/${CANVAS}/scene/read?frameId=${FRAME}`);
  const nodes = ((await json(read)).frame as Record<string, unknown>).nodes as Record<string, unknown>[];
  assert.equal(nodes[0]?.x, 40, "the stored node is untouched");
});

test("a rejected batch is invalid_operation and leaves the document and its sequence unchanged", async () => {
  const world = seed();
  const app = appOf(world);
  const rejected = await call(app, "POST", `/api/artifacts/${CANVAS}/scene/apply`, {
    principal: WRITE_PRINCIPAL,
    body: applyOf([{ op: "remove_node", id: "node-missing" }]),
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(await json(rejected), {
    error: "invalid_operation",
    message: "unknown_node",
    artifactId: CANVAS,
    currentSeq: 0,
    opIndex: 0,
  });
  assert.equal(world.drafts.get(CANVAS)?.seq, 0, "the draft sequence did not move");
  const read = await call(app, "GET", `/api/artifacts/${CANVAS}/scene/read?frameId=${FRAME}`);
  const body = await json(read);
  assert.equal(body.seq, 0, "the read still reports the sequence it had");
  const nodes = (body.frame as Record<string, unknown>).nodes as Record<string, unknown>[];
  assert.equal(nodes[0]?.id, NODE, "the stored node survived the rejection");
});

test("a malformed apply body is invalid_request and a malformed id is not_found", async () => {
  const world = seed();
  const app = appOf(world);
  const malformed = await call(app, "POST", `/api/artifacts/${CANVAS}/scene/apply`, {
    principal: WRITE_PRINCIPAL,
    body: { baseSeq: "zero" },
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await json(malformed), { error: "invalid_request" });
  assert.equal(world.drafts.size, 0, "a malformed request writes nothing");
  const missing = await call(app, "GET", "/api/artifacts/not-a-uuid/scene/outline");
  assert.equal(missing.status, 404);
  assert.deepEqual(await json(missing), { error: "not_found" });
});

function canvasWith(scene: Scene): World {
  const world = seed();
  const bytes = new TextEncoder().encode(canonicalScene(scene));
  world.objects.set(CANVAS_KEY, bytes);
  for (const revision of world.revisions) {
    if (revision.storageKey !== CANVAS_KEY) continue;
    revision.sizeBytes = bytes.length;
    revision.sha256 = digestOf(bytes);
  }
  const artifact = world.artifacts.get(CANVAS);
  if (artifact !== undefined) artifact.observedSizeBytes = bytes.length;
  return world;
}

const HEAVY = "frame-heavy";

const heavyScene = (): Scene => ({
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: HEAVY,
      name: "Heavy",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      nodes: Array.from({ length: 80 }, (_, index) => ({
        id: `heavy-${index + 1}`,
        type: "text" as const,
        x: 0,
        y: index,
        w: 10,
        h: 10,
        text: "x".repeat(1200),
      })),
    },
  ],
});

test("a read window wider than the byte cap is too_large and 413", async () => {
  const response = await call(
    appOf(canvasWith(heavyScene())),
    "GET",
    `/api/artifacts/${CANVAS}/scene/read?frameId=${HEAVY}`,
  );
  const body = await json(response);
  assert.equal(response.status, 413, JSON.stringify(body));
  assert.equal(body.error, "too_large");
  assert.equal(body.message, "read_window_exceeds_the_byte_cap");
  assert.equal(body.maxBytes, MAX_SCENE_READ_BYTES);
  assert.ok(typeof body.observedBytes === "number" && body.observedBytes > MAX_SCENE_READ_BYTES);
});

test("a deleted canvas refuses its outline and its frames with gone and writes nothing", async () => {
  const world = seed();
  const artifact = world.artifacts.get(CANVAS);
  if (artifact !== undefined) artifact.deletedAt = NOW;
  const app = appOf(world);
  for (const path of [`/api/artifacts/${CANVAS}/scene/outline`, `/api/artifacts/${CANVAS}/scene/read`]) {
    const response = await call(app, "GET", path);
    const body = await json(response);
    assert.equal(response.status, 404, path);
    assert.equal(body.error, "gone", path);
    assert.equal(body.message, "artifact_deleted", path);
  }
  assert.equal(world.drafts.size, 0, "no draft was opened for a deleted artifact");
});

test("a batch of canvas-level operations applies and reports no frame box", async () => {
  const response = await call(appOf(seed()), "POST", `/api/artifacts/${CANVAS}/scene/apply`, {
    principal: WRITE_PRINCIPAL,
    body: applyOf([{ op: "move_canvas_node", id: LOOSE, x: 1, y: 1 }]),
  });
  const body = await json(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.applied, 1);
  assert.deepEqual(body.boxes, [], "a loose canvas node belongs to no frame box");
});
