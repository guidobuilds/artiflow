import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Hono } from "hono";

import { ARTIFACT_KINDS, acceptsTextOperations, type ArtifactKind } from "@artiflow/domain/kinds";
import { SCENE_FORMAT_VERSION, canonicalScene, type Scene } from "@artiflow/domain/scene";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import { createLibraryApp, type LibraryOptions } from "../apps/api/src/routes/library.ts";

const ARTIFACT_ID = "artifact-one";
const VIEWER_ID = "user-one";
const SOURCE = "# Pricing\n\nThe second paragraph target text.\n";
const ANCHOR = { kind: "text-range", startLine: 3, startCol: 22, endLine: 3, endCol: 33, quotedText: "target text" };

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type Query = Promise<unknown> & {
  from: () => Query;
  leftJoin: () => Query;
  innerJoin: () => Query;
  where: () => Query;
  orderBy: () => Query;
  limit: () => Query;
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
        $dynamic: () => query,
      },
    );
    return query;
  };
  return { select: chain };
};

const commentRow = {
  id: "comment-one",
  artifactId: ARTIFACT_ID,
  authorId: VIEWER_ID,
  authorName: "Ann",
  authorImage: null,
  parentId: null,
  anchor: ANCHOR,
  body: "quoted",
  resolvedAt: null,
  resolvedBy: null,
  revisionId: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const sessionAuth = {
  api: { getSession: async () => ({ user: { id: VIEWER_ID } }) },
} as unknown as LibraryOptions["auth"];

const CANVAS_SCENE: Scene = {
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: "home",
      name: "Home",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      nodes: [{ id: "live", type: "rect", x: 40, y: 20, w: 100, h: 60, fill: "#ffffff" }],
    },
  ],
};

const BOARD_ROW = {
  ...commentRow,
  id: "comment-pin",
  anchor: { kind: "board-point", boardId: "home", nodeId: "live", x: 0.25, y: 0.5 },
};

const THREAD_KEYS = [
  "author",
  "body",
  "canDelete",
  "canResolve",
  "createdAt",
  "id",
  "occurrence",
  "quotedText",
  "replies",
  "resolvedAt",
  "stale",
];
const ANCHORED_THREAD_KEYS = [...THREAD_KEYS, "anchor"].sort();

