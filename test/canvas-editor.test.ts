import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, test } from "node:test";

import { openArtifact } from "../apps/dashboard/src/editor-api.ts";
import {
  addNode,
  bringToFront,
  fitScale,
  getScene,
  insideBounds,
  layerRows,
  moveFrame,
  moveNode,
  moveNodes,
  nudgeSelection,
  openCanvas,
  rectNode,
  removeNode,
  reorderNodeTo,
  resizeNode,
  saveScene,
  selectNodesInRect,
  selectionBounds,
  sendToBack,
  surfaceLayout,
  textNode,
  updateTextNode,
  type SurfaceLayout,
} from "../apps/dashboard/src/scene-api.ts";
import { SceneAutosave } from "../apps/dashboard/src/scene-autosave.ts";
import { AUTOSAVE_MS } from "../apps/dashboard/src/editor-autosave.ts";
import { surfaceLayout as domainSurfaceLayout, type Scene, type SceneFrame } from "@artiflow/domain/scene";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init: RequestInit };
const useFetch = (reply: (call: Call) => Response): Call[] => {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return calls;
};
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const canvasPage = () => source("../apps/dashboard/src/CanvasEditorPage.tsx");
const between = (text: string, start: string, end: string): string => {
  const at = text.indexOf(start);
  const to = at < 0 ? -1 : text.indexOf(end, at + start.length);
  const missing = `the canvas screen still carries ${start} up to ${end}`;
  assert.ok(at >= 0 && to > at, missing);
  return text.slice(at, to);
};
const historyRegion = () => between(canvasPage(), "export const HISTORY_LIMIT", "\nconst withoutNodes");
type HistoryStep = { undo: Scene[]; redo: Scene[]; scene: Scene };
type HistoryModule = {
  HISTORY_LIMIT: number;
  commitHistory: (undo: Scene[], redo: Scene[], before: Scene) => { undo: Scene[]; redo: Scene[] };
  undoHistory: (undo: Scene[], redo: Scene[], current: Scene) => HistoryStep | null;
  redoHistory: (undo: Scene[], redo: Scene[], current: Scene) => HistoryStep | null;
};
const historyModule = async (): Promise<HistoryModule> => {
  const code = stripTypeScriptTypes(historyRegion(), { mode: "strip" });
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  return (await import(url)) as HistoryModule;
};

const scene = (): Scene => ({
  formatVersion: 1,
  frames: [
    {
      id: "frame-1",
      name: "Home",
      x: 0,
      y: 0,
      w: 800,
      h: 600,
      nodes: [
        { id: "rect-1", type: "rect", x: 40, y: 40, w: 200, h: 120, fill: "#e5e7eb" },
        {
          id: "text-1",
          type: "text",
          x: 40,
          y: 200,
          w: 300,
          h: 60,
          text: "Hello",
          style: { fontSize: 24, fontWeight: 600, color: "#111111" },
        },
      ],
    },
  ],
});
const draft = () => ({
  kind: "canvas",
  artifactId: "a",
  seq: 4,
  publishedSeq: 2,
  revisionId: "r1",
  scene: scene(),
});
const saved = { artifactId: "a", seq: 5, publishedSeq: 5, frozen: true, applied: 1, revisionId: "r2" };
const failure = (code: string) => ({ ok: false as const, error: "refused", code, signInRequired: false });
const markdown = {
  artifactId: "a",
  title: "Notes",
  kind: "markdown",
  revisionId: "r1",
  revisionNumber: 1,
  text: "old",
  seq: 4,
  publishedSeq: 2,
};

const nodeOf = (value: Scene, id: string) => value.frames[0]?.nodes.find((node) => node.id === id);
const legacyScene = (): Scene => ({
  formatVersion: 1,
  frames: [
    {
      id: "frame-1",
      name: "Home",
      x: 0,
      y: 0,
      w: 800,
      h: 600,
      nodes: [{ id: "rect-1", type: "rect", x: 40, y: 40, w: 200, h: 120, fill: "#e5e7eb" }],
    },
    {
      id: "frame-2",
      name: "Detail",
      x: 0,
      y: 0,
      w: 400,
      h: 400,
      nodes: [{ id: "text-2", type: "text", x: 10, y: 10, w: 120, h: 40, text: "Detail", style: { fontSize: 16 } }],
    },
    { id: "frame-3", name: "Extra", x: 0, y: 0, w: 200, h: 200, nodes: [] },
  ],
});

test("the library sends a canvas to the canvas editor and every other kind keeps its current path", async () => {
  useFetch(() => json(draft()));
  let href = "";
  await openCanvas({ id: "a", viewerHref: "/artifact/a" }, { assign: (url) => (href = url) });
  assert.equal(href, "/canvas/a", "a canvas the caller may edit opens in the canvas editor");

  for (const [status, error] of [
    [403, "forbidden"],
    [409, "wrong_kind"],
    [404, "not_found"],
  ] as const) {
    useFetch(() => json({ error }, status));
    href = "";
    await openCanvas({ id: "a", viewerHref: "/artifact/a" }, { assign: (url) => (href = url) });
    assert.equal(href, "/artifact/a", `a canvas the editor cannot open stays on the viewer (${error})`);
  }

  useFetch(() => json(markdown));
  href = "";
  await openArtifact({ id: "a", viewerHref: "/artifact/a", kind: "markdown" }, { assign: (url) => (href = url) });
  assert.equal(href, "/edit/a", "the markdown editor keeps its route and its read");

  useFetch(() => json({ error: "wrong_kind" }, 409));
  href = "";
  await openArtifact({ id: "a", viewerHref: "/artifact/a", kind: "html" }, { assign: (url) => (href = url) });
  assert.equal(href, "/artifact/a", "a page still never enters an editor");
});

test("the scene client refuses an answer it cannot verify instead of opening half a scene", async () => {
  useFetch(() => json(draft()));
  const read = await getScene("a");
  assert.equal(read.ok, true);
  assert.deepEqual(read.ok && read.value.scene, scene());

  const malformed: [string, unknown][] = [
    ["a scene served without a sequence", { ...draft(), seq: undefined }],
    ["a sequence that is not a whole number", { ...draft(), seq: 1.5 }],
    ["an answer for another kind", { ...draft(), kind: "markdown" }],
    ["an answer with no revision", { ...draft(), revisionId: "" }],
    ["an answer with no artifact", { ...draft(), artifactId: "" }],
    ["a scene with no frames", { ...draft(), scene: { formatVersion: 1 } }],
    [
      "a node with a geometry that is not a number",
      {
        ...draft(),
        scene: { ...scene(), frames: [{ ...scene().frames[0], nodes: [{ ...scene().frames[0]!.nodes[0], x: "10" }] }] },
      },
    ],
    [
      "a node the format does not know",
      {
        ...draft(),
        scene: {
          ...scene(),
          frames: [{ ...scene().frames[0], nodes: [{ ...scene().frames[0]!.nodes[0], type: "group" }] }],
        },
      },
    ],
    [
      "a duplicated id",
      {
        ...draft(),
        scene: {
          ...scene(),
          frames: [{ ...scene().frames[0], nodes: [scene().frames[0]!.nodes[0], scene().frames[0]!.nodes[0]] }],
        },
      },
    ],
  ];
  for (const [label, body] of malformed) {
    useFetch(() => json(body));
    const result = await getScene("a");
    assert.equal(result.ok, false, label);
    assert.equal(result.ok === false && result.code, "unreadable_answer", label);
  }

  const calls = useFetch(() => json(draft()));
  await getScene("a");
  assert.deepEqual(
    [calls[0]?.url, calls[0]?.init.method, calls[0]?.init.cache, calls[0]?.init.credentials],
    ["/api/artifacts/a/scene", "GET", "no-store", "same-origin"],
  );
});

test("a scene save sends the whole scene against the sequence it read and verifies the answer", async () => {
  const calls = useFetch(() => json(saved));
  const next = moveNode(scene(), "rect-1", 10, 0);
  assert.deepEqual(await saveScene("a", next, 4), { ok: true, value: saved });
  assert.deepEqual([calls[0]?.url, calls[0]?.init.method], ["/api/artifacts/a/scene", "PUT"]);
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { scene: next, expectedSeq: 4 });

  useFetch(() => json({ ...saved, applied: "one" }));
  assert.equal((await saveScene("a", next, 4)).ok, false, "an unverified answer never advances the editor");
  useFetch(() => json({ error: "concurrent_edit" }, 409));
  const conflict = await saveScene("a", next, 4);
  assert.deepEqual(conflict.ok === false && conflict.code, "concurrent_edit");
});

