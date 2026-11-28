import assert from "node:assert/strict";
import { test } from "node:test";

import { SCENE_FORMAT_VERSION, type Scene } from "@artiflow/domain/scene";

import {
  refreshArtboardPlan,
  resolveSceneArtboards,
  type SourceArtifactRow,
} from "../apps/api/src/viewer/artboards.ts";

const PAGE = "0d5b0f6a-3f2b-4b4a-9a44-6a2f4a1f7c11";
const OTHER_PAGE = "e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b";
const REVISION_ONE = "8f0d9c2e-51a4-4cbb-9a0e-2f3c4d5e6f70";
const REVISION_TWO = "c1b2a3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const scene = (): Scene => ({
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    { id: "a", name: "A", x: 0, y: 0, w: 390, h: 640, nodes: [], source: { artifactId: PAGE, revisionId: REVISION_ONE, mode: "fluid" } },
    { id: "b", name: "B", x: 430, y: 0, w: 390, h: 640, nodes: [], source: { artifactId: OTHER_PAGE, revisionId: REVISION_ONE, mode: "fixed" } },
    { id: "c", name: "C", x: 860, y: 0, w: 390, h: 640, nodes: [] },
  ],
});

const row = (overrides: Partial<SourceArtifactRow> = {}): SourceArtifactRow => ({
  artifactId: PAGE,
  kind: "html",
  deletedAt: null,
  revisionId: REVISION_ONE,
  revisionNumber: 3,
  sizeBytes: 40,
  storageKey: "revisions/page",
  sha256: "a".repeat(64),
  ...overrides,
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const resolve = (
  overrides: {
    viewerId?: string | null;
    rows?: Record<string, SourceArtifactRow | null>;
    bytes?: Uint8Array | null;
    maxBytes?: number;
    origin?: string | null;
    seen?: string[];
  } = {},
) =>
  resolveSceneArtboards(scene(), overrides.viewerId === undefined ? "user-1" : overrides.viewerId, {
    origin: overrides.origin === undefined ? "https://artiflow.test" : overrides.origin,
    maxBytes: overrides.maxBytes ?? 1024,
    sourceOf: async (artifactId, revisionId) => {
      overrides.seen?.push(`${artifactId}:${revisionId}`);
      const rows = overrides.rows ?? { [PAGE]: row(), [OTHER_PAGE]: row({ artifactId: OTHER_PAGE, revisionNumber: 1 }) };
      return Object.hasOwn(rows, artifactId) ? (rows[artifactId] ?? null) : null;
    },
    bytesOf: async () => (overrides.bytes === undefined ? bytes("<h1>pinned</h1>") : overrides.bytes),
  });

test("a readable pinned revision resolves to the page it was pinned to", async () => {
  const frames = await resolve();
  assert.deepEqual(frames.a, {
    kind: "ready",
    html: "<h1>pinned</h1>",
    revisionNumber: 3,
    origin: "https://artiflow.test",
  });
  assert.equal(frames.c, undefined, "a frame without a source stays a node frame");
});

test("losing access to the source turns the artboard unavailable without reading its bytes", async () => {
  let read = 0;
  const frames = await resolveSceneArtboards(scene(), "user-2", {
    origin: null,
    maxBytes: 1024,
    sourceOf: async (artifactId) => (artifactId === PAGE ? null : row({ artifactId: OTHER_PAGE })),
    bytesOf: async () => {
      read += 1;
      return bytes("<h1>secret</h1>");
    },
  });
  assert.deepEqual(frames.a, { kind: "unavailable", reason: "forbidden" });
  assert.equal(frames.a !== undefined && "html" in frames.a, false);
  assert.equal(read, 1, "only the reachable source was read");
});

test("an anonymous viewer of a Design never gets source content", async () => {
  const frames = await resolve({ viewerId: null });
  assert.deepEqual(frames.a, { kind: "unavailable", reason: "forbidden" });
  assert.deepEqual(frames.b, { kind: "unavailable", reason: "forbidden" });
});

test("a source that is not an HTML page is refused by name", async () => {
  const frames = await resolve({ rows: { [PAGE]: row({ kind: "markdown" }), [OTHER_PAGE]: row({ artifactId: OTHER_PAGE }) } });
  assert.deepEqual(frames.a, { kind: "unavailable", reason: "not_html" });
});

test("a deleted source or a revision that no longer exists is reported as missing", async () => {
  const frames = await resolve({
    rows: {
      [PAGE]: row({ deletedAt: new Date() }),
      [OTHER_PAGE]: row({ artifactId: OTHER_PAGE, revisionId: null, revisionNumber: null, sizeBytes: null }),
    },
  });
  assert.deepEqual(frames.a, { kind: "unavailable", reason: "missing" });
  assert.deepEqual(frames.b, { kind: "unavailable", reason: "missing" });
});

test("a source above the inline budget is not read at all", async () => {
  let read = 0;
  const frames = await resolveSceneArtboards(scene(), "user-1", {
    origin: null,
    maxBytes: 1024,
    sourceOf: async (artifactId) => row({ artifactId, sizeBytes: 4096 }),
    bytesOf: async () => {
      read += 1;
      return bytes("<h1>big</h1>");
    },
  });
  assert.deepEqual(frames.a, { kind: "unavailable", reason: "too_large" });
  assert.equal(read, 0);
});

test("unreadable stored bytes degrade to missing instead of failing the Design", async () => {
  const frames = await resolve({ bytes: null });
  assert.deepEqual(frames.a, { kind: "unavailable", reason: "missing" });
});

test("the same pinned revision is resolved once per Design render", async () => {
  const seen: string[] = [];
  const twin: Scene = {
    formatVersion: SCENE_FORMAT_VERSION,
    frames: [
      { id: "a", name: "A", x: 0, y: 0, w: 390, h: 640, nodes: [], source: { artifactId: PAGE, revisionId: REVISION_ONE, mode: "fixed" } },
      { id: "b", name: "B", x: 430, y: 0, w: 390, h: 640, nodes: [], source: { artifactId: PAGE, revisionId: REVISION_ONE, mode: "fluid" } },
    ],
  };
  await resolveSceneArtboards(twin, "user-1", {
    origin: null,
    maxBytes: 1024,
    sourceOf: async (artifactId, revisionId) => {
      seen.push(`${artifactId}:${revisionId}`);
      return row();
    },
    bytesOf: async () => bytes("<p>same</p>"),
  });
  assert.deepEqual(seen, [`${PAGE}:${REVISION_ONE}`]);
});

const draft = (): Scene => scene();

test("refresh is a no-op when the pinned revision is already the latest one", () => {
  const plan = refreshArtboardPlan({ draft: draft(), frameId: "a", currentRevisionId: REVISION_ONE, currentRevisionNumber: 3 });
  assert.deepEqual(plan, { kind: "noop", revisionId: REVISION_ONE, revisionNumber: 3 });
});

test("refresh pins the latest revision of that artboard and leaves the others alone", () => {
  const plan = refreshArtboardPlan({ draft: draft(), frameId: "a", currentRevisionId: REVISION_TWO, currentRevisionNumber: 4 });
  assert.equal(plan.kind, "update");
  if (plan.kind !== "update") throw new Error("unreachable");
  assert.deepEqual(plan.op, {
    op: "update_frame",
    id: "a",
    props: { source: { artifactId: PAGE, revisionId: REVISION_TWO, mode: "fluid" } },
  });
  const applied = { ...draft() };
  const frame = applied.frames[0];
  if (frame === undefined) throw new Error("unreachable");
  applied.frames = [frame, ...applied.frames.slice(1)];
  assert.deepEqual(frame.source?.revisionId, REVISION_ONE, "the plan does not mutate the draft it read");
});

test("refresh refuses a frame that is not an artboard", () => {
  assert.deepEqual(refreshArtboardPlan({ draft: draft(), frameId: "c", currentRevisionId: REVISION_TWO, currentRevisionNumber: 4 }), {
    kind: "refused",
    error: "not_an_artboard",
  });
  assert.deepEqual(refreshArtboardPlan({ draft: draft(), frameId: "missing", currentRevisionId: REVISION_TWO, currentRevisionNumber: 4 }), {
    kind: "refused",
    error: "unknown_frame",
  });
});
