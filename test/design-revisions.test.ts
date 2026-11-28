import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import { Hono } from "hono";

import {
  artifactComments,
  artifactPublicLinks,
  artifactRevisions,
  artifacts,
  documentDrafts,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import type {
  ArtifactDocumentState,
  DocumentStore,
  DraftRecord,
} from "../apps/api/src/domain/documents/service.ts";
import { createEditingApp, type EditingOptions } from "../apps/api/src/routes/editing.ts";
import { createLibraryApp, type LibraryOptions } from "../apps/api/src/routes/library.ts";
import { createShareViewerApp, createSharingApp } from "../apps/api/src/routes/sharing.ts";
import { SCENE_FORMAT_VERSION, canonicalScene, type Scene } from "@artiflow/domain/scene";

const ORIGIN = "http://127.0.0.1:5173";
const ARTIFACT = "11111111-1111-4111-8111-111111111111";
const OTHER_ARTIFACT = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const OLD_REVISION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEW_REVISION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RESTORED_REVISION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MISSING_REVISION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FOREIGN_REVISION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LATER_REVISION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const TOKEN = "b".repeat(43);

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const sceneOf = (label: string): Scene => ({
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: "home",
      name: `Home ${label}`,
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      nodes: [{ id: "line", type: "text", x: 10, y: 10, w: 240, h: 40, text: label }],
    },
  ],
});

const BEFORE = sceneOf("Checkout A");
const AFTER = sceneOf("Checkout B");
const BEFORE_BYTES = new TextEncoder().encode(canonicalScene(BEFORE));
const AFTER_BYTES = new TextEncoder().encode(canonicalScene(AFTER));

