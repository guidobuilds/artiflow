import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { openArtifact } from "../apps/dashboard/src/editor-api.ts";
import {
  addNode,
  bringToFront,
  fitScale,
  getScene,
  layerRows,
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
  sendToBack,
  textNode,
  updateTextNode,
} from "../apps/dashboard/src/scene-api.ts";
import { SceneAutosave } from "../apps/dashboard/src/scene-autosave.ts";
import { AUTOSAVE_MS } from "../apps/dashboard/src/editor-autosave.ts";
import type { Scene, SceneFrame } from "@artiflow/domain/scene";

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
      "a node outside its frame",
      {
        ...draft(),
        scene: { ...scene(), frames: [{ ...scene().frames[0], nodes: [{ ...scene().frames[0]!.nodes[0], x: 700 }] }] },
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

test("dragging and resizing keep a node inside its frame and every other gesture composes a whole scene", () => {
  const moved = moveNode(scene(), "rect-1", 30, 25);
  assert.deepEqual(
    [nodeOf(moved, "rect-1")?.x, nodeOf(moved, "rect-1")?.y],
    [70, 65],
    "a drag moves by its scene distance",
  );
  assert.equal(nodeOf(scene(), "rect-1")?.x, 40, "the scene before the drag is untouched");

  const clamped = moveNode(scene(), "rect-1", -500, 5000);
  assert.deepEqual(
    [nodeOf(clamped, "rect-1")?.x, nodeOf(clamped, "rect-1")?.y],
    [0, 480],
    "a drag past the frame edge stops at the edge instead of producing a scene the server refuses",
  );
  assert.deepEqual(nodeOf(moveNode(scene(), "missing", 10, 10), "rect-1"), nodeOf(scene(), "rect-1"));

  const resized = resizeNode(scene(), "rect-1", 320, 90);
  assert.deepEqual([nodeOf(resized, "rect-1")?.w, nodeOf(resized, "rect-1")?.h], [320, 90]);
  const bounded = resizeNode(scene(), "rect-1", 5000, 0);
  assert.deepEqual(
    [nodeOf(bounded, "rect-1")?.w, nodeOf(bounded, "rect-1")?.h],
    [760, 4],
    "a resize stops at the frame edge and at a size the server still accepts",
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

test("moving a selection keeps one delta for the whole group and stops it at the frame edge", () => {
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
    [500, 380, 500, 540],
    "the group stops when its own bounding box reaches the frame edge",
  );

  const backward = moveNodes(scene(), ["rect-1", "text-1"], -5000, -5000);
  assert.deepEqual(
    [
      nodeOf(backward, "rect-1")?.x,
      nodeOf(backward, "rect-1")?.y,
      nodeOf(backward, "text-1")?.x,
      nodeOf(backward, "text-1")?.y,
    ],
    [0, 0, 0, 160],
    "a backward drag stops at the same edge without stacking the nodes",
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
