import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Hono } from "hono";

import { SCENE_FORMAT_VERSION, canonicalScene, type Scene } from "@artiflow/domain/scene";

import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import { createLibraryApp } from "../apps/api/src/routes/library.ts";

const DESIGN_ID = "design-one";
const VIEWER = "viewer-one";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_REVISION = "33333333-3333-4333-8333-333333333333";

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
  ],
};

const ANCHOR = {
  kind: "artboard-point",
  boardId: "frame-a",
  revisionId: SOURCE_REVISION,
  selector: 'button[data-testid="cta"]',
  textHint: "Start free",
  x: 0.4,
  y: 0.6,
  viewportWidth: 1280,
};

const ROW = {
  id: "comment-one",
  artifactId: DESIGN_ID,
  authorId: VIEWER,
  authorName: "Ann",
  authorImage: null,
  parentId: null,
  anchor: ANCHOR,
  body: "Change the label",
  resolvedAt: null,
  resolvedBy: null,
  revisionId: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
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

async function afterListing(sourceAccessible: boolean): Promise<{ canComment: boolean; threads: unknown[] }> {
  const bytes = Buffer.from(canonicalScene(SCENE), "utf8");
  const artifact = {
    id: DESIGN_ID,
    title: "Shared version picker",
    kind: "canvas",
    storageKey: newRevisionStorageKey(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    revisionNumber: 1,
  };
  const source = sourceAccessible
    ? [{ id: SOURCE_ID, ownerId: "owner", kind: "html", access: "reader", deletedAt: null }]
    : [];
  const database = {
    db: queryBuilder([[artifact], [{ access: "commenter" }], [ROW], source]),
  } as unknown as Database;
  const storage = {
    client: {
      send: async (command: { constructor: { name: string } }): Promise<unknown> => {
        if (command.constructor.name === "HeadObjectCommand") return { ContentLength: bytes.length };
        return {
          Body: (async function* (): AsyncIterable<Uint8Array> {
            yield bytes;
          })(),
        };
      },
    },
    bucket: "test-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  } as unknown as Storage;
  const app = new Hono();
  app.route(
    "/",
    createLibraryApp({
      database,
      auth: { api: { getSession: async () => ({ user: { id: VIEWER } }) } } as never,
      storage,
    }),
  );
  const response = await app.request(`/artifact/${DESIGN_ID}/comments`, { headers: { cookie: "session=one" } });
  assert.equal(response.status, 200);
  return (await response.json()) as { canComment: boolean; threads: unknown[] };
}

test("a viewer without source access reads the thread but never the locator captured from the source", async () => {
  const { canComment, threads } = await afterListing(false);
  assert.equal(canComment, true, "the design permission still allows commenting");
  const thread = threads[0] as { anchor: { selector: string; textHint: string; x: number; y: number }; body: string };
  assert.deepEqual(
    { selector: thread.anchor.selector, textHint: thread.anchor.textHint },
    { selector: "", textHint: "(hidden)" },
    "the locator keeps its geometry but loses what the source said",
  );
  assert.equal(thread.anchor.x, ANCHOR.x, "the point still places the request on the artboard");
  assert.equal(JSON.stringify(threads).includes("Start free"), false, "no artifact text travels with the listing");
  assert.equal(JSON.stringify(threads).includes("data-testid"), false, "no selector travels either");
  assert.equal(thread.body, "Change the label", "the person's own words are not source content");
});

test("a viewer with source access reads the artboard anchor unchanged", async () => {
  const { threads } = await afterListing(true);
  assert.deepEqual((threads[0] as { anchor: unknown }).anchor, ANCHOR);
});
