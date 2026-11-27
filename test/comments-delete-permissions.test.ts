import assert from "node:assert/strict";
import { test } from "node:test";

import { Hono } from "hono";

import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import {
  artifactComments,
  artifactRevisions,
  artifacts,
  artifactShares,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { createCommentsApp } from "../apps/api/src/routes/comments.ts";

const ARTIFACT = "11111111-1111-4111-8111-111111111111";
const CALLER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const THREAD = "44444444-4444-4444-8444-444444444444";
const REVISION = "55555555-5555-4555-8555-555555555555";
const OLDER_REVISION = "77777777-7777-4777-8777-777777777777";
const ORIGIN = "https://app.test";
const NOW = new Date("2026-11-21T12:00:00.000Z");

const ACCESSES = ["owner", "editor", "commenter", "reader"] as const;
type Access = (typeof ACCESSES)[number];

const ELEMENT_ANCHOR = {
  kind: "element",
  selector: "p",
  point: { x: 0.5, y: 0.5 },
  textHint: "Pricing",
  viewportWidth: 800,
};

type CommentRow = {
  id: string;
  artifactId: string;
  authorId: string;
  authorName: string | null;
  authorImage: string | null;
  parentId: string | null;
  anchor: unknown;
  revisionId: string | null;
  resolvedBy: string | null;
  body: string;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type World = {
  doc: { id: string; ownerId: string; kind: string; access: string; deletedAt: Date | null };
  revision: { id: string; storageKey: string; sha256: string };
  comments: CommentRow[];
};

const thread = (authorId: string): CommentRow => ({
  id: THREAD,
  artifactId: ARTIFACT,
  authorId,
  authorName: null,
  authorImage: null,
  parentId: null,
  anchor: ELEMENT_ANCHOR,
  revisionId: REVISION,
  resolvedBy: null,
  body: "a thread",
  resolvedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const worldOf = (access: Access, comments: CommentRow[] = [thread(CALLER)]): World => ({
  doc: {
    id: ARTIFACT,
    ownerId: access === "owner" ? CALLER : OTHER,
    kind: "html",
    access,
    deletedAt: null,
  },
  revision: { id: REVISION, storageKey: "revisions/one", sha256: "a".repeat(64) },
  comments,
});

type SelectNode = Promise<unknown[]> & {
  leftJoin: (joined: unknown) => SelectNode;
  innerJoin: (joined: unknown) => SelectNode;
  where: () => SelectNode;
  orderBy: () => SelectNode;
  limit: () => SelectNode;
  for: () => SelectNode;
  $dynamic: () => SelectNode;
};

function fakeDatabase(world: World) {
  const select = () => ({
    from: (table: unknown): SelectNode => {
      const joins = new Set<unknown>();
      const read = (): unknown[] => {
        if (table === artifacts && joins.has(artifactShares)) return [{ ...world.doc }];
        if (table === artifacts && joins.has(artifactRevisions)) return [{ ...world.revision }];
        if (table === artifactComments) return [...world.comments];
        return [];
      };
      const node: SelectNode = Object.assign(Promise.resolve().then(read), {
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
    values: (values: {
      artifactId: string;
      authorId: string;
      parentId: string | null;
      anchor: unknown;
      revisionId: string | null;
      body: string;
    }) => ({
      returning: (): Promise<unknown[]> => {
        const row = thread(values.authorId);
        world.comments.push({
          ...row,
          id: "66666666-6666-4666-8666-666666666666",
          artifactId: values.artifactId,
          parentId: values.parentId,
          anchor: values.anchor,
          revisionId: values.revisionId,
          body: values.body,
        });
        return Promise.resolve([{ id: world.comments.at(-1)?.id }]);
      },
    }),
  });
  const update = () => ({
    set: (values: { resolvedAt?: unknown }) => ({
      where: (): Promise<undefined> => {
        for (const row of world.comments) row.resolvedAt = values.resolvedAt === null ? null : NOW;
        return Promise.resolve(undefined);
      },
    }),
  });
  const remove = () => ({
    where: (): Promise<undefined> => {
      world.comments.splice(0, world.comments.length);
      return Promise.resolve(undefined);
    },
  });
  const db = {
    select,
    insert,
    update,
    delete: remove,
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return db as unknown as Database["db"];
}

const appFor = (world: World, principal = true): Hono => {
  const app = new Hono();
  app.route(
    "/",
    createCommentsApp({
      database: { db: fakeDatabase(world) } as unknown as Database,
      auth: { api: { getSession: async () => ({ user: { id: CALLER } }) } } as never,
      storage: {} as never,
      publicOrigin: ORIGIN,
      ...(principal ? { principal: true as const } : {}),
    }),
  );
  return app;
};

const commentsPath = (): string => `/api/artifacts/${ARTIFACT}/comments`;
const threadPath = (operation?: string): string =>
  `${commentsPath()}/${THREAD}${operation === undefined ? "" : `/${operation}`}`;

const asPrincipal = (): Record<string, string> => ({
  "x-artiflow-principal": JSON.stringify({ userId: CALLER, scopes: [] }),
  "content-type": "application/json",
});

const call = (
  app: Hono,
  method: "POST" | "DELETE",
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> =>
  Promise.resolve(
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  );

test("a comment is created only for the accesses the permission table grants", async () => {
  for (const access of ACCESSES) {
    const world = worldOf(access, []);
    const response = await call(appFor(world), "POST", commentsPath(), asPrincipal(), {
      anchor: ELEMENT_ANCHOR,
      body: "A note",
      expectedRevisionId: REVISION,
    });
    if (access === "reader") {
      assert.equal(response.status, 403, "a reader cannot create a comment");
      assert.deepEqual(await response.json(), { error: "forbidden" }, "the refusal names its reason");
      assert.deepEqual(world.comments, [], "a refused create stores no row");
    } else {
      assert.equal(response.status, 201, `${access} may create a comment`);
      assert.deepEqual(
        world.comments.map((row) => [row.authorId, row.body]),
        [[CALLER, "A note"]],
        "the accepted create stores the caller and the body",
      );
    }
  }
});

test("a root comment lands only on the revision the writer was looking at", async () => {
  const stale = worldOf("owner", []);
  const conflicted = await call(appFor(stale), "POST", commentsPath(), asPrincipal(), {
    anchor: ELEMENT_ANCHOR,
    body: "A note",
    expectedRevisionId: OLDER_REVISION,
  });
  assert.equal(conflicted.status, 409);
  assert.deepEqual(await conflicted.json(), { error: "revision_conflict" }, "the refusal names its reason");
  assert.deepEqual(stale.comments, [], "a conflicted create inserts nothing");

  const unnamed = worldOf("owner", []);
  const missing = await call(appFor(unnamed), "POST", commentsPath(), asPrincipal(), {
    anchor: ELEMENT_ANCHOR,
    body: "A note",
  });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "expected_revision_required" });
  assert.deepEqual(unnamed.comments, [], "a root that names no revision inserts nothing");

  const padded = worldOf("owner", []);
  const normalized = await call(appFor(padded), "POST", commentsPath(), asPrincipal(), {
    anchor: ELEMENT_ANCHOR,
    body: "A note",
    expectedRevisionId: `  ${REVISION}\t`,
  });
  assert.equal(normalized.status, 201, "the contract trims, so a padded current id is the current id");
  assert.deepEqual(
    padded.comments.map((row) => row.revisionId),
    [REVISION],
  );

  const paddedStale = worldOf("owner", []);
  const stillStale = await call(appFor(paddedStale), "POST", commentsPath(), asPrincipal(), {
    anchor: ELEMENT_ANCHOR,
    body: "A note",
    expectedRevisionId: ` ${OLDER_REVISION} `,
  });
  assert.equal(stillStale.status, 409, "trimming does not turn another revision into this one");
  assert.deepEqual(await stillStale.json(), { error: "revision_conflict" });
  assert.deepEqual(paddedStale.comments, [], "a padded stale id inserts nothing");

  const accepted = worldOf("owner", []);
  const created = await call(appFor(accepted), "POST", commentsPath(), asPrincipal(), {
    anchor: ELEMENT_ANCHOR,
    body: "A note",
    expectedRevisionId: REVISION,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(
    accepted.comments.map((row) => [row.revisionId, row.body]),
    [[REVISION, "A note"]],
    "the accepted root is stored against the revision the writer named",
  );

  const replyWorld = worldOf("owner");
  const reply = await call(appFor(replyWorld), "POST", commentsPath(), asPrincipal(), {
    body: "A reply",
    parentId: THREAD,
    expectedRevisionId: OLDER_REVISION,
  });
  assert.equal(reply.status, 201, "a reply is exempt: even a stale identity does not refuse it");
  assert.deepEqual(
    replyWorld.comments.map((row) => [row.parentId, row.revisionId]),
    [
      [null, REVISION],
      [THREAD, null],
    ],
    "and the reply stores no revision id of its own",
  );
});

test("a thread is resolved only for the accesses the permission table grants", async () => {
  for (const access of ACCESSES) {
    const world = worldOf(access);
    const response = await call(appFor(world), "POST", threadPath("resolve"), asPrincipal());
    if (access === "reader") {
      assert.equal(response.status, 403, "a reader cannot resolve a thread");
      assert.deepEqual(await response.json(), { error: "forbidden" }, "the refusal names its reason");
      assert.equal(world.comments[0]?.resolvedAt, null, "a refused resolve leaves the thread open");
    } else {
      assert.equal(response.status, 200, `${access} may resolve a thread`);
      assert.notEqual(world.comments[0]?.resolvedAt, null, "the accepted resolve closes the thread");
    }
  }
});

test("an author deletes their own thread under every access", async () => {
  for (const access of ACCESSES) {
    const world = worldOf(access, [thread(CALLER)]);
    const response = await call(appFor(world), "DELETE", threadPath(), asPrincipal());
    assert.equal(response.status, 200, `${access} keeps delete on their own thread`);
    assert.deepEqual(world.comments, [], `${access} deletes the row`);
  }
});

test("only the owner deletes a thread somebody else wrote", async () => {
  for (const access of ACCESSES) {
    const world = worldOf(access, [thread(OTHER)]);
    const response = await call(appFor(world), "DELETE", threadPath(), asPrincipal());
    if (access === "owner") {
      assert.equal(response.status, 200, "the owner may delete another author's thread");
      assert.deepEqual(world.comments, [], "the owner's delete removes the row");
    } else {
      assert.equal(response.status, 403, `${access} cannot delete another author's thread`);
      assert.deepEqual(await response.json(), { error: "forbidden" }, "the refusal names its reason");
      assert.equal(world.comments.length, 1, "a refused delete keeps the thread");
    }
  }
});

test("a cookie delete is guarded by origin and JSON content type, and succeeds once both hold", async () => {
  const noOrigin = worldOf("owner");
  const missing = await call(appFor(noOrigin, false), "DELETE", threadPath(), { cookie: "session=one" });
  assert.equal(missing.status, 403, "a cookie mutation without Origin is refused");
  assert.deepEqual(await missing.json(), { error: "origin_not_allowed" }, "the refusal names the origin");
  assert.equal(noOrigin.comments.length, 1, "the refused delete keeps the thread");

  const foreign = worldOf("owner");
  const elsewhere = await call(appFor(foreign, false), "DELETE", threadPath(), {
    cookie: "session=one",
    origin: "https://elsewhere.test",
    "content-type": "application/json",
  });
  assert.equal(elsewhere.status, 403, "a cookie mutation from another origin is refused");
  assert.deepEqual(await elsewhere.json(), { error: "origin_not_allowed" });
  assert.equal(foreign.comments.length, 1, "the refused delete keeps the thread");

  const plain = worldOf("owner");
  const textPlain = await call(appFor(plain, false), "DELETE", threadPath(), {
    cookie: "session=one",
    origin: ORIGIN,
    "content-type": "text/plain",
  });
  assert.equal(textPlain.status, 415, "a cookie mutation must declare JSON");
  assert.deepEqual(await textPlain.json(), { error: "json_content_type_required" }, "the refusal names the type");
  assert.equal(plain.comments.length, 1, "the refused delete keeps the thread");

  const json = worldOf("owner");
  const accepted = await call(appFor(json, false), "DELETE", threadPath(), {
    cookie: "session=one",
    origin: ORIGIN,
    "content-type": "application/json",
  });
  assert.equal(accepted.status, 200, "the viewer's JSON delete is accepted, not refused with 415");
  assert.deepEqual(await accepted.json(), { id: THREAD }, "the deleted thread is named back");
  assert.deepEqual(json.comments, [], "the accepted delete removes the row");
});