test("a drag and a resize keep a positive size while the position stays free and every other gesture composes a whole scene", () => {
  const moved = moveNode(scene(), "rect-1", 30, 25);
  assert.deepEqual(
    [nodeOf(moved, "rect-1")?.x, nodeOf(moved, "rect-1")?.y],
    [70, 65],
    "a drag moves by its scene distance",
  );
  assert.equal(nodeOf(scene(), "rect-1")?.x, 40, "the scene before the drag is untouched");

  const past = moveNode(scene(), "rect-1", -500, 5000);
  assert.deepEqual(
    [nodeOf(past, "rect-1")?.x, nodeOf(past, "rect-1")?.y],
    [-460, 5040],
    "a drag past the frame edge keeps going instead of stopping at the edge",
  );
  assert.deepEqual(nodeOf(moveNode(scene(), "missing", 10, 10), "rect-1"), nodeOf(scene(), "rect-1"));

  const resized = resizeNode(scene(), "rect-1", 320, 90);
  assert.deepEqual([nodeOf(resized, "rect-1")?.w, nodeOf(resized, "rect-1")?.h], [320, 90]);
  const bounded = resizeNode(scene(), "rect-1", 5000, 0);
  assert.deepEqual(
    [nodeOf(bounded, "rect-1")?.w, nodeOf(bounded, "rect-1")?.h],
    [5000, 4],
    "a resize keeps a positive size without stopping at the frame edge",
  );
  const floored = resizeNode(scene(), "rect-1", 0, -10);
  assert.deepEqual(
    [nodeOf(floored, "rect-1")?.w, nodeOf(floored, "rect-1")?.h],
    [4, 4],
    "a resize below the minimum keeps the minimum instead of collapsing the node",
  );

  const withText = addNode(scene(), "frame-1", textNode("text-2", 120, 360));
  assert.equal(nodeOf(withText, "text-2")?.type, "text");
  assert.equal(
    addNode(scene(), "frame-1", textNode("text-1", 0, 0)).frames[0]?.nodes.length,
    2,
    "an id that already exists is not added twice",
  );
  assert.equal(removeNode(withText, "text-2").frames[0]?.nodes.length, 2);
  assert.equal(removeNode(scene(), "text-1").frames[0]?.nodes.length, 1);
  assert.equal(removeNode(scene(), "missing").frames[0]?.nodes.length, 2);

  const edited = updateTextNode(scene(), "text-1", { text: "Changed", style: { fontSize: 40, color: "#ff0000" } });
  assert.equal(nodeOf(edited, "text-1")?.type === "text" && nodeOf(edited, "text-1")!.text, "Changed");
  assert.deepEqual(nodeOf(edited, "text-1")?.type === "text" && nodeOf(edited, "text-1")!.style, {
    fontSize: 40,
    fontWeight: 600,
    color: "#ff0000",
  });
  const boundedFont = nodeOf(updateTextNode(scene(), "text-1", { style: { fontSize: 9000 } }), "text-1");
  assert.equal(
    boundedFont?.type === "text" ? boundedFont.style?.fontSize : null,
    400,
    "a font size the server would refuse is clamped before it is sent",
  );
  assert.equal(nodeOf(updateTextNode(scene(), "rect-1", { text: "no" }), "rect-1")?.type, "rect");

  assert.equal(
    Math.round(fitScale({ w: 800, h: 600 }, { w: 1600, h: 1200 }) * 1000) / 1000,
    1.72,
    "fitting uses a margin so the frame never touches the viewport edge",
  );
  assert.equal(fitScale({ w: 800, h: 600 }, { w: 0, h: 0 }), 0.02, "an empty viewport falls back to the smallest zoom");
  assert.equal(rectNode("rect-3", 10, 10).fill.length > 0, true, "a new rectangle arrives with a visible fill");
});

test("dragging a frame materialises the derived layout and offsets only the frame that moved", () => {
  const base = legacyScene();
  const placements = surfaceLayout(base.frames).placements;
  const before = structuredClone(base);
  const at = (value: Scene, id: string) => {
    const frame = value.frames.find((entry) => entry.id === id);
    return [frame?.x, frame?.y];
  };

  assert.deepEqual(
    placements.map((placement) => [placement.frameId, placement.x, placement.y]),
    [
      ["frame-1", 0, 0],
      ["frame-2", 0, 640],
      ["frame-3", 0, 1080],
    ],
    "the fixture is a legacy scene whose frames all sit on the origin",
  );

  const moved = moveFrame(base, placements, "frame-2", 30, -20);
  assert.deepEqual(at(moved, "frame-1"), [0, 0], "a frame that did not move keeps the place the layout gave it");
  assert.deepEqual(at(moved, "frame-2"), [30, 620], "the dragged frame carries its layout place plus the drag delta");
  assert.deepEqual(at(moved, "frame-3"), [0, 1080], "every frame is materialised, not only the one that moved");
  assert.deepEqual(base, before, "the scene before the drag is untouched");
  assert.deepEqual(
    moved.frames.map((frame) => frame.nodes),
    before.frames.map((frame) => frame.nodes),
    "dragging a frame leaves every node id and every node geometry byte-identical",
  );
  assert.equal(moved.formatVersion, base.formatVersion, "the frame drag rewrites no scene property it was not given");

  const settled = moveFrame(base, placements, "frame-2", 0, 0);
  assert.equal(
    moveFrame(settled, placements, "frame-2", 0, 0),
    settled,
    "a gesture that would change nothing returns the scene it was handed",
  );
  assert.equal(moveFrame(base, placements, "missing", 10, 10), base, "an unknown frame returns the same scene");
  assert.deepEqual(base, before, "an unknown frame never rewrites the frames around it either");

  const rounding = moveFrame(base, placements, "frame-1", 12.7, -3.4);
  assert.deepEqual(at(rounding, "frame-1"), [13, -3], "a fractional drag rounds to the whole pixels a scene needs");
  assert.deepEqual(at(rounding, "frame-2"), [0, 640], "rounding the dragged frame never rounds the materialised ones");

  const outside = moveFrame(base, placements, "frame-1", -500, -300);
  assert.deepEqual(
    at(outside, "frame-1"),
    [-500, -300],
    "a frame may be dragged past the origin instead of being clamped to it",
  );
  assert.deepEqual(at(outside, "frame-3"), [0, 1080], "the frames left behind still hold their materialised place");

  const partial = moveFrame(base, placements.slice(0, 1), "frame-1", 10, 10);
  assert.deepEqual(at(partial, "frame-1"), [10, 10], "the dragged frame takes its placement and its delta");
  assert.deepEqual(at(partial, "frame-3"), [0, 0], "a frame with no placement keeps the x/y the scene already stores");
  assert.deepEqual(base, before, "a scene read once more is still the scene that went in");
});

test("the surface layout is the one domain helper the editor and the viewer share", () => {
  assert.equal(
    surfaceLayout,
    domainSurfaceLayout,
    "the dashboard re-exports the domain layout instead of keeping a second copy",
  );
  assert.deepEqual(
    domainSurfaceLayout([
      { id: "a", name: "A", x: 0, y: 0, w: 400, h: 400, nodes: [] },
      { id: "b", name: "B", x: 0, y: 0, w: 400, h: 400, nodes: [] },
    ]).placements,
    [
      { frameId: "a", x: 0, y: 0 },
      { frameId: "b", x: 0, y: 440 },
    ],
    "the shared layout is importable from the domain package on its own",
  );
});

