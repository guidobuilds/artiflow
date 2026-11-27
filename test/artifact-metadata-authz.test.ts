import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Hono } from "hono";

import { artifacts, artifactRevisions } from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { createLibraryApp, type LibraryOptions } from "../apps/api/src/routes/library.ts";
import { artifactBar } from "../apps/api/src/viewer/chrome/bar.ts";
import { escapeJsonText } from "../apps/api/src/viewer/chrome/theme.ts";

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const ID = "11111111-1111-4111-8111-111111111111";
const REV = "55555555-5555-4555-8555-555555555555";
const ORIGIN = "http://localhost";
const JSONH = { origin: ORIGIN, "content-type": "application/json" };
const REVISION_COUNT = 4;

type Write = { table: string; keys: string[] };
type Store = {
  title: string;
  ownerId: string;
  deletedAt: Date | null;
  writes: Write[];
  ops: string[];
};

const store = (patch: Partial<Store> = {}): Store => ({
  title: "Pricing artifact",
  ownerId: OWNER,
  deletedAt: null,
  writes: [],
  ops: [],
  ...patch,
});

const NAMES = new Map<unknown, string>([
  [artifacts, "artifacts"],
  [artifactRevisions, "artifactRevisions"],
]);

const tableName = (table: unknown, operation: string): string => {
  const name = NAMES.get(table);
  if (name === undefined) throw new Error(`an unexpected table reached ${operation}`);
  return name;
};

const rowsFor = (held: Store, viewer: string, tables: ReadonlySet<string>): unknown[] => {
  if (tables.has("artifactRevisions")) return [{ revisionCount: REVISION_COUNT }];
  if (tables.has("artifacts") && held.ownerId === viewer)
    return [{ currentRevisionId: REV, deletedAt: held.deletedAt }];
  return [];
};

type Query = Promise<unknown[]> & {
  from: (table: unknown) => Query;
  leftJoin: (table: unknown) => Query;
  innerJoin: (table: unknown) => Query;
  where: () => Query;
  orderBy: () => Query;
  limit: () => Query;
  for: () => Query;
  $dynamic: () => Query;
};

const selectChain = (held: Store, viewer: string): Query => {
  const tables = new Set<string>();
  const query = Object.assign(
    Promise.resolve().then(() => {
      held.ops.push(`read:${[...tables].join("+")}`);
      return rowsFor(held, viewer, tables);
    }),
    {
      from: (table: unknown) => {
        tables.add(tableName(table, "from"));
        return query;
      },
      leftJoin: (table: unknown) => {
        tables.add(tableName(table, "leftJoin"));
        return query;
      },
      innerJoin: (table: unknown) => {
        tables.add(tableName(table, "innerJoin"));
        return query;
      },
      where: () => {
        held.ops.push(`where(${tables.size})`);
        return query;
      },
      orderBy: () => query,
      limit: () => query,
      for: () => {
        held.ops.push(`for(${tables.size})`);
        return query;
      },
      $dynamic: () => {
        held.ops.push(`$dynamic(${tables.size})`);
        return query;
      },
    },
  ) as unknown as Query;
  return query;
};

type UpdateQuery = Promise<unknown[]> & {
  set: (values: Record<string, unknown>) => UpdateQuery;
  where: () => UpdateQuery;
  returning: () => UpdateQuery;
};

const updateChain = (held: Store, table: unknown): UpdateQuery => {
  const name = tableName(table, "update");
  const query = Object.assign(
    Promise.resolve().then(() => [{ title: held.title }]),
    {
      set: (values: Record<string, unknown>) => {
        if (name !== "artifacts") throw new Error(`a rename wrote ${name}`);
        const keys = Object.keys(values).sort();
        for (const key of keys) if (!["title", "updatedAt"].includes(key)) throw new Error(`a rename wrote ${key}`);
        held.writes.push({ table: name, keys });
        if (typeof values.title === "string") held.title = values.title;
        return query;
      },
      where: () => query,
      returning: () => query,
    },
  ) as unknown as UpdateQuery;
  return query;
};