const storageOf = (objects: Map<string, Uint8Array>): Storage =>
  ({
    client: {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
        const name = command.constructor.name;
        const stored = objects.get(String(command.input.Key ?? ""));
        if (name === "HeadObjectCommand") {
          if (stored === undefined) throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
          return { ContentLength: stored.length };
        }
        if (name === "PutObjectCommand") {
          const body = command.input.Body;
          if (body instanceof Uint8Array) objects.set(String(command.input.Key ?? ""), Uint8Array.from(body));
          return {};
        }
        if (name === "GetObjectCommand") {
          if (stored === undefined) throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
          return {
            Body: (async function* (): AsyncIterable<Uint8Array> {
              yield stored;
            })(),
          };
        }
        throw new Error(`unexpected command ${name}`);
      },
    },
    bucket: "test-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  }) as unknown as Storage;

type Chain = Promise<unknown[]> & {
  leftJoin: () => Chain;
  innerJoin: () => Chain;
  where: (condition?: unknown) => Chain;
  orderBy: () => Chain;
  limit: () => Chain;
  for: () => Chain;
  $dynamic: () => Chain;
};

const chainOf = (read: (conditions: unknown[]) => unknown[]): Chain => {
  const conditions: unknown[] = [];
  const node = Object.assign(Promise.resolve().then(() => read(conditions)), {
    leftJoin: () => node,
    innerJoin: () => node,
    where: (condition?: unknown) => {
      if (condition !== undefined) conditions.push(condition);
      return node;
    },
    orderBy: () => node,
    limit: () => node,
    for: () => node,
    $dynamic: () => node,
  }) as unknown as Chain;
  return node;
};

const textOf = (condition: unknown): string => {
  const parts: string[] = [];
  const walk = (chunk: unknown): void => {
    if (chunk === null || typeof chunk !== "object") return;
    const record = chunk as { queryChunks?: unknown[]; value?: unknown; name?: unknown };
    if (Array.isArray(record.queryChunks)) {
      for (const next of record.queryChunks) walk(next);
      return;
    }
    if (Array.isArray(record.value)) parts.push(record.value.join(""));
    else if (typeof record.name === "string") parts.push(record.name);
  };
  walk(condition);
  return parts.join(" ");
};

type Equality = { column: string; value: unknown };

const equalitiesOf = (condition: unknown): Equality[] => {
  const items: Array<{ column?: string; value?: unknown }> = [];
  const walk = (chunk: unknown): void => {
    if (chunk === null || typeof chunk !== "object") return;
    const record = chunk as { queryChunks?: unknown[]; value?: unknown; name?: unknown };
    if (Array.isArray(record.queryChunks)) {
      for (const next of record.queryChunks) walk(next);
      return;
    }
    if (typeof record.name === "string") {
      items.push({ column: record.name });
      return;
    }
    if (Array.isArray(record.value)) return;
    if ("value" in record) items.push({ value: record.value });
  };
  walk(condition);
  const pairs: Equality[] = [];
  for (let index = 0; index + 1 < items.length; index += 1) {
    const left = items[index];
    const right = items[index + 1];
    if (left?.column === undefined || right === undefined || right.value === undefined) continue;
    pairs.push({ column: left.column, value: right.value });
    index += 1;
  }
  return pairs;
};

const matched = (row: Record<string, unknown>, conditions: unknown[]): boolean =>
  conditions.flatMap(equalitiesOf).every(({ column, value }) => row[column] === value);

const liveOnly = (row: Record<string, unknown>, conditions: unknown[]): boolean => {
  const text = conditions
    .map(textOf)
    .join(" ")
    .replace(/\s+/g, " ");
  if (!/revokedAt is null/i.test(text)) return true;
  return row.revokedAt === null || row.revokedAt === undefined;
};

type World = {
  artifact: Record<string, unknown>;
  revisions: Record<string, unknown>[];
  links: Record<string, unknown>[];
  inserts: Record<string, unknown>[];
  objects: Map<string, Uint8Array>;
};

const revisionRowOf = (input: {
  id: string;
  revisionNumber: number;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  publishedAt: string;
}): Record<string, unknown> => ({
  id: input.id,
  artifactId: ARTIFACT,
  revisionNumber: input.revisionNumber,
  revision: input.revisionNumber,
  storageKey: input.storageKey,
  sha256: input.sha256,
  sizeBytes: input.sizeBytes,
  createdAt: new Date(input.publishedAt),
});

const beforeKey = newRevisionStorageKey();
const afterKey = newRevisionStorageKey();

const worldOf = (input: { kind?: string; bytes?: Uint8Array; revisionCount?: number } = {}): World => {
  const kind = input.kind ?? "canvas";
  const currentBytes = input.bytes ?? AFTER_BYTES;
  const objects = new Map<string, Uint8Array>([
    [beforeKey, BEFORE_BYTES],
    [afterKey, currentBytes],
  ]);
  const artifact = {
    id: ARTIFACT,
    ownerId: OWNER,
    title: "Checkout redesign",
    kind,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T09:00:00.000Z"),
    observedSizeBytes: currentBytes.length,
    currentRevisionId: NEW_REVISION,
    revisionId: NEW_REVISION,
    revisionNumber: 2,
    sha256: digestOf(currentBytes),
    sizeBytes: currentBytes.length,
    storageKey: afterKey,
    publishedSeq: 2,
    access: "owner",
    revisionCount: input.revisionCount ?? 2,
  };
  const revisions = [
    revisionRowOf({
      id: NEW_REVISION,
      revisionNumber: 2,
      storageKey: afterKey,
      sha256: digestOf(currentBytes),
      sizeBytes: currentBytes.length,
      publishedAt: "2026-01-02T09:00:00.000Z",
    }),
    revisionRowOf({
      id: OLD_REVISION,
      revisionNumber: 1,
      storageKey: beforeKey,
      sha256: digestOf(BEFORE_BYTES),
      sizeBytes: BEFORE_BYTES.length,
      publishedAt: "2026-01-01T00:00:00.000Z",
    }),
  ];
  const foreign = {
    ...revisionRowOf({
      id: FOREIGN_REVISION,
      revisionNumber: 7,
      storageKey: newRevisionStorageKey(),
      sha256: digestOf(new TextEncoder().encode("another design")),
      sizeBytes: 14,
      publishedAt: "2025-12-01T00:00:00.000Z",
    }),
    artifactId: OTHER_ARTIFACT,
  };
  return { artifact, revisions: [...revisions, foreign], links: [], inserts: [], objects };
};

const dbOf = (world: World): Database => {
  const rowsFor = (table: unknown, conditions: unknown[]): unknown[] => {
    const keep = (row: Record<string, unknown>): boolean =>
      matched(row, conditions) && liveOnly(row, conditions);
    if (table === artifacts) return [world.artifact].filter(keep);
    if (table === artifactRevisions) return world.revisions.filter(keep);
    if (table === artifactPublicLinks) return world.links.filter(keep);
    if (table === documentDrafts || table === artifactComments) return [];
    return [];
  };
  const database = {
    select: () => ({ from: (table: unknown) => chainOf((conditions) => rowsFor(table, conditions)) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async (): Promise<unknown[]> => {
          const row = { id: randomUUID(), createdAt: new Date(), showComments: false, ...values };
          world.inserts.push(row);
          world.links.push(row);
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => ({
          returning: async (): Promise<unknown[]> => {
            const revokedAt = values.revokedAt instanceof Date ? values.revokedAt : new Date();
            const changed = world.links.filter(
              (row) => matched(row, [condition]) && liveOnly(row, [condition]),
            );
            for (const row of changed) row.revokedAt = revokedAt;
            return changed.map((row) => ({ id: row.id }));
          },
        }),
      }),
    }),
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(database),
  };
  return { db: database } as unknown as Database;
};

