import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Hono } from "hono";

import {
  ARTIFACT_TITLE_LIMIT,
  artifactMetadataUpdateResponseSchema,
  createArtifactRequestSchema,
  titleProblem,
} from "@artiflow/contracts/artifacts";

import {
  artifacts,
  artifactComments,
  artifactPublicLinks,
  artifactRevisions,
  artifactShares,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { createLibraryApp, type LibraryOptions } from "../apps/api/src/routes/library.ts";
import { createShareViewerApp } from "../apps/api/src/routes/sharing.ts";

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const ARTIFACT = "11111111-1111-4111-8111-111111111111";
const REVISION = "55555555-5555-4555-8555-555555555555";
const REVISION_NUMBER = 3;
const TOKEN = "a".repeat(43);
const TITLE = "Pricing artifact";
const RENAMED = "Pricing artifact v2";
const ORIGIN = "http://localhost";
const HTML = `<!doctype html><html><body><h1>Pinned</h1></body></html>`;
const BYTES = new TextEncoder().encode(HTML);
const DIGEST = createHash("sha256").update(BYTES).digest("hex");
const STORAGE_KEY = newRevisionStorageKey();
const AT = new Date("2026-01-01T00:00:00.000Z");
const MUTATION = { origin: ORIGIN, "content-type": "application/json" };

const ANCHOR = { kind: "element", selector: "#hero", textHint: "Hero", point: { x: 0.5, y: 0.5 }, viewportWidth: 1200 };

const COMMENT = {
  id: "comment-one",
  artifactId: ARTIFACT,
  authorId: OWNER,
  authorName: "Owner",
  authorImage: null,
  parentId: null,
  anchor: ANCHOR,
  body: "please check the wording",
  resolvedAt: null,
  resolvedBy: null,
  revisionId: REVISION,
  createdAt: AT,
  updatedAt: AT,
};

type Write = { table: string; keys: string[] };
type Store = { ownerId: string; title: string | null; revisionCount: number; writes: Write[] };

const store = (title: string | null = TITLE): Store => ({
  ownerId: OWNER,
  title,
  revisionCount: 1,
  writes: [],
});

const artifactRow = (held: Store): Record<string, unknown> => ({
  id: ARTIFACT,
  artifactId: ARTIFACT,
  ownerId: held.ownerId,
  title: held.title,
  kind: "html",
  createdAt: AT,
  updatedAt: AT,
  observedSizeBytes: BYTES.length,
  currentRevisionId: REVISION,
  deletedAt: null,
  revisionId: REVISION,
  revisionNumber: REVISION_NUMBER,
  revisionCount: held.revisionCount,
  sha256: DIGEST,
  sizeBytes: BYTES.length,
  storageKey: STORAGE_KEY,
  showComments: false,
  access: "owner",
  revokedAt: null,
  tokenHash: "b".repeat(64),
});

const NAMES = new Map<unknown, string>([
  [artifacts, "artifacts"],
  [artifactRevisions, "artifactRevisions"],
  [artifactShares, "artifactShares"],
  [artifactPublicLinks, "artifactPublicLinks"],
  [artifactComments, "artifactComments"],
]);

const rowsFor = (held: Store, tables: ReadonlySet<string>, viewer: string | null): unknown[] => {
  if (tables.has("artifactComments")) return [COMMENT];
  if (tables.size === 1 && tables.has("artifactRevisions")) return [{ revisionCount: held.revisionCount }];
  const readsArtifact = ["artifactPublicLinks", "artifactRevisions", "artifacts"].some((name) => tables.has(name));
  const visible =
    viewer !== null && (viewer === held.ownerId || tables.has("artifactPublicLinks") || tables.has("artifactShares"));
  return readsArtifact && visible ? [artifactRow(held)] : [];
};

type Query = Promise<unknown[]> & {
  from: (table: unknown) => Query;
  leftJoin: (table: unknown) => Query;
  innerJoin: (table: unknown) => Query;
  where: () => Query;
  orderBy: () => Query;
  limit: () => Query;
  groupBy: () => Query;
  for: () => Query;
  $dynamic: () => Query;
};

const selectChain = (held: Store, viewer: string | null): Query => {
  const tables = new Set<string>();
  const query = Object.assign(
    Promise.resolve().then(() => rowsFor(held, tables, viewer)),
    {
      from: (table: unknown) => {
        tables.add(NAMES.get(table) ?? "other");
        return query;
      },
      leftJoin: (table: unknown) => {
        tables.add(NAMES.get(table) ?? "other");
        return query;
      },
      innerJoin: (table: unknown) => {
        tables.add(NAMES.get(table) ?? "other");
        return query;
      },
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      groupBy: () => query,
      for: () => query,
      $dynamic: () => query,
    },
  ) as unknown as Query;
  return query;
};

type UpdateQuery = Promise<unknown[]> & {
  set: (values: Record<string, unknown>) => UpdateQuery;
  where: () => UpdateQuery;
  returning: () => UpdateQuery;
};

const updateChain = (held: Store): UpdateQuery => {
  const query = Object.assign(
    Promise.resolve().then(() => [{ title: held.title }]),
    {
      set: (values: Record<string, unknown>) => {
        held.writes.push({ table: "artifacts", keys: Object.keys(values).sort() });
        if (typeof values.title === "string") held.title = values.title;
        return query;
      },
      where: () => query,
      returning: () => query,
    },
  ) as unknown as UpdateQuery;
  return query;
};

const fakeDb = (held: Store, viewer: string | null): Database => {
  const db = {
    select: () => selectChain(held, viewer),
    update: () => updateChain(held),
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return { db } as unknown as Database;
};

const storage = (): Storage =>
  ({
    client: {
      send: async (command: { constructor: { name: string } }): Promise<unknown> => {
        if (command.constructor.name === "HeadObjectCommand") return { ContentLength: BYTES.length };
        if (command.constructor.name === "GetObjectCommand")
          return {
            Body: (async function* (): AsyncIterable<Uint8Array> {
              yield BYTES;
            })(),
          };
        throw new Error(`unexpected command ${command.constructor.name}`);
      },
    },
    bucket: "test-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  }) as unknown as Storage;

type Session = { userId: string } | null;
const sessionOf = (value: { userId: string } | null): Session => value;

const authFor = (session: Session): LibraryOptions["auth"] =>
  ({
    api: {
      getSession: async () =>
        session === null ? null : { user: { id: session.userId }, session: { id: `session-${session.userId}` } },
    },
  }) as unknown as LibraryOptions["auth"];

type Reply = { status: number; text: string; json: Record<string, unknown> | null };

const harness = (held: Store, session: Session) => {
  const database = fakeDb(held, session?.userId ?? null);
  const files = storage();
  const app = new Hono();
  app.route("/", createShareViewerApp({ database, storage: files }));
  app.route("/", createLibraryApp({ database, auth: authFor(session), storage: files, publicOrigin: ORIGIN }));
  const read = async (path: string, init: RequestInit = {}): Promise<Reply> => {
    const response = await app.request(path, { ...init, headers: { ...init.headers, cookie: "session=one" } });
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : null,
    };
  };
  const rename = (title: unknown, id: string = ARTIFACT): Promise<Reply> =>
    read(`/api/artifacts/${id}/metadata`, {
      method: "PATCH",
      headers: MUTATION,
      body: JSON.stringify({ title }),
    });
  const renameBody = (body: string, headers: Record<string, string> = MUTATION): Promise<Reply> =>
    read(`/api/artifacts/${ARTIFACT}/metadata`, { method: "PATCH", headers, body });
  return { read, rename, renameBody };
};

const detailOf = async (read: Reply): Promise<Record<string, unknown>> => {
  assert.equal(read.status, 200, "the detail resolves");
  assert.notEqual(read.json, null);
  return read.json as Record<string, unknown>;
};

test("the owner's rename changes the title and leaves the revision, the link and the thread alone", async () => {
  const held = store();
  const { read, rename } = harness(held, sessionOf({ userId: OWNER }));

  const before = await detailOf(await read(`/api/artifacts/${ARTIFACT}`));
  const linkBefore = await read(`/share/${TOKEN}?meta=1`);
  const pageBefore = await read(`/share/${TOKEN}`);
  const threadsBefore = await read(`/artifact/${ARTIFACT}/comments`);
  assert.deepEqual(
    [before.title, linkBefore.status, pageBefore.status, threadsBefore.status],
    [TITLE, 200, 200, 200],
    "the artifact, its link and its thread resolve before the rename",
  );

  const reply = await rename(RENAMED);
  assert.equal(reply.status, 200, "the owner's rename is accepted");
  assert.deepEqual(
    reply.json,
    { artifactId: ARTIFACT, title: RENAMED, currentRevisionId: REVISION, revisionCount: 1 },
    "the answer names the persisted title and the untouched pointer",
  );
  assert.deepEqual(
    artifactMetadataUpdateResponseSchema.parse(reply.json),
    reply.json,
    "and it is the metadata contract's own shape",
  );

  const after = await detailOf(await read(`/api/artifacts/${ARTIFACT}`));
  assert.equal(after.title, RENAMED, "the detail carries the new title");
  assert.deepEqual(after.revision, before.revision, "the revision number and sha are identical");
  assert.deepEqual(
    after.revision,
    { id: REVISION, revisionNumber: REVISION_NUMBER, sha256: DIGEST, sizeBytes: BYTES.length },
    "the revision of record is the one that was there before the rename",
  );

  const listed = (await read("/api/artifacts")).json?.artifacts as Record<string, unknown>[];
  assert.deepEqual(
    listed.map((row) => [row.id, row.title, row.currentRevisionId, row.sha256]),
    [[ARTIFACT, RENAMED, REVISION, DIGEST]],
    "the library listing carries the new title and the same revision",
  );

  const linkAfter = await read(`/share/${TOKEN}?meta=1`);
  assert.deepEqual(linkAfter.json, linkBefore.json, "the share link still resolves to the same revision");
  const pageAfter = await read(`/share/${TOKEN}`);
  assert.deepEqual([pageAfter.status, pageAfter.text], [200, pageBefore.text], "and still serves the same bytes");

  const threadsAfter = await read(`/artifact/${ARTIFACT}/comments`);
  assert.deepEqual(threadsAfter.json, threadsBefore.json, "the comment thread is still attached and readable");
  assert.deepEqual(
    ((threadsAfter.json?.threads ?? []) as Record<string, unknown>[]).map((thread) => thread.id),
    ["comment-one"],
    "the stored thread is the one the page had",
  );

  assert.deepEqual(
    held.writes,
    [{ table: "artifacts", keys: ["title", "updatedAt"] }],
    "the rename wrote the title and nothing else: no revision row, no counter, no pointer",
  );
  assert.equal(held.revisionCount, 1, "and it allocated no revision");
});

test("a stranger, a guest and a malformed id are refused and store nothing", async () => {
  const held = store();
  const stranger = harness(held, sessionOf({ userId: STRANGER }));
  const refused = await stranger.rename(RENAMED);
  assert.deepEqual([refused.status, refused.json], [404, { error: "not_found" }], "a non-owner is refused");

  const guest = harness(held, null);
  const anonymous = await guest.rename(RENAMED);
  assert.deepEqual([anonymous.status, anonymous.json], [401, { error: "unauthorized" }], "a guest is refused");

  const owner = harness(held, sessionOf({ userId: OWNER }));
  const malformed = await owner.rename(RENAMED, "not-a-uuid");
  assert.deepEqual([malformed.status, malformed.json], [404, { error: "not_found" }], "a malformed id is a 404");

  assert.deepEqual([held.title, held.writes], [TITLE, []], "no refusal stored anything");
});

test("a blank or over-long title is refused and stores nothing", async () => {
  const held = store();
  const { rename } = harness(held, sessionOf({ userId: OWNER }));
  const replies: Array<[string, Reply]> = [
    ["empty", await rename("")],
    ["whitespace", await rename("   \n\t ")],
    ["missing", await rename(undefined)],
    ["not text", await rename(42)],
    ["over-long", await rename("x".repeat(201))],
  ];
  assert.deepEqual(
    replies.map(([label, reply]) => [label, reply.status, reply.json?.error]),
    [
      ["empty", 400, "title_required"],
      ["whitespace", 400, "title_required"],
      ["missing", 400, "title_required"],
      ["not text", 400, "title_required"],
      ["over-long", 400, "title_too_long"],
    ],
    "every refusal names the rule it broke",
  );
  assert.deepEqual([held.title, held.writes], [TITLE, []], "a refused title stores nothing");

  const trimmed = await rename("  Spaced title  ");
  assert.deepEqual([trimmed.status, trimmed.json?.title], [200, "Spaced title"], "the stored title is trimmed");
  const capped = await rename("y".repeat(200));
  assert.deepEqual([capped.status, capped.json?.title], [200, "y".repeat(200)], "the cap is 200 characters");
  assert.deepEqual(
    held.writes.map((write) => write.keys),
    [
      ["title", "updatedAt"],
      ["title", "updatedAt"],
    ],
    "only the two accepted renames reached the store",
  );
});

const BODY_CAP = 64 * 1024;

const padded = (bytes: number): string => {
  const base = JSON.stringify({ title: "Padded", pad: "" });
  return JSON.stringify({ title: "Padded", pad: "p".repeat(Math.max(0, bytes - base.length)) });
};

test("a body past the metadata cap is refused before it is parsed, and stores nothing", async () => {
  const held = store();
  const { rename, renameBody } = harness(held, sessionOf({ userId: OWNER }));

  const declared = await renameBody(JSON.stringify({ title: RENAMED }), {
    ...MUTATION,
    "content-length": String(3 * 1024 * 1024),
  });
  assert.deepEqual(
    [declared.status, declared.json],
    [413, { error: "too_large" }],
    "a declared oversized body is refused without being read",
  );

  const undeclared = await renameBody(padded(BODY_CAP + 1));
  assert.deepEqual(
    [undeclared.status, undeclared.json],
    [413, { error: "too_large" }],
    "a body that arrives without a declared length is still refused",
  );

  const wide = await renameBody(JSON.stringify({ title: RENAMED, pad: "\u00e9".repeat(BODY_CAP / 2 + 1) }));
  assert.deepEqual(
    [wide.status, wide.json],
    [413, { error: "too_large" }],
    "the cap counts bytes, not characters: a body under the cap in code units is over it in bytes",
  );

  const inside = await renameBody(padded(BODY_CAP - 64));
  assert.deepEqual([inside.status, inside.json?.title], [200, "Padded"], "a body inside the cap is read and accepted");

  const overLong = await rename("x".repeat(300));
  assert.deepEqual(
    [overLong.status, overLong.json],
    [400, { error: "title_too_long" }],
    "the title rule still applies",
  );

  assert.deepEqual(
    held.writes,
    [{ table: "artifacts", keys: ["title", "updatedAt"] }],
    "only the body inside the cap reached the store",
  );
});

test("one title rule: the wire schemas and the viewer's precheck read one number and one notion of blank", () => {
  assert.equal(ARTIFACT_TITLE_LIMIT, 200, "the cap is stated once, where the wire schemas and the client both read it");
  const wire = (title: string): boolean => createArtifactRequestSchema.safeParse({ text: "x", title }).success;
  assert.deepEqual(
    [wire("a".repeat(200)), wire("a".repeat(201)), wire("a"), wire("")],
    [true, false, true, false],
    "the create schema refuses exactly what the limit says",
  );
  assert.deepEqual(
    ["", "   \n\t ", "\u200b"].map((title) => titleProblem(title)),
    ["empty", "empty", null],
    "one notion of blank: nothing but whitespace is blank, a zero-width space is a title",
  );
  assert.deepEqual(
    ["a".repeat(200), "a".repeat(201), "  padded  ", "  " + "a".repeat(200) + "  "].map((title) => titleProblem(title)),
    [null, "too_long", null, null],
    "the cap and the blank test both read the trimmed value",
  );
});

test("the route renames through the domain mutation and writes no SQL of its own", () => {
  const source = readFileSync(new URL("../apps/api/src/routes/library.ts", import.meta.url), "utf8");
  const start = source.indexOf('app.patch("/api/artifacts/:id/metadata"');
  assert.notEqual(start, -1, "the metadata endpoint is registered");
  const handler = source.slice(start, source.indexOf("app.delete(", start));
  assert.match(handler, /renameArtifact\(db, \{/, "the route reuses the domain's metadata mutation");
  assert.equal(/\.update\(/.test(handler), false, "and writes no update of its own");
  assert.equal(/\.insert\(/.test(handler), false, "and creates no row");
  assert.match(handler, /ownerId/, "the mutation is scoped to the session user");
});