async function commentsFor(
  kind: ArtifactKind,
  input: { rows?: unknown[]; scene?: Scene } = {},
): Promise<{ reads: number; status: number; body: string }> {
  const bytes = Buffer.from(
    kind === "markdown"
      ? SOURCE
      : input.scene === undefined
        ? "<!doctype html><p>no text</p>"
        : canonicalScene(input.scene),
    "utf8",
  );
  const artifact = {
    id: ARTIFACT_ID,
    title: "Comments",
    kind,
    storageKey: newRevisionStorageKey(),
    sha256: digestOf(bytes),
    revisionNumber: 1,
  };
  const database = {
    db: queryBuilder([[artifact], [{ access: "owner" }], input.rows ?? [commentRow]]),
  } as unknown as Database;
  let reads = 0;
  const storage = {
    client: {
      send: async (command: { constructor: { name: string } }): Promise<unknown> => {
        reads += 1;
        if (command.constructor.name === "HeadObjectCommand") return { ContentLength: bytes.length };
        if (command.constructor.name === "GetObjectCommand")
          return {
            Body: (async function* (): AsyncIterable<Uint8Array> {
              yield bytes;
            })(),
          };
        throw new Error(`unexpected command ${command.constructor.name}`);
      },
    },
    bucket: "test-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  } as unknown as Storage;
  const app = new Hono();
  app.route("/", createLibraryApp({ database, auth: sessionAuth, storage }));
  const response = await app.request(`/artifact/${ARTIFACT_ID}/comments`, { headers: { cookie: "session=one" } });
  return { reads, status: response.status, body: await response.text() };
}

test("the comments route reads and decodes the source exactly for the kinds that store text", async () => {
  for (const kind of ARTIFACT_KINDS) {
    const textStoring = acceptsTextOperations(kind);
    const response = await commentsFor(kind);
    assert.equal(response.status, 200, `${kind} answers the comments list`);
    assert.equal(
      response.reads > 0,
      textStoring,
      `${kind} reads the stored bytes only when the registry says it stores text`,
    );
    const body = JSON.parse(response.body) as { canComment: boolean; threads: { quotedText: string }[] };
    assert.equal(body.canComment, true);
    assert.equal(
      body.threads[0]?.quotedText,
      textStoring ? ANCHOR.quotedText : "",
      `${kind} resolves anchor text only when the registry says it stores text`,
    );
  }
});

test("markdown comments quote the anchored text and html comments keep the element anchor", async () => {
  const markdown = await commentsFor("markdown");
  const quoted = JSON.parse(markdown.body) as {
    threads: { quotedText: string; stale: boolean; occurrence: number; anchor: unknown }[];
  };
  assert.equal(quoted.threads[0]?.quotedText, ANCHOR.quotedText, "the markdown source is decoded for the anchor");
  assert.deepEqual(
    [quoted.threads[0]?.stale, quoted.threads[0]?.occurrence],
    [false, 0],
    "decoding keeps staleness and occurrence resolution working",
  );
  assert.equal(markdown.reads, 2, "one head and one get for the decoded source");

  const html = await commentsFor("html");
  const pinned = JSON.parse(html.body) as { threads: { quotedText: string; occurrence: number; anchor: unknown }[] };
  assert.equal(pinned.threads[0]?.quotedText, "", "html anchors stay element-based, with no decoded text");
  assert.equal(pinned.threads[0]?.occurrence, 0, "no source means no occurrence index");
  assert.deepEqual(pinned.threads[0]?.anchor, ANCHOR, "the element anchor reaches the viewer unchanged");
  assert.equal(html.reads, 0, "html never pays for an unused source read");
});

test("the viewer listing carries orphaned for a scene anchor and nothing new for html or markdown", async () => {
  const threadsOf = (body: string): Record<string, unknown>[] =>
    (JSON.parse(body) as { threads: Record<string, unknown>[] }).threads;

  const canvas = await commentsFor("canvas", { scene: CANVAS_SCENE, rows: [BOARD_ROW] });
  assert.equal(canvas.status, 200);
  assert.equal(canvas.reads > 0, true, "a scene anchor pays for the scene it resolves against");
  assert.equal(threadsOf(canvas.body)[0]?.orphaned, false, "a node the scene holds is not orphaned");
  assert.deepEqual(
    Object.keys(threadsOf(canvas.body)[0] ?? {}).sort(),
    [...ANCHORED_THREAD_KEYS, "orphaned"].sort(),
    "the scene thread is the element payload plus the flag",
  );

  const lost = await commentsFor("canvas", {
    scene: CANVAS_SCENE,
    rows: [{ ...BOARD_ROW, anchor: { ...BOARD_ROW.anchor, nodeId: "gone" } }],
  });
  assert.equal(threadsOf(lost.body)[0]?.orphaned, true, "a node the scene lost is orphaned");
  assert.deepEqual(
    threadsOf(lost.body)[0]?.anchor,
    { kind: "board-point", boardId: "home", nodeId: "gone", x: 0.25, y: 0.5 },
    "and the anchor is reported unchanged",
  );

  for (const [kind, keys] of [
    ["html", ANCHORED_THREAD_KEYS],
    ["markdown", THREAD_KEYS],
  ] as const) {
    const reply = await commentsFor(kind);
    assert.deepEqual(
      Object.keys(threadsOf(reply.body)[0] ?? {}).sort(),
      keys,
      `${kind} keeps its payload exactly as it was`,
    );
    assert.equal("orphaned" in (threadsOf(reply.body)[0] ?? {}), false, `${kind} gains no orphan field`);
  }
});

test("a scene that cannot be read leaves the flag out and still answers the listing", async () => {
  const reply = await commentsFor("canvas", { rows: [BOARD_ROW] });
  assert.equal(reply.status, 200);
  const thread = (JSON.parse(reply.body) as { threads: Record<string, unknown>[] }).threads[0] ?? {};
  assert.equal("orphaned" in thread, false, "absence means unknown, not live");
  assert.deepEqual(thread.anchor, BOARD_ROW.anchor, "the anchor still reaches the viewer");
});

test("a canvas with no scene anchor reads no scene bytes", async () => {
  const reply = await commentsFor("canvas", { scene: CANVAS_SCENE });
  assert.equal(reply.status, 200);
  assert.equal(reply.reads, 0, "the text-range row resolves against nothing");
  assert.deepEqual(
    Object.keys((JSON.parse(reply.body) as { threads: object[] }).threads[0] ?? {}).sort(),
    ANCHORED_THREAD_KEYS,
  );
});