const sessionFor = (userId: string | null) =>
  ({ api: { getSession: async () => (userId === null ? null : { user: { id: userId } }) } }) as unknown as LibraryOptions["auth"];

type Reply = { status: number; body: string; json: Record<string, unknown> | null };

const replyOf = async (response: Response): Promise<Reply> => {
  const body = await response.text();
  const type = response.headers.get("content-type") ?? "";
  return { status: response.status, body, json: type.startsWith("application/json") ? JSON.parse(body) : null };
};

const viewerApp = (world: World, userId: string | null = OWNER) => {
  const app = new Hono();
  app.route(
    "/",
    createLibraryApp({
      database: dbOf(world),
      auth: sessionFor(userId),
      storage: storageOf(world.objects),
    } satisfies LibraryOptions),
  );
  return app;
};

const view = async (world: World, path: string, userId: string | null = OWNER): Promise<Reply> =>
  replyOf(await viewerApp(world, userId).request(path, { headers: { cookie: "session=one" } }));

const shareView = async (world: World, path: string): Promise<Reply> =>
  replyOf(
    await (() => {
      const app = new Hono();
      app.route("/", createShareViewerApp({ database: dbOf(world), storage: storageOf(world.objects) }));
      return app.request(path);
    })(),
  );

const sharingAppOf = (world: World) => {
  const app = new Hono();
  app.route("/", createSharingApp({ database: dbOf(world), auth: sessionFor(OWNER), publicOrigin: ORIGIN }));
  return app;
};

const linkRowOf = (
  pinnedRevisionId: string | null,
  revoked = false,
  showComments = false,
): Record<string, unknown> => ({
  id: randomUUID(),
  tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
  artifactId: ARTIFACT,
  showComments,
  pinnedRevisionId,
  revokedAt: revoked ? new Date("2026-01-03T00:00:00.000Z") : null,
  storageKey: afterKey,
  sha256: digestOf(AFTER_BYTES),
  revisionNumber: 2,
  sizeBytes: AFTER_BYTES.length,
  kind: "canvas",
});