test("the surface layout gives every frame a place of its own and falls back to a grid it can reuse", () => {
  const frame = (id: string, x: number, y: number, w = 800, h = 600): SceneFrame => ({
    id,
    name: id,
    x,
    y,
    w,
    h,
    nodes: [],
  });
  const boxesOf = (input: SceneFrame[], layout: SurfaceLayout) =>
    layout.placements.map((placement) => {
      const source = input.find((entry) => entry.id === placement.frameId)!;
      return { x: placement.x, y: placement.y, w: source.w, h: source.h };
    });
  const collides = (
    left: { x: number; y: number; w: number; h: number },
    right: { x: number; y: number; w: number; h: number },
  ) =>
    left.x < right.x + right.w && right.x < left.x + left.w && left.y < right.y + right.h && right.y < left.y + left.h;
  const apart = (input: SceneFrame[], layout: SurfaceLayout) => {
    const boxes = boxesOf(input, layout);
    return boxes.every((box, at) => boxes.every((other, index) => index === at || !collides(box, other)));
  };

  assert.deepEqual(
    surfaceLayout([]),
    { placements: [], width: 0, height: 0 },
    "a canvas with no frames has an empty surface",
  );

  const single = surfaceLayout([frame("frame-1", 0, 0)]);
  assert.deepEqual(single.placements, [{ frameId: "frame-1", x: 0, y: 0 }]);
  assert.deepEqual([single.width, single.height], [800, 600], "one frame gives the surface its own size");

  const spread = surfaceLayout([frame("frame-1", 0, 0), frame("frame-2", 1000, 40, 400, 400)]);
  assert.deepEqual(
    spread.placements,
    [
      { frameId: "frame-1", x: 0, y: 0 },
      { frameId: "frame-2", x: 1000, y: 40 },
    ],
    "frames that already sit apart keep the x/y the scene stores",
  );
  assert.deepEqual([spread.width, spread.height], [1400, 600], "the surface bounds cover every placement");

  const negative = surfaceLayout([frame("frame-1", -400, -200), frame("frame-2", 600, 0, 400, 400)]);
  assert.deepEqual(
    negative.placements,
    [
      { frameId: "frame-1", x: 0, y: 0 },
      { frameId: "frame-2", x: 1000, y: 200 },
    ],
    "a frame left of or above the origin is shifted onto a surface that starts at zero",
  );
  assert.deepEqual([negative.width, negative.height], [1400, 600], "the shifted bounds still cover every frame");

  const legacy = [frame("frame-1", 0, 0), frame("frame-2", 0, 0, 400, 400), frame("frame-3", 0, 0, 200, 200)];
  const before = structuredClone(legacy);
  for (const entry of legacy) Object.freeze(entry);
  Object.freeze(legacy);
  const grid = surfaceLayout(legacy);
  assert.deepEqual(
    grid.placements,
    [
      { frameId: "frame-1", x: 0, y: 0 },
      { frameId: "frame-2", x: 0, y: 640 },
      { frameId: "frame-3", x: 0, y: 1080 },
    ],
    "frames stacked on the same origin fall back to a spaced column instead of piling up",
  );
  assert.deepEqual([grid.width, grid.height], [800, 1280], "the fallback surface covers the column it built");
  assert.deepEqual(
    grid.placements.map((placement) => placement.frameId),
    ["frame-1", "frame-2", "frame-3"],
    "placements follow the order the scene stores the frames in",
  );
  assert.equal(apart(legacy, grid), true, "the fallback never leaves two frames on top of each other");
  assert.deepEqual(surfaceLayout(legacy), grid, "asking twice gives the same surface");
  assert.deepEqual(legacy, before, "the layout never rewrites the frames it reads");

  const overlapping = [frame("frame-1", 0, 0), frame("frame-2", 100, 100, 400, 400)];
  const resolved = surfaceLayout(overlapping);
  assert.deepEqual(
    resolved.placements,
    [
      { frameId: "frame-1", x: 0, y: 0 },
      { frameId: "frame-2", x: 100, y: 100 },
    ],
    "frames that overlap keep the x/y the scene stores, because an overlap is a placement somebody chose",
  );

  const dragged = [frame("frame-1", 0, 0), frame("frame-2", 0, 640, 400, 400)];
  const draggedLayout = surfaceLayout(dragged);
  assert.deepEqual(
    draggedLayout.placements.map((placement) => placement.y),
    [0, 640],
    "a frame dragged onto another keeps its position instead of making the whole surface re-column",
  );

  const crowded = [frame("frame-1", 0, 0), frame("frame-2", 0, 0, 300, 200), frame("frame-3", 0, 0, 500, 700)];
  const crowdedLayout = surfaceLayout(crowded);
  assert.equal(apart(crowded, crowdedLayout), true, "a legacy scene with three frames is usable on one surface");
  assert.equal(
    crowdedLayout.placements.every((placement) => placement.x === 0),
    true,
    "the fallback stacks the frames in one column",
  );
  assert.equal(
    crowdedLayout.width,
    Math.max(...crowded.map((entry) => entry.w)),
    "the column is as wide as the widest frame and no wider",
  );
});

test("a selection rectangle takes every node of the active frame that it touches, in frame order", () => {
  const active = scene().frames[0]!;
  assert.deepEqual(
    selectNodesInRect(active, { x: 0, y: 0, w: 800, h: 600 }),
    ["rect-1", "text-1"],
    "a rectangle over the whole frame takes every node in the order the frame paints them",
  );
  assert.deepEqual(
    selectNodesInRect(active, { x: 220, y: 30, w: 40, h: 40 }),
    ["rect-1"],
    "a rectangle that overlaps only part of a node still takes it",
  );
  assert.deepEqual(
    selectNodesInRect(active, { x: 240, y: 100, w: 10, h: 10 }),
    ["rect-1"],
    "a rectangle that only touches an edge counts as an overlap",
  );
  assert.deepEqual(
    selectNodesInRect(active, { x: 400, y: 400, w: 50, h: 50 }),
    [],
    "a rectangle over empty space takes nothing",
  );
  assert.deepEqual(selectNodesInRect(active, { x: 0, y: 0, w: 0, h: 0 }), [], "an empty rectangle takes nothing");

  const reversed: SceneFrame = { ...active, nodes: [...active.nodes].reverse() };
  assert.deepEqual(
    selectNodesInRect(reversed, { x: 0, y: 0, w: 800, h: 600 }),
    ["text-1", "rect-1"],
    "the answer follows the frame's node order instead of the geometry",
  );
  assert.deepEqual(
    selectNodesInRect(active, { x: 0, y: 0, w: 800, h: 600 }),
    selectNodesInRect(active, { x: 0, y: 0, w: 800, h: 600 }),
    "asking twice gives the same answer",
  );
  assert.equal(active.nodes.length, 2, "the frame it reads is left untouched");
});

test("the selection bounds cover every listed node of one frame and nothing else", () => {
  const frame = scene().frames[0]!;
  const before = structuredClone(frame);

  assert.deepEqual(
    selectionBounds(frame, ["rect-1", "text-1"]),
    { x: 40, y: 40, w: 300, h: 220 },
    "two nodes give the rectangle that encloses both of them",
  );
  const three = addNode(scene(), "frame-1", rectNode("rect-3", 400, 420));
  assert.deepEqual(
    selectionBounds(three.frames[0]!, ["rect-1", "text-1", "rect-3"]),
    { x: 40, y: 40, w: 560, h: 500 },
    "a third node widens the rectangle to reach it",
  );
  assert.deepEqual(
    selectionBounds(frame, ["rect-1"]),
    { x: 40, y: 40, w: 200, h: 120 },
    "one node bounds the node itself",
  );
  assert.deepEqual(
    selectionBounds(frame, ["rect-1", "text-2"]),
    { x: 40, y: 40, w: 200, h: 120 },
    "an id that lives in another frame contributes nothing",
  );
  assert.deepEqual(
    selectionBounds(frame, ["rect-1", "text-1"]),
    selectionBounds(frame, ["text-1", "rect-1"]),
    "the order the ids are listed in does not matter",
  );
  assert.equal(selectionBounds(frame, ["missing"]), null, "unknown ids have no rectangle");
  assert.equal(selectionBounds(frame, []), null, "an empty selection has no rectangle");
  assert.deepEqual(frame, before, "measuring the selection leaves the frame it read untouched");
});

test("a point on the edge of the bounds counts as inside and one step past it does not", () => {
  const bounds = { x: 10, y: 20, w: 100, h: 50 };
  assert.equal(insideBounds(bounds, { x: 50, y: 40 }), true, "a point in the middle is inside");
  assert.equal(insideBounds(bounds, { x: 10, y: 20 }), true, "the top left corner is inside");
  assert.equal(insideBounds(bounds, { x: 110, y: 70 }), true, "the bottom right corner is inside");
  assert.equal(insideBounds(bounds, { x: 10, y: 70 }), true, "the bottom left corner is inside");
  assert.equal(insideBounds(bounds, { x: 110, y: 20 }), true, "the top right corner is inside");
  assert.equal(insideBounds(bounds, { x: 9, y: 40 }), false, "one step to the left is outside");
  assert.equal(insideBounds(bounds, { x: 111, y: 40 }), false, "one step to the right is outside");
  assert.equal(insideBounds(bounds, { x: 50, y: 19 }), false, "one step above is outside");
  assert.equal(insideBounds(bounds, { x: 50, y: 71 }), false, "one step below is outside");
  assert.deepEqual(bounds, { x: 10, y: 20, w: 100, h: 50 }, "testing a point leaves the bounds it read untouched");
});