const fakeDb = (held: Store, viewer: string): Database => {
  const db = {
    select: () => selectChain(held, viewer),
    update: (table: unknown) => updateChain(held, table),
    insert: () => {
      throw new Error("a rename inserted a row");
    },
    delete: () => {
      throw new Error("a rename deleted a row");
    },
    execute: () => {
      throw new Error("a rename ran raw SQL");
    },
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return { db } as unknown as Database;
};

const forbiddenDb = (): Database =>
  ({
    db: new Proxy(
      {},
      {
        get: (_target, name) => () => {
          throw new Error(`the request reached the database via ${String(name)}`);
        },
      },
    ),
  }) as unknown as Database;

const session = (userId: string | null): LibraryOptions["auth"] =>
  ({
    api: {
      getSession: async () => (userId === null ? null : { user: { id: userId }, session: { id: `session-${userId}` } }),
    },
  }) as unknown as LibraryOptions["auth"];

const storage = (): Storage =>
  ({
    client: {},
    bucket: "unused",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  }) as unknown as Storage;

type Wiring = {
  userId?: string | null;
  origin?: string | null;
  principal?: boolean;
  database?: Database;
  held?: Store;
};
type Reply = { status: number; text: string; json: Record<string, unknown> | null };

const harness = (wiring: Wiring = {}) => {
  const held = wiring.held ?? store();
  const sessionUser = wiring.userId === undefined ? OWNER : wiring.userId;
  const database = wiring.database ?? fakeDb(held, sessionUser ?? "nobody");
  const origin = wiring.origin === undefined ? ORIGIN : wiring.origin;
  const app = new Hono();
  app.route(
    "/",
    createLibraryApp({
      database,
      auth: session(sessionUser),
      storage: storage(),
      ...(origin === null ? {} : { publicOrigin: origin }),
      ...(wiring.principal === true ? { principal: true as const } : {}),
    }),
  );
  const at = async (
    id: string,
    body: unknown,
    headers: Record<string, string> = JSONH,
    method = "PATCH",
  ): Promise<Reply> => {
    const response = await app.request(`/api/artifacts/${id}/metadata`, {
      method,
      headers: { ...headers, cookie: "session=x" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : null,
    };
  };
  return { at, held };
};

const digestOf = (held: Store): string =>
  createHash("sha256")
    .update(JSON.stringify([held.title, held.ownerId, held.writes]))
    .digest("hex");

test("P1 the guard refuses the same seats the other cookie mutations refuse, before any write", async () => {
  const seats: Array<[string, Record<string, string>, number, string]> = [
    ["missing origin", { "content-type": "application/json" }, 403, "origin_not_allowed"],
    [
      "foreign origin",
      { origin: "http://evil.example", "content-type": "application/json" },
      403,
      "origin_not_allowed",
    ],
    [
      "origin with a trailing slash",
      { origin: "http://localhost/", "content-type": "application/json" },
      403,
      "origin_not_allowed",
    ],
    ["uppercase scheme", { origin: "HTTP://localhost", "content-type": "application/json" }, 403, "origin_not_allowed"],
    ["text/plain body", { origin: ORIGIN, "content-type": "text/plain" }, 415, "json_content_type_required"],
    ["no content type", { origin: ORIGIN }, 415, "json_content_type_required"],
  ];
  for (const [label, headers, status, error] of seats) {
    const { at, held } = harness();
    const before = digestOf(held);
    const reply = await at(ID, { title: "New" }, headers);
    assert.deepEqual([label, reply.status, reply.json], [label, status, { error }], label);
    assert.equal(digestOf(held), before, `${label} changed nothing`);
  }
});

test("P2 the guard answers before the session is read, and a guarded guest gets one answer", async () => {
  const guest = harness({ userId: null });
  const unguarded = await guest.at(ID, { title: "New" }, { "content-type": "application/json" });
  assert.deepEqual(
    [unguarded.status, unguarded.json],
    [403, { error: "origin_not_allowed" }],
    "a guest with no origin learns only the guard's answer",
  );
  const guarded = await guest.at(ID, { title: "New" });
  assert.deepEqual([guarded.status, guarded.json], [401, { error: "unauthorized" }]);
  assert.deepEqual(guest.held.writes, [], "and nothing was written");
});

test("P3 a bearer request never renames, not even on the principal mount", async () => {
  for (const principal of [false, true]) {
    const { at, held } = harness({ userId: null, principal });
    const reply = await at(ID, { title: "New" }, { ...JSONH, authorization: "Bearer a-token" });
    assert.deepEqual(
      [principal, reply.status, reply.json],
      [principal, 401, { error: "unauthorized" }],
      `principal=${principal}: a bearer token is not a renaming session`,
    );
    assert.deepEqual(held.writes, []);
  }
});

test("P4 a foreign, a deleted and an absent artifact are one answer and reach no write", async () => {
  const foreign = harness({ userId: STRANGER });
  const gone = harness({ held: store({ deletedAt: new Date("2026-01-01T00:00:00.000Z") }) });
  const missing = harness({ held: store({ ownerId: "user-someone-else" }) });
  const replies = {
    foreign: await foreign.at(ID, { title: "Mine" }),
    deleted: await gone.at(ID, { title: "Mine" }),
    nonexistent: await missing.at(ID, { title: "Mine" }),
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(replies).map(([label, reply]) => [label, [reply.status, reply.json]])),
    {
      foreign: [404, { error: "not_found" }],
      deleted: [404, { error: "not_found" }],
      nonexistent: [404, { error: "not_found" }],
    },
    "a stranger cannot tell an artifact they do not own from one that never existed, nor from a deleted one",
  );
  assert.deepEqual([foreign.held.writes, gone.held.writes], [[], []], "and no refusal stored anything");
});

test("P5 a malformed id is refused before the database is touched", async () => {
  const lettered = "11111111-1111-4111-8111-11111111111a";
  for (const id of [
    "not-a-uuid",
    `${lettered}G`,
    lettered.toUpperCase(),
    ` ${lettered}`,
    `${lettered}/metadata`,
    "1",
  ]) {
    const { at } = harness({ database: forbiddenDb() });
    const reply = await at(encodeURIComponent(id), { title: "New" });
    assert.deepEqual([id, reply.status, reply.json], [id, 404, { error: "not_found" }], `id ${id}`);
  }
});

test("P6 a body cannot smuggle a field into the mutation", async () => {
  const { at, held } = harness();
  const reply = await at(ID, {
    title: "Smuggled",
    kind: "markdown",
    ownerId: "user-victim",
    id: "99999999-9999-4999-8999-999999999999",
    artifactId: "99999999-9999-4999-8999-999999999999",
    revisionId: "88888888-8888-4888-8888-888888888888",
    currentRevisionId: "88888888-8888-4888-8888-888888888888",
    deletedAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    access: "owner",
    revisions: [{ revision: 99 }],
  });
  assert.deepEqual(
    [reply.status, reply.json],
    [200, { artifactId: ID, title: "Smuggled", currentRevisionId: REV, revisionCount: REVISION_COUNT }],
  );
  assert.deepEqual(held.writes, [{ table: "artifacts", keys: ["title", "updatedAt"] }], "only the title and its stamp");
  assert.deepEqual([held.title, held.ownerId, held.deletedAt], ["Smuggled", OWNER, null], "nothing else moved");
});

test("P7 titles are refused or stored verbatim, never half-applied", async () => {
  const cases: Array<[string, unknown, number, string | undefined]> = [
    ["empty", "", 400, "title_required"],
    ["spaces", "   \n\t ", 400, "title_required"],
    ["null", null, 400, "title_required"],
    ["a number", 42, 400, "title_required"],
    ["an object", { title: "x" }, 400, "title_required"],
    ["an array", ["x"], 400, "title_required"],
    ["missing", undefined, 400, "title_required"],
    ["200 chars", "a".repeat(200), 200, undefined],
    ["201 chars", "a".repeat(201), 400, "title_too_long"],
    ["5000 chars", "a".repeat(5000), 400, "title_too_long"],
    ["201 chars padded to trim to 200", `  ${"a".repeat(200)}  `, 200, undefined],
    ["combining mark only", "\u0301", 200, undefined],
    ["zero width space", "\u200b", 200, undefined],
    ["script close", "</script><script>alert(1)</script>", 200, undefined],
    ["emoji counts code units", "\ud83d\ude42".repeat(200), 400, "title_too_long"],
  ];
  for (const [label, title, status, error] of cases) {
    const { at, held } = harness();
    const before = digestOf(held);
    const reply = await at(ID, { title });
    assert.equal(reply.status, status, `${label} status`);
    if (error === undefined) {
      assert.equal(reply.json?.title, String(title).trim(), `${label} is stored verbatim, trimmed`);
      assert.deepEqual(held.writes, [{ table: "artifacts", keys: ["title", "updatedAt"] }], `${label} wrote once`);
    } else {
      assert.deepEqual(reply.json, { error }, `${label} names its rule`);
      assert.equal(digestOf(held), before, `${label} changed nothing`);
    }
  }
});

test("P8 an over-cap, an unparseable and an empty body are refused without a write", async () => {
  const { at, held } = harness();
  const before = digestOf(held);
  const huge = await at(ID, { title: "x".repeat(3 * 1024 * 1024), padding: "y".repeat(1024 * 1024) });
  assert.deepEqual([huge.status, huge.json], [413, { error: "too_large" }], "a huge body is refused at the cap");
  const declared = await at(ID, JSON.stringify({ title: "New" }), {
    ...JSONH,
    "content-length": String(5 * 1024 * 1024),
  });
  assert.deepEqual(
    [declared.status, declared.json],
    [413, { error: "too_large" }],
    "a body that declares itself over the cap is refused before it is read",
  );
  const broken = await at(ID, "{not json");
  assert.deepEqual([broken.status, broken.json], [400, { error: "title_required" }]);
  const empty = await at(ID, "");
  assert.deepEqual([empty.status, empty.json], [400, { error: "title_required" }]);
  assert.equal(digestOf(held), before, "nothing was written");
});

test("P9 the answer is the contract's own shape and names the persisted title", async () => {
  const { at } = harness();
  const reply = await at(ID, { title: "  Padded title  " });
  assert.deepEqual(Object.keys(reply.json ?? {}).sort(), ["artifactId", "currentRevisionId", "revisionCount", "title"]);
  assert.equal(reply.json?.title, "Padded title", "the answer carries the trimmed, persisted title");
});

test("P10 without a configured origin the mutation is not mounted at all", async () => {
  const { at } = harness({ origin: null, database: forbiddenDb() });
  const reply = await at(ID, { title: "New" });
  assert.deepEqual([reply.status, reply.json], [405, { error: "method_not_allowed" }]);
});

test("P11 a hostile stored title leaves the bar and the island payload escaped", () => {
  const hostile = "</script><script>alert(1)</script>";
  const bar = artifactBar({ chrome: "full", meta: { title: hostile, version: 3 } });
  assert.equal(bar.includes("<script>alert(1)</script>"), false, "the bar never emits the raw tag");
  assert.match(bar, /&lt;\/script&gt;/);
  const embedded = escapeJsonText(JSON.stringify({ id: ID, title: hostile, kind: "html" }));
  assert.equal(embedded.includes("</script"), false, "the island's JSON data block cannot be closed by a title");
});

test("P12 the same rename twice stays a title write, and a rename never allocates a revision", async () => {
  const { at, held } = harness({ held: store({ title: "old" }) });
  const first = await at(ID, { title: "same" });
  const second = await at(ID, { title: "same" });
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.deepEqual(held.writes, [
    { table: "artifacts", keys: ["title", "updatedAt"] },
    { table: "artifacts", keys: ["title", "updatedAt"] },
  ]);
  assert.deepEqual(
    held.ops.filter((op) => op.startsWith("read:artifactRevisions")),
    ["read:artifactRevisions", "read:artifactRevisions"],
    "each answer counts the revisions it did not create",
  );
});