test("a requested revision is served only when it belongs to this design", async () => {
  const world = worldOf();

  const older = await view(world, `/artifact/${ARTIFACT}?revision=${OLD_REVISION}`);
  assert.equal(older.status, 200);
  assert.ok(older.body.includes("Checkout A"), "the older publication is what the page renders");
  assert.equal(older.body.includes("Checkout B"), false, "the newest publication is not what the page renders");
  assert.ok(older.body.includes("You are looking at version 1"), "the page says which version it is");
  assert.ok(older.body.includes("The latest publication is version 2."), "and which one is current");
  assert.equal(older.body.includes("const refresh ="), false, "a pinned view never reloads onto a newer publication");

  const missing = await view(world, `/artifact/${ARTIFACT}?revision=${MISSING_REVISION}`);
  assert.equal(missing.status, 404, "a revision that does not exist is not shown");
  assert.equal(missing.body.includes("Checkout A"), false);

  const foreign = await view(world, `/artifact/${ARTIFACT}?revision=${FOREIGN_REVISION}`);
  assert.equal(foreign.status, 404, "a revision of another artifact is not shown");

  const malformed = await view(world, `/artifact/${ARTIFACT}?revision=not-a-revision`);
  assert.equal(malformed.status, 404);

  const stranger = await view(world, `/artifact/${ARTIFACT}?revision=${OLD_REVISION}`, null);
  assert.equal(stranger.status, 401, "the artifact's own permissions gate every revision");

  const current = await view(world, `/artifact/${ARTIFACT}?revision=${NEW_REVISION}`);
  assert.equal(current.status, 200);
  assert.ok(current.body.includes("is the latest publication"), "a requested current revision is still pinned");
  assert.equal(current.body.includes("const refresh ="), false, "and never polls for a newer publication");

  const published = worldOf();
  const laterBytes = new TextEncoder().encode(canonicalScene(sceneOf("Checkout C")));
  const laterKey = newRevisionStorageKey();
  published.objects.set(laterKey, laterBytes);
  published.revisions = [
    revisionRowOf({
      id: LATER_REVISION,
      revisionNumber: 3,
      storageKey: laterKey,
      sha256: digestOf(laterBytes),
      sizeBytes: laterBytes.length,
      publishedAt: "2026-01-03T00:00:00.000Z",
    }),
    ...published.revisions,
  ];
  published.artifact = {
    ...published.artifact,
    currentRevisionId: LATER_REVISION,
    revisionId: LATER_REVISION,
    revisionNumber: 3,
    sha256: digestOf(laterBytes),
    storageKey: laterKey,
    revisionCount: 3,
  };
  const stillPinned = await view(published, `/artifact/${ARTIFACT}?revision=${NEW_REVISION}`);
  assert.equal(stillPinned.status, 200);
  assert.ok(stillPinned.body.includes("Checkout B"), "the requested revision survives a newer publication");
  assert.equal(stillPinned.body.includes("Checkout C"), false);
  assert.equal(stillPinned.body.includes("const refresh ="), false, "and the URL never reloads onto it");

  const latestNow = await view(published, `/artifact/${ARTIFACT}`);
  assert.ok(latestNow.body.includes("Checkout C"), "while the unpinned URL follows the new publication");
  assert.ok(latestNow.body.includes("const refresh ="), "and keeps polling it");
});

test("the design lists its versions so an older one can be reopened", async () => {
  const world = worldOf();
  const page = await view(world, `/artifact/${ARTIFACT}`);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("data-versions-open"), "the versions panel is offered");
  assert.ok(page.body.includes(`?revision=${OLD_REVISION}`), "with a link to the older publication");
  assert.ok(page.body.includes(`?revision=${NEW_REVISION}`), "and to the newest one");

  const single = worldOf({ revisionCount: 1 });
  single.revisions = single.revisions.slice(0, 1);
  assert.ok(page.body.includes('data-island="restore"'), "an editor can restore an older version from the latest view");

  const bare = await view(single, `/artifact/${ARTIFACT}`);
  assert.equal(bare.status, 200);
  assert.equal(bare.body.includes("data-versions-open"), false, "a design with one publication offers no history");
  assert.equal(bare.body.includes("You are looking at version"), false, "and carries no notice");
});

