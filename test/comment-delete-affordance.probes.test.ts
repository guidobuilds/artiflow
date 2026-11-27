import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Hono } from "hono";

import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import { createLibraryApp } from "../apps/api/src/routes/library.ts";

const ARTIFACT = "artifact-one";
const VIEWER = "user-one";
const OTHER = "user-two";
const REVISION = "55555555-5555-4555-8555-555555555555";
const SOURCE = "# T\n\nhello there\n";
const ACCESSES = ["owner", "editor", "commenter", "reader"] as const;

type Chain = Promise<unknown[]> & {
  leftJoin: () => Chain;
  innerJoin: () => Chain;
  where: () => Chain;
  orderBy: () => Chain;
  limit: () => Chain;
  for: () => Chain;
  $dynamic: () => Chain;
};

const chainOf = (read: () => unknown[]): Chain => {
  const node = Object.assign(Promise.resolve().then(read), {
    leftJoin: () => node,
    innerJoin: () => node,
    where: () => node,
    orderBy: () => node,
    limit: () => node,
    for: () => node,
    $dynamic: () => node,
  }) as unknown as Chain;
  return node;
};

const viewerConfigOf = async (access: string): Promise<Record<string, unknown>> => {
  const bytes = new TextEncoder().encode(SOURCE);
  const artifact = {
    id: ARTIFACT,
    title: "T",
    kind: "markdown",
    revisionId: REVISION,
    revisionNumber: 1,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    storageKey: newRevisionStorageKey(),
    createdAt: new Date(),
    updatedAt: new Date(),
    currentRevisionId: REVISION,
    observedSizeBytes: bytes.length,
  };
  const comment = {
    id: "c1",
    artifactId: ARTIFACT,
    authorId: OTHER,
    authorName: "Other",
    authorImage: null,
    parentId: null,
    anchor: { kind: "text-range", startLine: 3, startCol: 1, endLine: 3, endCol: 12, quotedText: "hello there" },
    body: "hi",
    resolvedAt: null,
    resolvedBy: null,
    revisionId: REVISION,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  let step = 0;
  const database = {
    db: {
      select: () => ({
        from: () =>
          chainOf(() => {
            step += 1;
            if (step === 1) return [artifact];
            if (step === 2) return [{ id: ARTIFACT, ownerId: VIEWER, kind: "markdown", deletedAt: null, access }];
            if (step === 3) return [comment];
            return [];
          }),
      }),
    },
  } as unknown as Database;
  const storage = {
    client: {
      send: async (command: { constructor: { name: string } }): Promise<unknown> =>
        command.constructor.name === "HeadObjectCommand"
          ? { ContentLength: bytes.length }
          : {
              Body: (async function* (): AsyncIterable<Uint8Array> {
                yield bytes;
              })(),
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
  const page = await (await app.request(`/artifact/${ARTIFACT}`, { headers: { cookie: "s=1" } })).text();
  const island = /<script type="application\/json" id="viewer-comments-data">([\s\S]*?)<\/script>/.exec(page)?.[1];
  assert.ok(island !== undefined, "the owner page ships the comments config");
  return JSON.parse(island) as Record<string, unknown>;
};

test("the owner page offers delete on somebody else's thread only to the owner", async () => {
  for (const access of ACCESSES) {
    const config = await viewerConfigOf(access);
    const threads = config.threads as Array<Record<string, unknown>>;
    const writes = access !== "reader";
    assert.equal(config.canComment, writes, `${access} comment permission`);
    assert.equal(config.canResolve, writes, `${access} resolve permission`);
    assert.equal(
      threads[0]?.canDelete,
      access === "owner",
      `${access} on a thread ${OTHER} wrote: only the owner may delete anybody's thread`,
    );
    assert.equal(
      threads[0]?.canResolve,
      writes,
      `${access} on a thread ${OTHER} wrote: resolve follows the write grant`,
    );
  }
});