test("moving a selection keeps one delta for the whole group past the frame edge", () => {
  const moved = moveNodes(scene(), ["rect-1", "text-1"], 30, 20);
  assert.deepEqual(
    [nodeOf(moved, "rect-1")?.x, nodeOf(moved, "rect-1")?.y, nodeOf(moved, "text-1")?.x, nodeOf(moved, "text-1")?.y],
    [70, 60, 70, 220],
    "every selected node moves by the same delta",
  );
  assert.deepEqual(
    [nodeOf(moved, "rect-1")?.w, nodeOf(moved, "rect-1")?.h, nodeOf(moved, "text-1")?.w, nodeOf(moved, "text-1")?.h],
    [200, 120, 300, 60],
    "a move never resizes a node",
  );
  assert.equal(nodeOf(scene(), "rect-1")?.x, 40, "the scene before the drag is untouched");

  const forward = moveNodes(scene(), ["rect-1", "text-1"], 5000, 5000);
  assert.deepEqual(
    [
      nodeOf(forward, "rect-1")?.x,
      nodeOf(forward, "rect-1")?.y,
      nodeOf(forward, "text-1")?.x,
      nodeOf(forward, "text-1")?.y,
    ],
    [5040, 5040, 5040, 5200],
    "the group keeps its delta when its bounding box leaves the frame",
  );

  const backward = moveNodes(scene(), ["rect-1", "text-1"], -5000, -5000);
  assert.deepEqual(
    [
      nodeOf(backward, "rect-1")?.x,
      nodeOf(backward, "rect-1")?.y,
      nodeOf(backward, "text-1")?.x,
      nodeOf(backward, "text-1")?.y,
    ],
    [-4960, -4960, -4960, -4800],
    "a backward drag crosses the frame edge without stacking the nodes",
  );
  assert.deepEqual(
    moveNodes(scene(), ["rect-1", "text-1"], Number.NaN, Number.POSITIVE_INFINITY),
    scene(),
    "a delta that is not a number leaves the group where it is",
  );

  assert.deepEqual(moveNodes(scene(), [], 10, 10), scene(), "an empty selection leaves the scene as it is");
  assert.deepEqual(moveNodes(scene(), ["missing"], 10, 10), scene(), "ids the scene does not know leave it as it is");
  assert.deepEqual(
    moveNodes(scene(), ["rect-1"], 30, 25),
    moveNode(scene(), "rect-1", 30, 25),
    "a one-node group moves exactly like a single node",
  );

  const twoFrames: Scene = {
    ...scene(),
    frames: [
      ...scene().frames,
      {
        id: "frame-2",
        name: "Other",
        x: 0,
        y: 0,
        w: 400,
        h: 400,
        nodes: [{ id: "rect-2", type: "rect", x: 10, y: 10, w: 50, h: 50, fill: "#e5e7eb" }],
      },
    ],
  };
  const crossFrame = moveNodes(twoFrames, ["rect-1", "rect-2"], 20, 20);
  assert.deepEqual(
    [
      crossFrame.frames[0]?.nodes.find((node) => node.id === "rect-1")?.x,
      crossFrame.frames[1]?.nodes.find((node) => node.id === "rect-2")?.x,
    ],
    [60, 10],
    "only nodes of the frame the group started in move",
  );
});

test("a group that carries a node as large as its frame still moves", () => {
  const fullFrame: Scene = {
    ...scene(),
    frames: [
      {
        id: "frame-1",
        name: "Home",
        x: 0,
        y: 0,
        w: 800,
        h: 600,
        nodes: [
          { id: "rect-1", type: "rect", x: 0, y: 0, w: 800, h: 600, fill: "#e5e7eb" },
          { id: "text-1", type: "text", x: 100, y: 100, w: 50, h: 50, text: "Hi", style: { fontSize: 16 } },
        ],
      },
    ],
  };
  const moved = moveNodes(fullFrame, ["rect-1", "text-1"], 60, 40);
  assert.deepEqual(
    [nodeOf(moved, "rect-1")?.x, nodeOf(moved, "rect-1")?.y, nodeOf(moved, "text-1")?.x, nodeOf(moved, "text-1")?.y],
    [60, 40, 160, 140],
    "a node the size of its frame no longer freezes the whole group",
  );
  assert.deepEqual(
    [nodeOf(moved, "rect-1")?.w, nodeOf(moved, "rect-1")?.h],
    [800, 600],
    "carrying the group never resizes the node that fills the frame",
  );
});

test("a scene served with a node outside its frame is readable instead of refused", async () => {
  const outside = { ...scene().frames[0]!.nodes[0], x: 900, y: -40 };
  useFetch(() => json({ ...draft(), scene: { ...scene(), frames: [{ ...scene().frames[0], nodes: [outside] }] } }));
  const read = await getScene("a");
  assert.equal(read.ok, true, "a node outside its frame is a position, not an invalid scene");
  assert.deepEqual(read.ok && read.value.scene.frames[0]?.nodes[0], outside);
});

test("reordering a selection preserves the relative order inside and outside the group", () => {
  const three = addNode(scene(), "frame-1", rectNode("rect-3", 400, 420));
  const idsOf = (value: Scene) => value.frames[0]?.nodes.map((node) => node.id) ?? [];
  assert.deepEqual(idsOf(three), ["rect-1", "text-1", "rect-3"], "the frame paints back to front");

  assert.deepEqual(idsOf(bringToFront(three, ["rect-1"])), ["text-1", "rect-3", "rect-1"]);
  assert.deepEqual(
    idsOf(bringToFront(three, ["rect-1", "rect-3"])),
    ["text-1", "rect-1", "rect-3"],
    "the group keeps its own relative order on its way to the front",
  );
  assert.deepEqual(
    idsOf(bringToFront(three, ["text-1"])),
    ["rect-1", "rect-3", "text-1"],
    "a node that sits in the middle still lands in front of the rest",
  );
  assert.deepEqual(idsOf(sendToBack(three, ["text-1"])), ["text-1", "rect-1", "rect-3"]);
  assert.deepEqual(
    idsOf(sendToBack(three, ["text-1", "rect-3"])),
    ["text-1", "rect-3", "rect-1"],
    "the group keeps its own relative order on its way to the back",
  );

  assert.deepEqual(bringToFront(three, []), three, "an empty selection leaves the paint order as it is");
  assert.deepEqual(sendToBack(three, []), three, "an empty selection leaves the paint order as it is");
  assert.deepEqual(bringToFront(three, ["missing"]), three, "an unknown id leaves the paint order as it is");
  assert.deepEqual(sendToBack(three, ["missing"]), three, "an unknown id leaves the paint order as it is");
  assert.equal(idsOf(bringToFront(three, ["rect-1", "rect-1"])).length, 3, "a repeated id never duplicates a node");
  assert.deepEqual(
    [nodeOf(bringToFront(three, ["rect-3"]), "rect-3")?.x, nodeOf(sendToBack(three, ["rect-3"]), "rect-3")?.x],
    [400, 400],
    "reordering moves no node",
  );

  const twoFrames: Scene = {
    ...three,
    frames: [
      ...three.frames,
      {
        id: "frame-2",
        name: "Other",
        x: 0,
        y: 0,
        w: 400,
        h: 400,
        nodes: [{ id: "rect-2", type: "rect", x: 10, y: 10, w: 50, h: 50, fill: "#e5e7eb" }],
      },
    ],
  };
  assert.deepEqual(
    sendToBack(twoFrames, ["rect-3"]).frames[1],
    twoFrames.frames[1],
    "reordering a frame leaves the other frames untouched",
  );
});

test("a layer drag moves one node to the exact index it was dropped on", () => {
  const three = addNode(scene(), "frame-1", rectNode("rect-3", 400, 420));
  const idsOf = (value: Scene) => value.frames[0]?.nodes.map((node) => node.id) ?? [];
  const twoFrames: Scene = {
    ...three,
    frames: [
      ...three.frames,
      {
        id: "frame-2",
        name: "Other",
        x: 0,
        y: 0,
        w: 400,
        h: 400,
        nodes: [{ id: "rect-2", type: "rect", x: 10, y: 10, w: 50, h: 50, fill: "#e5e7eb" }],
      },
    ],
  };

  assert.deepEqual(
    idsOf(reorderNodeTo(three, "rect-1", 2)),
    ["text-1", "rect-3", "rect-1"],
    "a row dropped at an explicit index lands there",
  );
  assert.deepEqual(
    idsOf(reorderNodeTo(three, "rect-3", 0)),
    ["rect-3", "rect-1", "text-1"],
    "a row dropped before every other node becomes the back of the frame",
  );
  assert.deepEqual(
    idsOf(reorderNodeTo(three, "text-1", 99)),
    ["rect-1", "rect-3", "text-1"],
    "an index past the last node clamps to the last position",
  );
  assert.deepEqual(
    idsOf(reorderNodeTo(three, "text-1", -4)),
    ["text-1", "rect-1", "rect-3"],
    "an index before the first node clamps to the first position",
  );
  assert.equal(reorderNodeTo(three, "text-1", 1), three, "the index a node already holds leaves the scene as it is");
  assert.equal(reorderNodeTo(three, "missing", 0), three, "an unknown node leaves the scene as it is");
  assert.equal(
    nodeOf(reorderNodeTo(three, "rect-1", 2), "rect-1")?.x,
    40,
    "reordering a row moves no node on the canvas",
  );
  assert.deepEqual(
    reorderNodeTo(twoFrames, "rect-3", 0).frames[1],
    twoFrames.frames[1],
    "reordering a row leaves every other frame untouched",
  );
});