test("comparing two revisions shows the same artboard in A and B, each labelled", async () => {
  const world = worldOf();
  const page = await view(world, `/artifact/${ARTIFACT}/compare?from=${OLD_REVISION}&to=${NEW_REVISION}&frame=home`);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('data-compare-side="A"'), "side A is labelled");
  assert.ok(page.body.includes('data-compare-side="B"'), "side B is labelled");
  assert.ok(page.body.includes("Version 1"), "side A names its revision");
  assert.ok(page.body.includes("Version 2"), "side B names its revision");
  assert.ok(page.body.includes("2026-01-01"), "side A carries its date");
  assert.ok(page.body.includes("2026-01-02"), "side B carries its date");
  assert.ok(page.body.includes("Checkout A"), "the older artboard is rendered");
  assert.ok(page.body.includes("Checkout B"), "the newer artboard is rendered");
  assert.equal(page.body.includes("2026-01-01T00:00:00.000Z"), true, "the date is a real timestamp");

  const missing = await view(world, `/artifact/${ARTIFACT}/compare?from=${OLD_REVISION}&to=${MISSING_REVISION}`);
  assert.equal(missing.status, 404, "a revision that does not exist cannot be compared");

  const foreign = await view(world, `/artifact/${ARTIFACT}/compare?from=${OLD_REVISION}&to=${FOREIGN_REVISION}`);
  assert.equal(foreign.status, 404, "a revision outside this design cannot be compared");

  const unknownFrame = await view(world, `/artifact/${ARTIFACT}/compare?from=${OLD_REVISION}&to=${NEW_REVISION}&frame=nope`);
  assert.equal(unknownFrame.status, 404, "an artboard that either side lacks is not compared");

  const documentPage = worldOf({ kind: "markdown", bytes: new TextEncoder().encode("# Notes\n") });
  const refused = await view(documentPage, `/artifact/${ARTIFACT}/compare?from=${OLD_REVISION}&to=${NEW_REVISION}`);
  assert.equal(refused.status, 409);
  assert.ok(refused.body.includes("Comparison is available for a Design"));
});

test("a pinned link keeps its revision after a newer publication, a latest link follows it", async () => {
  const pinnedWorld = worldOf();
  pinnedWorld.links = [linkRowOf(OLD_REVISION)];
  const pinnedMeta = await shareView(pinnedWorld, `/share/${TOKEN}?meta=1`);
  assert.equal(pinnedMeta.status, 200);
  assert.equal(pinnedMeta.json?.revisionNumber, 1, "the pinned link reports its own revision");
  assert.equal(pinnedMeta.json?.pinned, true);
  const pinnedPage = await shareView(pinnedWorld, `/share/${TOKEN}`);
  assert.equal(pinnedPage.status, 200);
  assert.ok(pinnedPage.body.includes("Checkout A"));
  assert.equal(pinnedPage.body.includes("Checkout B"), false);
  assert.ok(pinnedPage.body.includes("Pinned to version 1"), "the reader understands which version this is");

  const latestWorld = worldOf();
  latestWorld.links = [linkRowOf(null)];
  const latestMeta = await shareView(latestWorld, `/share/${TOKEN}?meta=1`);
  assert.equal(latestMeta.json?.revisionNumber, 2, "the latest link follows the new publication");
  assert.equal("pinned" in (latestMeta.json ?? {}), false, "and is not announced as pinned");
  const latestPage = await shareView(latestWorld, `/share/${TOKEN}`);
  assert.ok(latestPage.body.includes("Checkout B"));
  assert.equal(latestPage.body.includes("Pinned to version"), false);

  const revokedWorld = worldOf();
  revokedWorld.links = [linkRowOf(OLD_REVISION, true)];
  const revoked = await shareView(revokedWorld, `/share/${TOKEN}`);
  assert.equal(revoked.status, 404, "revoking the link cuts access to the pinned revision");

  const orphanWorld = worldOf();
  orphanWorld.links = [linkRowOf(MISSING_REVISION)];
  const orphan = await shareView(orphanWorld, `/share/${TOKEN}`);
  assert.equal(orphan.status, 404, "a pin that no longer resolves never falls back to the latest publication");

  const foreignWorld = worldOf();
  foreignWorld.links = [linkRowOf(FOREIGN_REVISION)];
  const foreign = await shareView(foreignWorld, `/share/${TOKEN}`);
  assert.equal(foreign.status, 404, "a pin to another artifact's revision shows nothing");
});

type StoreWorld = {
  artifact: ArtifactDocumentState;
  draft: DraftRecord | null;
  commits: unknown[];
};

