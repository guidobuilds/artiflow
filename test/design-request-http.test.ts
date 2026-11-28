import assert from "node:assert/strict";
import { test } from "node:test";

import { Hono } from "hono";

import { SCENE_FORMAT_VERSION, type Scene } from "@artiflow/domain/scene";

import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import type { DocumentStore } from "../apps/api/src/domain/documents/service.ts";
import { createCommentsApp } from "../apps/api/src/routes/comments.ts";

const DESIGN_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const VIEWER = "44444444-4444-4444-8444-444444444444";
const DESIGN_REVISION = "55555555-5555-4555-8555-555555555555";
const SOURCE_REVISION = "33333333-3333-4333-8333-333333333333";
const OTHER_REVISION = "66666666-6666-4666-8666-666666666666";
const OLD_REVISION = "77777777-7777-4777-8777-777777777777";

const ARTBOARD_ANCHOR = {
  kind: "artboard-point",
  boardId: "frame-a",
  revisionId: SOURCE_REVISION,
  selector: 'button[data-testid="cta"]',
  textHint: "Start free",
  x: 0.4,
  y: 0.6,
  viewportWidth: 1280,
};

const SCENE: Scene = {
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: "frame-a",
      name: "Variant A",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      nodes: [],
      source: { artifactId: SOURCE_ID, revisionId: SOURCE_REVISION, mode: "fixed" },
    },
    {
      id: "frame-b",
      name: "Variant B",
      x: 400,
      y: 0,
      w: 400,
      h: 300,
      nodes: [],
      source: { artifactId: SOURCE_ID, revisionId: OTHER_REVISION, mode: "fixed" },
    },
  ],
};

type Query = Promise<unknown> & {
  from: () => Query;
  leftJoin: () => Query;
  innerJoin: () => Query;
  where: () => Query;
  orderBy: () => Query;
  limit: () => Query;
  for: () => Query;
  $dynamic: () => Query;
};

const queryBuilder = (results: readonly unknown[]) => {
  let next = 0;
  const chain = (): Query => {
    const query: Query = Object.assign(
      Promise.resolve().then(() => results[next++]),
      {
        from: () => query,
        leftJoin: () => query,
        innerJoin: () => query,
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        for: () => query,
        $dynamic: () => query,
      },
    );
    return query;
  };
  return { select: chain };
};

const documents = (scene: Scene): DocumentStore =>
  ({
    readArtifact: async () => ({
      artifactId: DESIGN_ID,
      kind: "canvas",
      publishedSeq: 1,
      currentRevisionId: DESIGN_REVISION,
      revisionCount: 1,
      latestSnapshot: null,
    }),
    readDraft: async () => ({
      artifactId: DESIGN_ID,
      seq: 1,
      formatVersion: SCENE_FORMAT_VERSION,
      state: { scene },
      updatedByUserId: VIEWER,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  }) as unknown as DocumentStore;

type Outcome = { status: number; body: unknown; inserted: Record<string, unknown>[]; reads: number };

async function post(
  input: {
    access?: string;
    source?: { kind: string } | null;
    anchor?: unknown;
    scene?: Scene;
  } = {},
): Promise<Outcome> {
  const access = input.access ?? "commenter";
  const source = input.source === undefined ? { kind: "html" } : input.source;
  const results: unknown[] = [
    [{ id: DESIGN_ID, ownerId: "owner-1", kind: "canvas", access, deletedAt: null }],
    [{ id: DESIGN_REVISION, storageKey: "key", sha256: "a".repeat(64) }],
    source === null
      ? []
      : [{ id: SOURCE_ID, ownerId: "owner-1", kind: source.kind, access: "reader", deletedAt: null }],
  ];
  const inserted: Record<string, unknown>[] = [];
  const db = {
    ...queryBuilder(results),
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(values);
          return [{ id: "new-comment" }];
        },
      }),
    }),
  };
  let reads = 0;
  const storage = {
    client: {
      send: async () => {
        reads += 1;
        throw new Error("the request path must not read artifact bytes");
      },
    },
    bucket: "test-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  } as unknown as Storage;
  const app = new Hono();
  app.route(
    "/",
    createCommentsApp({
      database: { db } as unknown as Database,
      auth: {} as never,
      storage,
      publicOrigin: "https://app.test",
      principal: true,
      documentStore: documents(input.scene ?? SCENE),
    }),
  );
  const response = await app.request(`/api/artifacts/${DESIGN_ID}/comments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-artiflow-principal": JSON.stringify({ userId: VIEWER, scopes: [] }),
    },
    body: JSON.stringify({
      anchor: input.anchor ?? ARTBOARD_ANCHOR,
      body: "Please change the label",
      expectedRevisionId: DESIGN_REVISION,
    }),
  });
  return { status: response.status, body: await response.json(), inserted, reads };
}

test("a commenter with source access records a request anchored to the artboard and its pinned revision", async () => {
  const outcome = await post();
  assert.equal(outcome.status, 201);
  assert.deepEqual(outcome.body, { id: "new-comment" });
  assert.deepEqual(outcome.inserted[0]?.anchor, ARTBOARD_ANCHOR);
  assert.equal(outcome.inserted[0]?.revisionId, DESIGN_REVISION);
  assert.equal(outcome.reads, 0, "the request never reads artifact bytes");
});

test("a reader who cannot comment cannot create a request", async () => {
  const outcome = await post({ access: "reader" });
  assert.equal(outcome.status, 403);
  assert.deepEqual(outcome.inserted, []);
});

test("a commenter without source access cannot create a request that would reveal it", async () => {
  const outcome = await post({ source: null });
  assert.equal(outcome.status, 403);
  assert.deepEqual(outcome.body, { error: "source_unavailable" });
  assert.deepEqual(outcome.inserted, []);
  assert.equal(outcome.reads, 0, "an unreadable source is never read");
});

test("a source that is not an HTML page cannot be the target of an artboard request", async () => {
  const outcome = await post({ source: { kind: "markdown" } });
  assert.equal(outcome.status, 403);
  assert.deepEqual(outcome.inserted, []);
});

test("a request pinned to another source revision needs a new target", async () => {
  const outcome = await post({ anchor: { ...ARTBOARD_ANCHOR, revisionId: OLD_REVISION } });
  assert.equal(outcome.status, 400);
  assert.deepEqual(outcome.body, { error: "revision_mismatch" });
  assert.deepEqual(outcome.inserted, []);
});

test("a request that names a missing frame or a frame without an artboard is refused", async () => {
  const missing = await post({ anchor: { ...ARTBOARD_ANCHOR, boardId: "frame-missing" } });
  assert.deepEqual(missing.body, { error: "unknown_frame" });
  const plain = await post({
    anchor: { ...ARTBOARD_ANCHOR, boardId: "frame-plain" },
    scene: {
      ...SCENE,
      frames: [...SCENE.frames, { id: "frame-plain", name: "Plain", x: 0, y: 600, w: 200, h: 200, nodes: [] }],
    },
  });
  assert.deepEqual(plain.body, { error: "unknown_source" });
  assert.deepEqual(plain.inserted, []);
});

test("a request with an invalid locator never reaches the database", async () => {
  const outcome = await post({ anchor: { ...ARTBOARD_ANCHOR, x: 1.5 } });
  assert.equal(outcome.status, 400);
  assert.deepEqual(outcome.body, { error: "invalid_anchor" });
  assert.deepEqual(outcome.inserted, []);
});

test("an artboard anchor is only accepted for a canvas", async () => {
  const outcome = await post({ access: "owner" });
  assert.equal(outcome.status, 201, "an owner may request as well");
  assert.equal(outcome.inserted.length, 1);
});