test("a nudge moves the selected block one step and preserves its own order", () => {
  const three = addNode(scene(), "frame-1", rectNode("rect-3", 400, 420));
  const four = addNode(three, "frame-1", rectNode("rect-4", 0, 0));
  const idsOf = (value: Scene) => value.frames[0]?.nodes.map((node) => node.id) ?? [];
  assert.deepEqual(idsOf(four), ["rect-1", "text-1", "rect-3", "rect-4"], "the frame paints back to front");

  assert.deepEqual(
    idsOf(nudgeSelection(three, ["text-1"], 1)),
    ["rect-1", "rect-3", "text-1"],
    "a single selection moves one step toward the front",
  );
  assert.deepEqual(
    idsOf(nudgeSelection(three, ["text-1"], -1)),
    ["text-1", "rect-1", "rect-3"],
    "a single selection moves one step toward the back",
  );
  assert.deepEqual(
    nudgeSelection(three, ["text-1"], 1),
    reorderNodeTo(three, "text-1", 2),
    "a single step is the explicit reorder one index up",
  );
  assert.deepEqual(
    nudgeSelection(three, ["text-1"], -1),
    reorderNodeTo(three, "text-1", 0),
    "a single step is the explicit reorder one index down",
  );

  assert.deepEqual(
    idsOf(nudgeSelection(four, ["rect-1", "text-1"], 1)),
    ["rect-3", "rect-1", "text-1", "rect-4"],
    "a block moves one step forward keeping its own relative order",
  );
  assert.deepEqual(
    idsOf(nudgeSelection(four, ["rect-3", "rect-4"], -1)),
    ["rect-1", "rect-3", "rect-4", "text-1"],
    "a block moves one step back keeping its own relative order",
  );
  assert.equal(
    nudgeSelection(four, ["rect-3", "rect-4"], 1),
    four,
    "a block already at the front stops instead of leaving the frame",
  );
  assert.equal(
    nudgeSelection(four, ["rect-1", "text-1"], -1),
    four,
    "a block already at the back stops instead of leaving the frame",
  );
  assert.deepEqual(
    idsOf(nudgeSelection(four, ["rect-1", "rect-3"], 1)),
    ["text-1", "rect-1", "rect-3", "rect-4"],
    "an interleaved block still moves as one",
  );
  assert.equal(nudgeSelection(four, [], 1), four, "an empty selection leaves the paint order as it is");
  assert.equal(
    nudgeSelection(four, ["rect-1", "text-1"], 0),
    four,
    "a step that is not up or down leaves the paint order as it is",
  );
  assert.equal(nudgeSelection(four, ["missing"], 1), four, "an unknown id leaves the paint order as it is");
  assert.equal(nodeOf(nudgeSelection(four, ["rect-1"], 1), "rect-1")?.x, 40, "a nudge moves no node on the canvas");
});

test("the layers panel lists the frame from front to back with a compact label", () => {
  const frame = scene().frames[0]!;
  const labelOf = (value: Scene, id: string) => layerRows(value.frames[0]!).find((row) => row.id === id)?.label;

  assert.deepEqual(
    layerRows(frame),
    [
      { id: "text-1", label: "Hello" },
      { id: "rect-1", label: "Rectangle 1" },
    ],
    "the list runs from the node that paints last to the one that paints first",
  );

  const stacked = addNode(
    addNode(scene(), "frame-1", rectNode("rect-2", 0, 0)),
    "frame-1",
    rectNode("rect-3", 300, 300),
  );
  assert.deepEqual(
    layerRows(stacked.frames[0]!).map((row) => row.id),
    ["rect-3", "rect-2", "text-1", "rect-1"],
    "every node gets one row",
  );
  assert.equal(labelOf(stacked, "rect-3"), "Rectangle 3", "the ordinal counts the rectangles in paint order");
  assert.equal(labelOf(stacked, "rect-1"), "Rectangle 1", "the backmost node of its type keeps the first ordinal");

  const mixed = addNode(
    addNode(stacked, "frame-1", { id: "image-1", type: "image", x: 0, y: 300, w: 100, h: 100, assetId: "asset-1" }),
    "frame-1",
    { id: "image-2", type: "image", x: 300, y: 300, w: 100, h: 100, assetId: "asset-2" },
  );
  const withPath = addNode(mixed, "frame-1", {
    id: "path-1",
    type: "path",
    x: 500,
    y: 100,
    w: 100,
    h: 100,
    d: "M0 0 L10 10",
  });
  assert.equal(labelOf(withPath, "image-2"), "Image 2", "each node type counts on its own");
  assert.equal(labelOf(withPath, "path-1"), "Path 1", "a type that appears once reads as its own first ordinal");

  const long = addNode(scene(), "frame-1", {
    ...textNode("text-2", 0, 300),
    text: "   A very long heading that goes on and on past any readable row width   ",
  });
  const snippet = labelOf(long, "text-2") ?? "";
  assert.equal(snippet.startsWith("A very long heading"), true, "the text snippet is trimmed and has no type prefix");
  assert.equal(snippet.includes("Text node"), false, "the row label carries no accessibility vocabulary");
  assert.equal(snippet.length <= 41, true, "a long snippet is cut to a readable length");
  assert.equal(snippet.endsWith("…"), true, "a cut snippet says that it was cut");
  assert.deepEqual(layerRows(frame), layerRows(frame), "reading the rows twice gives the same labels");
});

test("a save sends the sequence it read and adopts the sequence the save reports", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: unknown[] = [];
  const session = new SceneAutosave(
    draft(),
    async (next, expectedSeq) => {
      calls.push([next, expectedSeq]);
      return { ok: true, value: saved };
    },
    () => {},
    () => {},
  );
  try {
    const moved = moveNode(scene(), "rect-1", 10, 0);
    session.change(moved);
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.deepEqual(calls, [[moved, 4]], "the save carries the sequence that was read and the whole scene");
    assert.equal(session.state.seq, 5, "the save response advances the remembered sequence");
    assert.equal(session.state.status, "saved");
    assert.equal(session.state.dirty, false);

    const again = moveNode(moved, "rect-1", 10, 0);
    session.change(again);
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.deepEqual(calls[1], [again, 5], "the next save uses the adopted sequence");
  } finally {
    session.dispose();
  }
});

test("a conflict keeps the local scene, stops writing and surfaces the conflict", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const session = new SceneAutosave(
    draft(),
    async () => {
      calls += 1;
      return failure("concurrent_edit");
    },
    () => {},
    () => assert.fail("a refused save cannot commit"),
  );
  try {
    const local = moveNode(scene(), "rect-1", 60, 0);
    session.change(local);
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.deepEqual(
      [session.state.status, session.state.dirty, session.state.seq],
      ["conflict", true, 4],
      "the conflict path keeps the position the person wrote against",
    );
    assert.deepEqual(session.state.scene, local, "the drag is not lost");

    const further = moveNode(local, "rect-1", 20, 0);
    session.change(further);
    assert.deepEqual(session.state.scene, further, "editing continues locally during a conflict");
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.equal(calls, 1, "a conflict stops the writer instead of overwriting the newer version");
    assert.equal(session.state.status, "conflict");
    assert.equal(session.beginReload(), true, "the editor can offer the current version");
  } finally {
    session.dispose();
  }
});