const storeWorldOf = (input: { draftSeq?: number; access?: string } = {}): StoreWorld => ({
  artifact: {
    artifactId: ARTIFACT,
    kind: "canvas",
    publishedSeq: 4,
    currentRevisionId: NEW_REVISION,
    revisionCount: 2,
    latestSnapshot: {
      storageKey: afterKey,
      sha256: digestOf(AFTER_BYTES),
      formatVersion: SCENE_FORMAT_VERSION,
      createdAt: new Date("2026-01-02T09:00:00.000Z"),
    },
  },
  draft: {
    artifactId: ARTIFACT,
    seq: input.draftSeq ?? 4,
    formatVersion: SCENE_FORMAT_VERSION,
    state: { formatVersion: SCENE_FORMAT_VERSION, scene: AFTER },
    updatedByUserId: OWNER,
    updatedAt: new Date("2026-01-02T09:00:00.000Z"),
  },
  commits: [],
});

const storeOf = (world: StoreWorld): DocumentStore => ({
  readArtifact: async () => world.artifact,
  readDraft: async () => world.draft,
  insertDraftIfAbsent: async (record) => {
    world.draft ??= record;
    return world.draft;
  },
  readOperation: async () => null,
  readSnapshotAtOrBefore: async () => null,
  readAppliedOperations: async () => [],
  commitOperation: async () => ({ committed: true }),
  commitSnapshot: async (input) => {
    world.commits.push(input);
    return { committed: true, revisionId: RESTORED_REVISION, revisionNumber: 3 };
  },
});

const restoreApp = (world: World, store: StoreWorld, userId: string | null = OWNER) => {
  const app = new Hono();
  app.route(
    "/",
    createEditingApp({
      database: dbOf(world),
      auth: sessionFor(userId),
      storage: storageOf(world.objects),
      publicOrigin: ORIGIN,
      documentStore: storeOf(store),
    } satisfies EditingOptions),
  );
  return app;
};

const restore = async (
  world: World,
  store: StoreWorld,
  body: Record<string, unknown>,
  input: { revisionId?: string; userId?: string | null } = {},
): Promise<Reply> =>
  replyOf(
    await restoreApp(world, store, input.userId === undefined ? OWNER : input.userId).request(
      `/api/artifacts/${ARTIFACT}/revisions/${input.revisionId ?? OLD_REVISION}/restore`,
      {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", cookie: "session=one" },
        body: JSON.stringify(body),
      },
    ),
  );

test("restoring an older scene publication creates a new revision and keeps the history", async () => {
  const world = worldOf();
  const store = storeWorldOf();
  const revisionsBefore = world.revisions.length;

  const restored = await restore(world, store, { expectedRevisionId: NEW_REVISION });
  assert.equal(restored.status, 200, restored.body);
  assert.equal(restored.json?.revisionNumber, 3, "the restore is a new revision, not a rewrite");
  assert.equal(restored.json?.restoredFrom, OLD_REVISION);
  assert.equal(store.commits.length, 1, "exactly one snapshot was committed");
  const commit = store.commits[0] as { revision: { sha256: string; seqFrom: number; seqTo: number } };
  assert.equal(commit.revision.sha256, digestOf(BEFORE_BYTES), "the new revision carries the old content");
  assert.deepEqual([commit.revision.seqFrom, commit.revision.seqTo], [5, 5]);
  assert.equal(world.revisions.length, revisionsBefore, "no historical revision row was touched");
  assert.equal(store.artifact.revisionCount, 2, "the artifact keeps every revision it had");
});

test("a restore whose expected revision is stale is refused with the current state", async () => {
  const world = worldOf();
  const store = storeWorldOf();

  const raced = await restore(world, store, { expectedRevisionId: MISSING_REVISION });
  assert.equal(raced.status, 409);
  assert.equal(raced.json?.error, "concurrent_edit");
  assert.equal(raced.json?.currentRevisionId, NEW_REVISION, "the refusal names what is current now");
  assert.equal(store.commits.length, 0, "nothing is written when the decision is stale");

  const missingToken = await restore(world, store, {});
  assert.equal(missingToken.status, 400);
  assert.equal(missingToken.json?.error, "expected_revision_id_required");
});

test("a restore is refused while the draft holds unpublished changes", async () => {
  const world = worldOf();
  const store = storeWorldOf({ draftSeq: 9 });
  const refused = await restore(world, store, { expectedRevisionId: NEW_REVISION });
  assert.equal(refused.status, 409);
  assert.equal(refused.json?.error, "restore_pending_changes");
  assert.equal(store.commits.length, 0, "the draft is never overwritten by a restore");
});

