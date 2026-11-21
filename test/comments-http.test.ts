import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Hono } from "hono";

import { ARTIFACT_KINDS, acceptsTextOperations, type ArtifactKind } from "@artiflow/domain/kinds";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import { createLibraryApp, type LibraryOptions } from "../apps/api/src/routes/library.ts";

const ARTIFACT_ID = "artifact-one";
const VIEWER_ID = "user-one";
const SOURCE = "# Pricing\n\nThe second paragraph target text.\n";
const ANCHOR = { kind: "text-range", startLine: 3, startCol: 22, endLine: 3, endCol: 33, quotedText: "target text" };

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const queryBuilder = (results: readonly unknown[]) => {
  let next = 0;
  const query = {
    select: () => query,
    from: () => query,
    leftJoin: () => query,
    innerJoin: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    $dynamic: () => query,
    then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown): Promise<unknown> =>
      Promise.resolve(results[next++]).then(onFulfilled, onRejected),
  };
  return query;
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

async function commentsFor(kind: ArtifactKind): Promise<{ reads: number; status: number; body: string }> {
  const bytes = Buffer.from(kind === "markdown" ? SOURCE : "<!doctype html><p>no text</p>", "utf8");
  const artifact = {
    id: ARTIFACT_ID,
    title: "Comments",
    kind,
    storageKey: newRevisionStorageKey(),
    sha256: digestOf(bytes),
    revisionNumber: 1,
  };
  const database = { db: queryBuilder([[artifact], [{ access: "owner" }], [commentRow]]) } as unknown as Database;
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