test("the canvas screen wires every required gesture to the scene writer", () => {
  const page = source("../apps/dashboard/src/CanvasEditorPage.tsx");
  const markdown = source("../apps/dashboard/src/EditorPage.tsx");
  assert.match(page, /new SceneAutosave\(/);
  assert.match(page, /saveScene\(/);
  assert.match(page, /moveNode\(/);
  assert.match(page, /resizeNode\(/);
  assert.match(page, /addTextNode\(/);
  assert.match(page, /addRectNode\(/);
  assert.match(page, /removeNode\(/);
  assert.match(page, /updateTextNode\(/);
  assert.match(page, /fitScale\(/);
  assert.match(page, /aria-label="Frames"/);
  assert.match(page, /aria-label="Canvas zoom"/);
  assert.match(page, /event\.key === "ArrowRight"/);
  assert.match(page, /event\.key === "ArrowLeft"/);
  assert.match(page, /event\.key === "Delete"/);
  assert.match(page, /aria-label="Text content"/);
  assert.match(page, /aria-label="Font size"/);
  assert.match(page, /aria-label="Font weight"/);
  assert.match(page, /aria-label="Text colour"/);
  assert.match(page, /useState<string\[\]>\(\[\]\)/);
  assert.match(page, /selectNodesInRect\(frame/);
  assert.match(page, /MARQUEE_THRESHOLD/);
  assert.match(page, /moveNodes\(/);
  assert.match(page, /selectionBounds\(/);
  assert.match(page, /insideBounds\(/);
  assert.match(page, /const startGroupDrag =/);
  assert.match(page, /bringToFront\(/);
  assert.match(page, /sendToBack\(/);
  assert.match(page, /aria-label="Bring selection to front"/);
  assert.match(page, /aria-label="Send selection to back"/);
  assert.match(page, /aria-label="Delete selection"/);
  assert.match(page, /canvas-marquee/);
  assert.match(page, /event\.shiftKey/);
  assert.match(page, /reorderNodeTo\(/);
  assert.match(page, /nudgeSelection\(/);
  assert.match(page, /layerRows\(/);
  assert.match(page, /surfaceLayout\(/);
  assert.match(page, /moveFrame\(/);
  assert.match(page, /type FrameDrag = \{/);
  assert.match(page, /frameDragged/);
  assert.match(page, /onWheel/);
  assert.match(page, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(page, /wheelPan\(/);
  assert.match(page, /aria-label="Fit surface"/);
  assert.match(page, /aria-label="Layers"/);
  assert.match(page, /aria-label="Toggle layers"/);
  assert.match(page, /event\.altKey/);
  assert.match(page, /event\.key === "ArrowUp"/);
  assert.match(page, /event\.key === "ArrowDown"/);
  const css = source("../apps/dashboard/src/styles/globals.css");
  assert.match(css, /\.canvas-layers\b/);
  assert.match(css, /\.canvas-workspace\.canvas-layers-open/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 280px 240px/);
  assert.match(css, /\.canvas-marquee\b/);
  assert.match(
    css,
    /\.canvas-selection-bar \{[^}]*pointer-events: none;/,
    "the floating selection bar never swallows a press meant for the canvas under it",
  );
  assert.match(
    css,
    /\.canvas-zoom \{[^}]*pointer-events: none;/,
    "the floating zoom control never swallows a press meant for the canvas under it",
  );
  assert.match(
    css,
    /\.canvas-selection-bar > button,\s*\n\.canvas-zoom > button \{\s*\n  pointer-events: auto;/,
    "the controls inside the floating strips stay clickable",
  );
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(page, /replace_scene|add_frame|move_node|update_node/);
  const conflict = /Someone saved a newer version\.[^<]*/.exec(markdown)?.[0];
  assert.ok(conflict, "the markdown editor still carries the conflict message");
  assert.equal(
    page.includes(conflict),
    true,
    "the canvas screen shows the same conflict message instead of inventing its own",
  );
});

test("a press on a frame drags the frame through one materialising write and one history entry", () => {
  const page = source("../apps/dashboard/src/CanvasEditorPage.tsx");
  const startFrameDrag = /const startFrameDrag =[\s\S]*?const onFrameDragMove/.exec(page)?.[0];
  assert.ok(startFrameDrag, "the frame gesture still starts in one press handler");
  assert.match(
    startFrameDrag,
    /if \(readOnly \|\| event\.button !== 0 \|\| spaceHeld\.current\) return;/,
    "a read-only canvas, a non-left button and a held space still end the gesture before anything else",
  );
  assert.match(startFrameDrag, /event\.stopPropagation\(\);/, "a frame press never reaches the stage marquee");
  assert.match(startFrameDrag, /frameDragged\.current = false;/, "each press starts with no movement recorded");
  assert.match(startFrameDrag, /showFrame\(entry\.id\)/, "a press on a frame makes that frame the active one");
  assert.match(
    startFrameDrag,
    /snapshot: session\.current\?\.state\.scene \?\? scene/,
    "a frame drag snapshots the scene it starts from",
  );
  assert.match(
    startFrameDrag,
    /event\.currentTarget\.setPointerCapture\(event\.pointerId\);/,
    "a frame drag captures the pointer it started with",
  );

  const showFrame = between(page, "const showFrame =", "\n  const stepFrame =");
  assert.match(
    showFrame,
    /^\s*endTextEdit\(\);/m,
    "starting a frame drag closes an open text edit before the drag can claim its entry",
  );

  const frameMove = /const onFrameDragMove =[\s\S]*?const endFrameDrag/.exec(page)?.[0];
  assert.ok(frameMove, "a dragged frame has its own move handler");
  assert.match(
    frameMove,
    /moveFrame\(pending\.snapshot, layout\.placements, pending\.frameId, dx, dy\)/,
    "every move materialises the layout the surface is showing right now",
  );
  assert.match(frameMove, /update\(/, "every move writes through the one update funnel");
  assert.doesNotMatch(frameMove, /commitEdit\(/, "a frame drag only commits when the pointer is released");

  const endFrameDrag = /const endFrameDrag =[\s\S]*?const cancelFrameDrag/.exec(page)?.[0];
  assert.ok(endFrameDrag, "a frame drag ends in one release handler");
  assert.match(
    endFrameDrag,
    /if \(!frameDragged\.current\) return;/,
    "a press on a frame that never moved is no entry",
  );
  assert.match(
    endFrameDrag,
    /canonicalScene\(pending\.snapshot\) === canonicalScene\(session\.current\?\.state\.scene \?\? scene\)/,
    "a frame drag that left the scene as it found it is no entry either",
  );
  assert.match(endFrameDrag, /releasePointerCapture/, "the release gives the pointer back");
  assert.match(endFrameDrag, /commitEdit\(pending\.snapshot\);/, "one frame drag is one history entry");

  const frameNode = /onPointerDown=\{\(event\) => startFrameDrag\(event, entry\)\}/.exec(page)?.[0];
  assert.ok(frameNode, "the frame div is the element that owns the frame gesture");
});

test("a press inside a multi-selection drags the whole group instead of the frame around it", () => {
  const page = source("../apps/dashboard/src/CanvasEditorPage.tsx");

  const startGroupDrag = between(page, "const startGroupDrag =", "\n  const startFrameDrag =");
  assert.match(
    startGroupDrag,
    /if \(entry\.id !== frame\?\.id \|\| selected\.length < 2\) return false;/,
    "only a multi-selection of the active frame can start a group drag",
  );
  assert.match(
    startGroupDrag,
    /selectionBounds\(entry, selected\)/,
    "the rectangle is the bounds of the selected nodes of that frame",
  );
  assert.match(startGroupDrag, /insideBounds\(bounds, point\)/, "the press has to land inside that rectangle");
  assert.match(startGroupDrag, /mode: "group"/, "the press reuses the node group drag");
  assert.match(startGroupDrag, /ids: selected/, "every selected node is carried by the group drag");
  assert.match(
    startGroupDrag,
    /snapshot: session\.current\?\.state\.scene \?\? scene/,
    "a group drag snapshots the scene it starts from",
  );
  assert.doesNotMatch(
    startGroupDrag,
    /showFrame\(|setSelected\(\[\]\)/,
    "a press inside the bounds keeps the selection instead of clearing it",
  );

  const startFrameDrag = /const startFrameDrag =[\s\S]*?const onFrameDragMove/.exec(page)?.[0];
  assert.ok(startFrameDrag, "the frame gesture still starts in one press handler");
  assert.match(
    startFrameDrag,
    /if \(startGroupDrag\(event, entry\)\) \{[\s\S]*?setPointerCapture\(event\.pointerId\);[\s\S]*?return;[\s\S]*?\}/,
    "a frame press that lands inside the bounds captures the pointer for the group and ends there",
  );
  assert.equal(
    startFrameDrag.indexOf("startGroupDrag(event, entry)") < startFrameDrag.indexOf("showFrame(entry.id)"),
    true,
    "the group gesture is decided before a frame press clears the selection",
  );

  const frameMove = /const onFramePointerMove =[\s\S]*?const onFramePointerUp/.exec(page)?.[0];
  assert.ok(frameMove, "the frame move handler routes between the group and the frame gesture");
  assert.match(
    frameMove,
    /if \(drag\.current !== null\) \{[\s\S]*?onPointerMove\(event\);\s*return;/,
    "a live group drag keeps the node drag path",
  );
  assert.match(frameMove, /onFrameDragMove\(event\);/, "without a group drag the frame path still runs");
  const frameUp = /const onFramePointerUp =[\s\S]*?const onFramePointerCancel/.exec(page)?.[0];
  assert.ok(frameUp, "the frame release handler routes between the group and the frame gesture");
  assert.match(
    frameUp,
    /if \(drag\.current !== null\) \{[\s\S]*?endDrag\(event\);\s*return;/,
    "a group drag ends on the node path",
  );
  assert.match(frameUp, /endFrameDrag\(event\);/, "without a group drag the frame release still runs");
  assert.match(page, /onPointerMove=\{onFramePointerMove\}/, "the frame div moves through the router");
  assert.match(page, /onPointerUp=\{onFramePointerUp\}/, "the frame div releases through the router");

  const onPointerMove = between(page, "const onPointerMove =", "\n  const endDrag =");
  const groupBranch = /if \(current\.mode === "group"\) \{[\s\S]*?\n    \}/.exec(onPointerMove)?.[0];
  assert.ok(groupBranch, "a group drag keeps its own branch in the move handler");
  assert.match(groupBranch, /if \(!nodeDragged\.current\) return;/, "a press under the threshold writes nothing");
  assert.match(groupBranch, /update\(moveNodes\(/, "every group move writes through the one update funnel");
  assert.equal(
    groupBranch.indexOf("if (!nodeDragged.current) return;") < groupBranch.indexOf("update(moveNodes("),
    true,
    "the threshold is decided before the first write",
  );

  const startDrag = /const startDrag =[\s\S]*?const onPointerMove/.exec(page)?.[0];
  assert.ok(startDrag, "the node gesture is still one press handler");
  assert.match(
    startDrag,
    /const group = mode === "move" && isSelected\(node\.id\) && selected\.length > 1;/,
    "a press on an already selected node still drags the group",
  );
  assert.match(startDrag, /event\.stopPropagation\(\);/, "a node press never reaches the frame handler");
  assert.match(
    page,
    /onPointerDown=\{\(event\) => startDrag\(event, node, "move"\)\}/,
    "the node div still owns the node gesture",
  );
});

test("the canvas wheel pans the view by default and zooms only with ctrl or cmd", () => {
  const page = source("../apps/dashboard/src/CanvasEditorPage.tsx");
  const handler = /const onWheel = [\s\S]*?\n    \};/.exec(page)?.[0];
  assert.ok(handler, "the stage still owns one native wheel listener");

  const zoomBranch = /if \(event\.ctrlKey \|\| event\.metaKey\) \{[\s\S]*?\n      \}/.exec(handler)?.[0];
  assert.ok(zoomBranch, "ctrl or cmd plus the wheel takes its own branch");
  assert.match(zoomBranch, /event\.preventDefault\(\);/, "the zoom branch keeps the page from scrolling");
  assert.match(zoomBranch, /zoomAt\(/, "the zoom branch reuses the cursor-anchored zoom");
  assert.match(
    zoomBranch,
    /Math\.exp\(-event\.deltaY \/ WHEEL_ZOOM_STEP\)/,
    "ctrl plus a downward wheel still zooms out",
  );

  const panBranch = handler.replace(zoomBranch, "");
  assert.match(
    panBranch,
    /event\.preventDefault\(\);[\s\S]*?const moved = wheelPan\(event\.deltaX, event\.deltaY, event\.shiftKey\);/,
    "a plain wheel takes the pan path with its own deltaX, deltaY and shift",
  );
  assert.match(panBranch, /setFitted\(false\);/, "the first wheel leaves the fitted view so the pan sticks");
  assert.match(panBranch, /setPan\(/, "the pan branch writes the shared pan state");
  assert.match(panBranch, /view\.x \+ moved\.x/, "the pan is relative to where the view already is");
  assert.equal(
    handler.indexOf("event.ctrlKey || event.metaKey") < handler.indexOf("wheelPan("),
    true,
    "the zoom is decided before a wheel is allowed to pan",
  );

  const helper = /const wheelPan = [\s\S]*?;\n/.exec(page)?.[0];
  assert.ok(helper, "the wheel-to-pan mapping lives in one helper");
  assert.match(
    helper,
    /shiftKey \? \{ x: -deltaY, y: 0 \} : \{ x: -deltaX, y: -deltaY \}/,
    "scrolling down lifts the surface so the content below comes into view, and shift borrows deltaY for x",
  );
});

test("a shift click on the canvas adds to the selection instead of starting a native text selection", () => {
  const page = source("../apps/dashboard/src/CanvasEditorPage.tsx");
  const css = source("../apps/dashboard/src/styles/globals.css");

  const startDrag = /const startDrag =[\s\S]*?const onPointerMove/.exec(page)?.[0];
  assert.ok(startDrag, "the node pointer path is still one function");
  assert.match(
    startDrag,
    /if \(readOnly \|\| event\.button !== 0\) return;/,
    "a read-only canvas and a non-left button still end the gesture before anything else",
  );
  assert.match(startDrag, /event\.stopPropagation\(\);/, "a node press never reaches the stage marquee");
  const shiftBranch = /if \(event\.shiftKey\) \{[\s\S]*?\}/.exec(startDrag)?.[0];
  assert.ok(shiftBranch, "a shift press still takes its own branch before a drag starts");
  assert.match(shiftBranch, /event\.preventDefault\(\);/, "a shift click must not extend the browser's text selection");
  assert.match(shiftBranch, /return;/, "the shift branch still ends there instead of starting a drag");

  const startMarquee = /const startMarquee =[\s\S]*?const onMarqueeMove/.exec(page)?.[0];
  assert.ok(startMarquee, "the stage pointer path is still one function");
  assert.match(
    startMarquee,
    /event\.preventDefault\(\);/,
    "a drag on the stage must not start a native text selection either",
  );

  const stageWrap = /\.canvas-stage-wrap \{[^}]*\}/.exec(css)?.[0];
  assert.ok(stageWrap, "the stage wrapper keeps its rule");
  assert.match(stageWrap, /user-select: none;/, "the page text around the canvas is not selectable");
  const inspector = /\.canvas-inspector \{[^}]*\}/.exec(css)?.[0];
  assert.ok(inspector, "the inspector keeps its rule");
  assert.doesNotMatch(inspector, /user-select: none/, "the text in the inspector stays selectable");
});

test("the canvas route is gated by the registry and leaves the markdown route untouched", () => {
  const router = source("../apps/dashboard/src/router.tsx");
  const guard = router.match(/const ARTIFACT_ID = (\/.*\/);\n/)?.[1];
  assert.ok(guard, "the editors share one artifact identifier gate");
  const artifactId = new RegExp(guard.slice(1, guard.lastIndexOf("/")));
  assert.equal(artifactId.test("0f0a0b1c-2d3e-4f50-8a9b-0c1d2e3f4a5b"), true);
  assert.equal(artifactId.test("not-a-uuid"), false);
  assert.equal(artifactId.test("0f0a0b1c-2d3e-4f50-8a9b-0c1d2e3f4a5"), false);
  assert.match(router, /path: "\/canvas\/\$artifactId"/);
  assert.match(router, /path: "\/edit\/\$artifactId"/);
  assert.equal(
    (
      router.match(
        /params: \{\s*parse: \(params\) => \(ARTIFACT_ID\.test\(params\.artifactId\) \? params : false\),\s*\}/g,
      ) ?? []
    ).length,
    2,
    "a non-UUID segment must not mount either editor",
  );
  assert.match(router, /<CanvasEditorPage artifactId=/);
  assert.match(router, /<EditorPage artifactId=/);
  assert.doesNotMatch(router, /kind === "canvas"/);
  const library = source("../apps/dashboard/src/LibraryPage.tsx");
  assert.match(library, /editsSceneInApp\(artifact\.kind\)/);
  assert.match(library, /openCanvas\(artifact, window\.location\)/);
  assert.match(library, /openArtifact\(artifact, window\.location\)/);
  assert.doesNotMatch(library, /kind === "canvas"/);
});

test("the undo history keeps fifty snapshots, drops the oldest and empties redo on a new edit", async () => {
  const history = await historyModule();
  const step = (index: number) => moveNode(scene(), "rect-1", index + 1, 0);
  const steps = Array.from({ length: 51 }, (_, index) => step(index));
  let kept: Scene[] = [];
  let ahead: Scene[] = [];
  for (const before of steps) ({ undo: kept, redo: ahead } = history.commitHistory(kept, ahead, before));

  assert.equal(history.HISTORY_LIMIT, 50, "the history is capped at fifty whole-scene snapshots");
  assert.equal(kept.length, 50, "the fifty-first edit drops the oldest snapshot instead of growing the stack");
  assert.deepEqual(kept[0], steps[1], "the snapshot that goes is the oldest one");
  assert.deepEqual(kept.at(-1), steps.at(-1), "the newest snapshot waits at the top of the stack");
  assert.deepEqual(ahead, [], "storing an edit leaves nothing to redo");

  const undone = history.commitHistory([steps[0]!], [steps[1]!], step(2));
  assert.deepEqual(undone.redo, [], "an edit after an undo throws away the redo it would be walked back through");
  assert.deepEqual(undone.undo, [steps[0]!, step(2)], "the new snapshot lands on top of what was already undone");
});

test("undo and redo step one snapshot at a time and move the scene they replace to the other stack", async () => {
  const history = await historyModule();
  const first = moveNode(scene(), "rect-1", 10, 0);
  const second = moveNode(scene(), "rect-1", 20, 0);
  const current = moveNode(scene(), "rect-1", 30, 0);
  let kept: Scene[] = [];
  let ahead: Scene[] = [];
  for (const before of [first, second]) ({ undo: kept, redo: ahead } = history.commitHistory(kept, ahead, before));

  const back = history.undoHistory(kept, ahead, current);
  assert.ok(back, "the last edit can be undone");
  assert.deepEqual(back.scene, second, "undo returns the scene from before the last edit");
  assert.deepEqual(back.undo, [first], "undo pops the snapshot it returns");
  assert.deepEqual(back.redo, [current], "undo keeps the scene it replaced so it can be redone");
  assert.deepEqual(kept, [first, second], "undoing never rewrites the stack it read");

  const forward = history.redoHistory(back.undo, back.redo, back.scene);
  assert.ok(forward, "an undone edit can be redone");
  assert.deepEqual(forward.scene, current, "redo returns the scene undo replaced");
  assert.deepEqual(forward.undo, [first, second], "redo puts the snapshot it returns back on the undo stack");
  assert.deepEqual(forward.redo, [], "redo pops the entry it returns");

  assert.equal(history.undoHistory([], [], current), null, "an empty undo stack leaves the scene as it is");
  assert.equal(history.redoHistory(forward.undo, [], current), null, "an empty redo stack leaves the scene as it is");
});

test("the canvas editor keeps one history entry per document gesture and one burst per text edit", () => {
  const page = canvasPage();
  const region = historyRegion();
  assert.match(region, /HISTORY_LIMIT = 50;/, "the cap is one named constant");
  assert.match(region, /export const commitHistory =/, "the push and cap mechanics live in one pure helper");
  assert.match(region, /export const undoHistory =/, "the undo step lives in one pure helper");
  assert.match(region, /export const redoHistory =/, "the redo step lives in one pure helper");

  assert.match(page, /const undoStack = useRef<Scene\[\]>\(\[\]\);/, "the undo history is a stack of whole scenes");
  assert.match(page, /const redoStack = useRef<Scene\[\]>\(\[\]\);/, "the redo history is a stack of whole scenes");
  const commit = between(page, "const commitEdit =", "\n  const editScene =");
  assert.match(commit, /commitHistory\(undoStack\.current, redoStack\.current, before\)/);
  assert.match(commit, /undoStack\.current = next\.undo;/);
  assert.match(commit, /redoStack\.current = next\.redo;/);
  const discrete = between(page, "const editScene =", "\n  const endTextEdit =");
  assert.match(
    discrete,
    /if \(next !== current\) commitEdit\(current\);/,
    "an edit commits the scene it replaces, and only when it replaces it",
  );
  assert.match(discrete, /update\(next\);/, "an edit still goes through the single update funnel");

  const add = between(page, "const add =", "\n  const removeSelected =");
  assert.match(add, /editScene\(kind === "text"/, "adding a node is one history entry");
  assert.match(
    between(page, "const removeSelected =", "\n  const bringSelectedToFront ="),
    /editScene\(withoutNodes\(/,
    "deleting the selection is one history entry",
  );
  assert.match(
    between(page, "const bringSelectedToFront =", "\n  const sendSelectedToBack ="),
    /editScene\(bringToFront\(/,
    "bringing the selection to front is one history entry",
  );
  assert.match(
    between(page, "const sendSelectedToBack =", "\n  const showFrame ="),
    /editScene\(sendToBack\(/,
    "sending the selection to back is one history entry",
  );

  const endDrag = between(page, "const endDrag =", "\n  const layerDropIndex =");
  assert.match(endDrag, /if \(!nodeDragged\.current\) return;/, "a press that never moved is no entry");
  assert.match(
    endDrag,
    /canonicalScene\(current\.snapshot\) === canonicalScene\(session\.current\?\.state\.scene \?\? scene\)/,
    "a drag that left the scene as it found it is no entry either",
  );
  assert.match(endDrag, /commitEdit\(current\.snapshot\);/, "one drag is one entry");
  assert.doesNotMatch(
    between(page, "const onPointerMove =", "\n  const endDrag ="),
    /commitEdit\(/,
    "a drag only commits when the pointer is released, never on every move",
  );

  const startLayerDrag = between(page, "const startLayerDrag =", "\n  const onLayerDragMove =");
  assert.match(
    startLayerDrag,
    /snapshot: session\.current\?\.state\.scene \?\? scene/,
    "a layer drag snapshots the scene it starts from",
  );
  const endLayerDrag = between(page, "const endLayerDrag =", "\n  const cancelLayerDrag =");
  assert.match(endLayerDrag, /commitEdit\(pending\.snapshot\);/, "a dropped layer row is one entry");
  assert.equal(
    endLayerDrag.indexOf("commitEdit(pending.snapshot)") < endLayerDrag.indexOf("update(next)"),
    true,
    "the pre-reorder scene is committed before the reorder is written",
  );

  const endTextEdit = between(page, "const endTextEdit =", "\n  const trackTextEdit =");
  assert.match(
    endTextEdit,
    /canonicalScene\(pending\.snapshot\) === canonicalScene\(current\)/,
    "an unchanged burst is no entry",
  );
  assert.match(endTextEdit, /commitEdit\(pending\.snapshot\)/, "the snapshot taken at the burst start is the entry");
  assert.match(
    between(page, "const trackTextEdit =", "\n  const undo = useCallback("),
    /textEdit\.current = \{ id: selectedNode\.id, snapshot: session\.current\?\.state\.scene \?\? scene \}/,
    "the burst snapshots the scene before its first keystroke",
  );
  assert.match(page, /trackTextEdit\(\);\s*update\(updateTextNode\(/, "the inspector tracks a burst before it writes");
  const inspector = between(page, 'aria-label="Text properties"', "</aside>");
  assert.match(inspector, /onBlur=\{/, "the inspector closes its burst when focus leaves it");
  assert.match(inspector, /onEndEdit\(\)/, "the inspector hands the burst boundary back to the canvas screen");

  const reload = between(page, "const reload = async", "\n  const retry =");
  assert.match(reload, /undoStack\.current = \[\];/, "replacing the document forgets what was undone");
  assert.match(reload, /redoStack\.current = \[\];/, "replacing the document forgets what was redone");
});

test("ctrl or cmd with z undoes and with shift redoes, on the one scene writer every edit uses", () => {
  const page = canvasPage();
  const keydown = between(
    page,
    "const keydown = (event: KeyboardEvent) => {",
    'window.addEventListener("keydown", keydown);',
  );
  assert.match(keydown, /if \(event\.defaultPrevented \|\| event\.isComposing\) return;/, "an IME keeps its own keys");
  const modifiers = between(keydown, "if (event.metaKey || event.ctrlKey) {", "const target = event.target;");
  assert.match(modifiers, /event\.key === "z"/, "a lowercase z reaches the history");
  assert.match(modifiers, /event\.key === "Z"/, "the shifted z that carries the redo reaches the history too");
  assert.match(modifiers, /!event\.altKey/, "an alt combination still belongs to the frame shortcuts");
  assert.match(modifiers, /!readOnly/, "a read-only canvas never walks its history");
  assert.match(modifiers, /event\.preventDefault\(\)/, "the browser's own undo is replaced by the canvas one");
  assert.match(modifiers, /if \(event\.shiftKey\) redo\(\);/, "the shifted form redoes");
  assert.match(modifiers, /undo\(\);/, "the plain form undoes");
  assert.equal(
    keydown.indexOf('event.key === "z"') < keydown.indexOf("const target = event.target;"),
    true,
    "the shortcut is decided before the form-field guard so it works while a text field has focus",
  );

  const undo = between(page, "const undo = useCallback(", "\n  const redo = useCallback(");
  assert.match(undo, /undoHistory\(undoStack\.current, redoStack\.current,/, "undo asks the pure step for the scene");
  assert.match(undo, /undoStack\.current = step\.undo;/, "undo adopts the stack the step returns");
  assert.match(undo, /redoStack\.current = step\.redo;/, "undo hands the scene it replaces to redo");
  assert.match(undo, /update\(step\.scene\);/, "undo writes through the same funnel as every other edit");
  assert.match(undo, /if \(readOnly\) return;/, "a read-only canvas never walks its history");
  assert.doesNotMatch(undo, /saveScene\(/, "undo never reaches around the funnel to the server");

  const redo = between(page, "const redo = useCallback(", "\n  const toggle =");
  assert.match(redo, /redoHistory\(undoStack\.current, redoStack\.current,/, "redo asks the pure step for the scene");
  assert.match(redo, /update\(step\.scene\);/, "redo writes through the same funnel as every other edit");
  assert.match(redo, /if \(readOnly\) return;/, "a read-only canvas never walks its history");
  assert.doesNotMatch(redo, /saveScene\(/, "redo never reaches around the funnel to the server");

  assert.equal((page.match(/\.change\(/g) ?? []).length, 1, "one funnel still writes the scene");
  assert.equal(
    (page.match(/undoStack\.current =/g) ?? []).length,
    4,
    "only the edit, undo, redo and reload touch the stack",
  );
  assert.equal(
    (page.match(/redoStack\.current =/g) ?? []).length,
    4,
    "only the edit, undo, redo and reload touch the stack",
  );
});

test("selection, pan and zoom never enter the history", () => {
  const page = canvasPage();
  const zoomAt = between(page, "const zoomAt =", "\n\n  useEffect");
  const pan = between(page, "const onPanMove =", "\n  const endPan =");
  const marquee = between(page, "const onMarqueeMove =", "\n  const endMarquee =");
  const wheel = between(page, "const onWheel = (event: WheelEvent) => {", 'element.addEventListener("wheel"');
  const toggle = between(page, "const toggle =", "\n  const add =");
  const showFrame = between(page, "const showFrame =", "\n  const stepFrame =");
  for (const [label, handler] of [
    ["a pan", pan],
    ["a marquee", marquee],
    ["a wheel zoom", wheel],
    ["a click on a node", toggle],
    ["switching frames", showFrame],
  ] as const) {
    assert.doesNotMatch(handler, /commitEdit\(/, `${label} never records a history entry`);
    assert.doesNotMatch(handler, /update\(/, `${label} never writes the document`);
  }
  assert.match(zoomAt, /setPan\(/, "zooming stays in the view");
  assert.doesNotMatch(zoomAt, /commitEdit\(|update\(/, "zooming stays out of the history");
});