test("only an editor of the design can restore, and only its own revisions", async () => {
  const world = worldOf();
  const store = storeWorldOf();
  world.artifact = { ...world.artifact, access: "read" };
  const reader = await restore(world, store, { expectedRevisionId: NEW_REVISION });
  assert.equal(reader.status, 403);
  assert.equal(store.commits.length, 0);

  const ownerWorld = worldOf();
  const missing = await restore(ownerWorld, store, { expectedRevisionId: NEW_REVISION }, { revisionId: MISSING_REVISION });
  assert.equal(missing.status, 404);
  assert.equal(missing.json?.error, "revision_not_found");
  assert.equal(store.commits.length, 0);

  const foreign = await restore(ownerWorld, store, { expectedRevisionId: NEW_REVISION }, { revisionId: FOREIGN_REVISION });
  assert.equal(foreign.status, 404, "a revision of another artifact is never restored here");
  assert.equal(store.commits.length, 0);

  const anonymous = await restore(worldOf(), storeWorldOf(), { expectedRevisionId: NEW_REVISION }, { userId: null });
  assert.equal(anonymous.status, 401);
});

test("an artifact without history or a link keeps exactly the behaviour it had", async () => {
  const markdownBytes = new TextEncoder().encode("# Notes\n\nOne paragraph.\n");
  const world = worldOf({ kind: "markdown", bytes: markdownBytes, revisionCount: 1 });
  world.revisions = world.revisions.slice(0, 1);

  const page = await view(world, `/artifact/${ARTIFACT}`);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("One paragraph."), "the document still renders");
  assert.equal(page.body.includes("vnotice"), false, "no revision notice is invented");
  assert.equal(page.body.includes("data-versions-open"), false, "and no versions panel");

  const link = await (async () => {
    const app = new Hono();
    app.route("/", createSharingApp({ database: dbOf(world), auth: sessionFor(OWNER), publicOrigin: ORIGIN }));
    return replyOf(
      await app.request(`/api/artifacts/${ARTIFACT}/links`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", cookie: "session=one" },
        body: JSON.stringify({}),
      }),
    );
  })();
  assert.equal(link.status, 201, link.body);
  assert.equal(link.json?.pinnedRevisionId, null, "a link without a pin follows the latest publication");
  assert.equal(world.inserts[0]?.pinnedRevisionId, null, "and is stored without a pin");

  const refusal = await (async () => {
    const app = new Hono();
    app.route("/", createSharingApp({ database: dbOf(world), auth: sessionFor(OWNER), publicOrigin: ORIGIN }));
    return replyOf(
      await app.request(`/api/artifacts/${ARTIFACT}/links`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", cookie: "session=one" },
        body: JSON.stringify({ pinnedRevisionId: MISSING_REVISION }),
      }),
    );
  })();
  assert.equal(refusal.status, 404, "a pin outside this artifact is refused");
  assert.equal(refusal.json?.error, "revision_not_found");

  const malformed = await (async () => {
    const app = new Hono();
    app.route("/", createSharingApp({ database: dbOf(world), auth: sessionFor(OWNER), publicOrigin: ORIGIN }));
    return replyOf(
      await app.request(`/api/artifacts/${ARTIFACT}/links`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", cookie: "session=one" },
        body: JSON.stringify({ pinnedRevisionId: "not-a-revision" }),
      }),
    );
  })();
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json?.error, "invalid_revision_id");
  assert.equal(world.inserts.length, 1, "a refused pin never creates a link");
});

test("a pinned link can be created from the design's own revisions", async () => {
  const world = worldOf();
  const created = await (async () => {
    const app = new Hono();
    app.route("/", createSharingApp({ database: dbOf(world), auth: sessionFor(OWNER), publicOrigin: ORIGIN }));
    return replyOf(
      await app.request(`/api/artifacts/${ARTIFACT}/links`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", cookie: "session=one" },
        body: JSON.stringify({ pinnedRevisionId: OLD_REVISION }),
      }),
    );
  })();
  assert.equal(created.status, 201, created.body);
  assert.equal(created.json?.pinnedRevisionId, OLD_REVISION);
  assert.equal(created.json?.pinnedRevisionNumber, 1);
  assert.equal(world.inserts[0]?.pinnedRevisionId, OLD_REVISION, "the pin is stored on the link");
  assert.ok(String(created.json?.url).startsWith(`${ORIGIN}/share/`));
});

