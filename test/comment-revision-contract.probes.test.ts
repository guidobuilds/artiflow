import assert from "node:assert/strict";
import { test } from "node:test";

import { Hono } from "hono";

import {
  artifactComments,
  artifactRevisions,
  artifacts,
  artifactShares,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { createCommentsApp } from "../apps/api/src/routes/comments.ts";

const ARTIFACT = "11111111-1111-4111-8111-111111111111";
const CALLER = "22222222-2222-4222-8222-222222222222";
const THREAD = "44444444-4444-4444-8444-444444444444";
const CURRENT = "55555555-5555-4555-8555-55555555ab55";
const STALE = "77777777-7777-4777-8777-777777777777";
const ELSEWHERE = "88888888-8888-4888-8888-888888888888";
const MISSING_PARENT = "99999999-9999-4999-8999-999999999999";
const ANCHOR = { kind: "element", selector: "p", point: { x: 0.5, y: 0.5 }, textHint: "Pricing", viewportWidth: 800 };

type Row = Record<string, unknown>;
type World = { access: string; hasRevision: boolean; rows: Row[] };

const threadRow = (parentId: string | null, authorId = CALLER): Row => ({
  id: THREAD,
  artifactId: ARTIFACT,
  authorId,
  authorName: "Other",
  authorImage: null,
  parentId,
  anchor: ANCHOR,
  body: "parent",
  resolvedAt: null,
  resolvedBy: null,
  revisionId: CURRENT,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

type Chain = Promise<unknown[]> & {
  leftJoin: () => Chain;
  innerJoin: () => Chain;
  where: () => Chain;
  orderBy: () => Chain;
  limit: () => Chain;
  for: () => Chain;
  $dynamic: () => Chain;
};

function databaseFor(world: World): Database {
  const select = () => ({
    from: (table: unknown) => {
      const joins = new Set<unknown>();
      const read = (): unknown[] => {
        if (table === artifacts && joins.has(artifactShares))
          return [{ id: ARTIFACT, ownerId: CALLER, kind: "html", access: world.access, deletedAt: null }];
        if (table === artifacts && joins.has(artifactRevisions))
          return world.hasRevision ? [{ id: CURRENT, storageKey: "revisions/one", sha256: "a".repeat(64) }] : [];
        if (table === artifactComments) return [...world.rows];
        return [];
      };
      const node = Object.assign(Promise.resolve().then(read), {
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
      }) as unknown as Chain;
      return node;
    },
  });
  const insert = () => ({
    values: (values: Row) => ({
      returning: () => {
        const id = `new-${world.rows.length}`;
        world.rows.push({
          ...threadRow(null),
          id,
          authorId: values.authorId,
          parentId: values.parentId,
          anchor: values.anchor,
          revisionId: values.revisionId,
          body: values.body,
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
  return { db } as unknown as Database;
}

const appFor = (world: World) => {
  const app = new Hono();
  app.route(
    "/",
    createCommentsApp({
      database: databaseFor(world),
      auth: { api: { getSession: async () => ({ user: { id: CALLER } }) } } as never,
      storage: {} as never,
      publicOrigin: "https://app.test",
      principal: true,
    }),
  );
  return app;
};

const HEADERS = {
  "x-artiflow-principal": JSON.stringify({ userId: CALLER, scopes: [] }),
  "content-type": "application/json",
};

const post = (world: World, body: unknown): Promise<Response> =>
  Promise.resolve(
    appFor(world).request(`/api/artifacts/${ARTIFACT}/comments`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
    }),
  );

const fresh = (access = "owner"): World => ({ access, hasRevision: true, rows: [] });

test("a blank, missing or non-string revision identity is refused and inserts nothing", async () => {
  for (const value of [undefined, "", "   ", "\t\n", " \n\t ", null, 42, [], {}, true]) {
    const world = fresh();
    const body: Record<string, unknown> = { anchor: ANCHOR, body: "A note" };
    if (value !== undefined) body.expectedRevisionId = value;
    const response = await post(world, body);
    assert.equal(response.status, 400, `${JSON.stringify(value) ?? "undefined"} is not an identity`);
    assert.deepEqual(await response.json(), { error: "expected_revision_required" });
    assert.deepEqual(world.rows, [], `${JSON.stringify(value) ?? "undefined"} inserts nothing`);
  }
});

test("only the current revision lands, padded or not, and every other well-formed one conflicts", async () => {
  const accepted = [CURRENT, ` ${CURRENT} `, `${CURRENT}\t`];
  for (const value of accepted) {
    const world = fresh();
    const response = await post(world, { anchor: ANCHOR, body: "A note", expectedRevisionId: value });
    assert.equal(response.status, 201, `${JSON.stringify(value)} normalizes to the current revision`);
    assert.deepEqual(
      world.rows.map((row) => row.revisionId),
      [CURRENT],
      "the stored revision is the artifact's own, never the padded string",
    );
  }
  for (const value of [STALE, ELSEWHERE, CURRENT.toUpperCase(), ` ${STALE} `]) {
    const world = fresh();
    const response = await post(world, { anchor: ANCHOR, body: "A note", expectedRevisionId: value });
    assert.equal(response.status, 409, `${JSON.stringify(value)} is not the current revision`);
    assert.deepEqual(await response.json(), { error: "revision_conflict" });
    assert.deepEqual(world.rows, [], `${JSON.stringify(value)} inserts nothing`);
  }
});

test("a reply stays exempt whatever identity it carries and stores none", async () => {
  for (const expectedRevisionId of [undefined, STALE, "", CURRENT, "   "]) {
    const world: World = { access: "owner", hasRevision: true, rows: [threadRow(null)] };
    const body: Record<string, unknown> = { body: "A reply", parentId: THREAD };
    if (expectedRevisionId !== undefined) body.expectedRevisionId = expectedRevisionId;
    const response = await post(world, body);
    assert.equal(response.status, 201, `${JSON.stringify(expectedRevisionId) ?? "absent"} on a reply`);
    assert.deepEqual(
      world.rows.slice(1).map((row) => [row.parentId, row.revisionId]),
      [[THREAD, null]],
      "a reply inherits its root's context and stores no revision of its own",
    );
  }
});

test("the refusal ordering and the permission gate report one code each", async () => {
  const cases: Array<[string, World, unknown, number, string]> = [
    ["blank and no anchor", fresh(), { body: "x", expectedRevisionId: "" }, 400, "root_requires_anchor"],
    [
      "blank and a bad anchor",
      fresh(),
      { anchor: { kind: "nope" }, body: "x", expectedRevisionId: "" },
      400,
      "invalid_anchor",
    ],
    ["no anchor and no identity", fresh(), { body: "x" }, 400, "root_requires_anchor"],
    [
      "a reply that still carries an anchor",
      fresh(),
      { anchor: ANCHOR, body: "x", parentId: THREAD, expectedRevisionId: "" },
      400,
      "reply_has_no_anchor",
    ],
    [
      "no current revision",
      { access: "owner", hasRevision: false, rows: [] },
      { anchor: ANCHOR, body: "x", expectedRevisionId: "" },
      409,
      "no_current_revision",
    ],
    ["an unknown parent", fresh(), { body: "x", parentId: MISSING_PARENT }, 404, "comment_not_found"],
    ["a reader", fresh("reader"), { anchor: ANCHOR, body: "x", expectedRevisionId: "" }, 403, "forbidden"],
  ];
  for (const [label, world, body, status, error] of cases) {
    const response = await post(world, body);
    assert.equal(response.status, status, label);
    assert.deepEqual(await response.json(), { error }, label);
    assert.deepEqual(world.rows, [], `${label} inserts nothing`);
  }

  const commenter = fresh("commenter");
  const accepted = await post(commenter, { anchor: ANCHOR, body: "x", expectedRevisionId: CURRENT });
  assert.equal(accepted.status, 201, "a commenter who names the current revision still writes");
  assert.deepEqual(
    commenter.rows.map((row) => row.revisionId),
    [CURRENT],
  );
});