test("the versions panel says one older version in the singular and many in the plural", async () => {
  const world = worldOf();
  const older = Array.from({ length: 24 }, (_, index) =>
    revisionRowOf({
      id: randomUUID(),
      revisionNumber: index + 3,
      storageKey: newRevisionStorageKey(),
      sha256: digestOf(BEFORE_BYTES),
      sizeBytes: BEFORE_BYTES.length,
      publishedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  world.revisions = [...older, ...world.revisions];
  world.artifact = { ...world.artifact, revisionCount: 26 };
  const one = await view(world, `/artifact/${ARTIFACT}`);
  assert.equal(one.status, 200);
  assert.ok(one.body.includes("1 older version is in the history"), "one hidden version is singular");
  assert.equal(one.body.includes("1 older versions"), false);

  world.revisions = [
    revisionRowOf({
      id: randomUUID(),
      revisionNumber: 27,
      storageKey: newRevisionStorageKey(),
      sha256: digestOf(BEFORE_BYTES),
      sizeBytes: BEFORE_BYTES.length,
      publishedAt: "2026-01-01T00:00:00.000Z",
    }),
    ...world.revisions,
  ];
  world.artifact = { ...world.artifact, revisionCount: 27 };
  const two = await view(world, `/artifact/${ARTIFACT}`);
  assert.ok(two.body.includes("2 older versions are in the history"), "two hidden versions are plural");
});

test("rotating a pinned link issues a new token, keeps the pin and drops the old token", async () => {
  const world = worldOf();
  const pinned = linkRowOf(OLD_REVISION);
  world.links = [pinned];
  const rotated = await replyOf(
    await sharingAppOf(world).request(`/api/artifacts/${ARTIFACT}/links/${String(pinned.id)}/rotate`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie: "session=one" },
    }),
  );
  assert.equal(rotated.status, 201, rotated.body);
  assert.equal(rotated.json?.pinnedRevisionId, OLD_REVISION, "the rotated link stays pinned to the same revision");
  const token = String(rotated.json?.token);
  assert.equal(token.length, 43);
  assert.notEqual(token, TOKEN, "the rotated link carries a new token");
  const created = world.links.find((row) => row.tokenHash === digestOf(new TextEncoder().encode(token)));
  assert.equal(created?.pinnedRevisionId, OLD_REVISION, "the replacement row stores the pin");
  assert.notEqual(pinned.revokedAt, null, "the old row is revoked, never reused");

  const oldToken = await shareView(world, `/share/${TOKEN}`);
  assert.equal(oldToken.status, 404, "the token before the rotation stops working");
  const newToken = await shareView(world, `/share/${token}`);
  assert.equal(newToken.status, 200, "the rotated token serves the pinned revision");
  assert.ok(newToken.body.includes("Checkout A"));
  assert.ok(newToken.body.includes("Pinned to version 1"));
});

test("a link cannot be pinned to a revision of another artifact", async () => {
  const world = worldOf();
  const refused = await replyOf(
    await sharingAppOf(world).request(`/api/artifacts/${ARTIFACT}/links`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie: "session=one" },
      body: JSON.stringify({ pinnedRevisionId: FOREIGN_REVISION }),
    }),
  );
  assert.equal(refused.status, 404, "a foreign revision is never pinned");
  assert.equal(refused.json?.error, "revision_not_found");
  assert.equal(world.inserts.length, 0);
});

test("a pinned link never serves the comments of the latest publication", async () => {
  const world = worldOf();
  world.links = [linkRowOf(OLD_REVISION, false, true)];
  const comments = await shareView(world, `/share/${TOKEN}/comments`);
  assert.equal(comments.status, 404, "the comments endpoint refuses a pinned link");
  const page = await shareView(world, `/share/${TOKEN}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.includes('id="viewer-comments"'), false, "and the page mounts no comments host");
});
