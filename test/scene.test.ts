import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SCENE_FORMAT_VERSION,
  SCENE_MAX_FRAMES,
  SCENE_MAX_NODES,
  TEXT_ALIGNS,
  canonicalScene,
  readScene,
  sceneBytes,
  sceneIndex,
  sceneOutline,
  sceneSubtree,
  validateScene,
  type Scene,
} from "@artiflow/domain/scene";

const node = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "n1",
  type: "rect",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  fill: "#ffffff",
  ...overrides,
});

const frame = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "f1",
  name: "Home",
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  nodes: [node()],
  ...overrides,
});

const scene = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [frame()],
  ...overrides,
});

const accepted = (input: unknown): Scene => {
  const result = validateScene(input);
  assert.equal(result.ok, true, result.ok ? "" : `${result.reason} at ${result.path}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
};

const refusalOf = (input: unknown): { reason: string; path: string; detail?: Record<string, unknown> } => {
  const result = validateScene(input);
  assert.equal(result.ok, false, "the scene is refused instead of accepted");
  if (result.ok) throw new Error("unreachable");
  return { reason: result.reason, path: result.path, detail: result.detail };
};

test("a valid scene validates and carries every node type of this phase", () => {
  const valid = accepted(
    scene({
      frames: [
        frame({
          nodes: [
            node({ id: "rect", type: "rect", fill: "#0af", radius: 4 }),
            node({
              id: "text",
              type: "text",
              text: "Hello",
              style: { fontSize: 14, fontWeight: 600, color: "#111", align: "left" },
            }),
            node({ id: "image", type: "image", assetId: "sha256-abc" }),
            node({ id: "path", type: "path", d: "M0 0 L10 10", fill: "none", stroke: "#000", strokeWidth: 2 }),
          ],
        }),
      ],
    }),
  );
  assert.equal(valid.formatVersion, SCENE_FORMAT_VERSION);
  assert.deepEqual(
    valid.frames[0]?.nodes.map((entry) => entry.type),
    ["rect", "text", "image", "path"],
  );
  assert.ok(TEXT_ALIGNS.includes("left"), "the alignment vocabulary is exported for the renderer");
});

test("a node type the renderer cannot draw is refused by name", () => {
  const refusal = refusalOf(scene({ frames: [frame({ nodes: [node({ type: "video" })] })] }));
  assert.equal(refusal.reason, "unknown_node_type");
  assert.equal(refusal.path, "frames[0].nodes[0].type");
  assert.equal(refusal.detail?.type, "video");
});

test("the same id twice anywhere in the frame tree is refused", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    [
      "two nodes in one frame",
      scene({ frames: [frame({ nodes: [node({ id: "dup" }), node({ id: "dup" })] })] }),
      "dup",
    ],
    [
      "two nodes in different frames",
      scene({
        frames: [frame({ id: "a", nodes: [node({ id: "dup" })] }), frame({ id: "b", nodes: [node({ id: "dup" })] })],
      }),
      "dup",
    ],
    [
      "a node that reuses its frame id",
      scene({ frames: [frame({ id: "same", nodes: [node({ id: "same" })] })] }),
      "same",
    ],
    ["two frames", scene({ frames: [frame({ id: "dup" }), frame({ id: "dup" })] }), "dup"],
  ];
  for (const [label, input, id] of cases) {
    const refusal = refusalOf(input);
    assert.equal(refusal.reason, "duplicate_id", label);
    assert.equal(refusal.detail?.id, id, label);
  }
});

test("a scene without a format version is refused", () => {
  const missing = scene();
  delete missing.formatVersion;
  const refusal = refusalOf(missing);
  assert.equal(refusal.reason, "missing_format_version");
  assert.equal(refusal.path, "formatVersion");
});

test("a format version newer than the reader is refused rather than half read", () => {
  const refusal = refusalOf(scene({ formatVersion: SCENE_FORMAT_VERSION + 1 }));
  assert.equal(refusal.reason, "unsupported_format_version");
  assert.equal(refusal.path, "formatVersion");
  assert.equal(refusal.detail?.version, SCENE_FORMAT_VERSION + 1);
});

test("a node may sit outside its frame at any coordinate", () => {
  for (const [label, placed] of [
    ["wider than its frame", node({ w: 200 })],
    ["past its frame's left edge", node({ x: -1 })],
    ["past its frame's bottom edge", node({ y: 40, h: 70 })],
    ["entirely away from its frame", node({ x: -500, y: -400, w: 900, h: 800 })],
  ] as const) {
    const value = accepted(scene({ frames: [frame({ nodes: [placed] })] }));
    assert.deepEqual(value.frames[0]?.nodes[0], placed, label);
  }
});

test("a negative position is kept as written instead of refused", () => {
  const value = accepted(scene({ frames: [frame({ nodes: [node({ x: -30, y: -20, w: 50, h: 40 })] })] }));
  assert.deepEqual(
    [value.frames[0]?.nodes[0]?.x, value.frames[0]?.nodes[0]?.y],
    [-30, -20],
    "the reader keeps the coordinates the writer chose",
  );
});

test("a coordinate that is not a finite number is refused", () => {
  for (const input of [
    scene({ frames: [frame({ nodes: [node({ x: Number.NaN })] })] }),
    scene({ frames: [frame({ nodes: [node({ h: Number.POSITIVE_INFINITY })] })] }),
    scene({ frames: [frame({ w: Number.NEGATIVE_INFINITY })] }),
  ]) {
    const refusal = refusalOf(input);
    assert.equal(refusal.reason, "non_finite_number");
    assert.ok(refusal.path.length > 0, "the refusal names the offending path");
  }
});

test("a property the renderer cannot honour is refused instead of ignored", () => {
  for (const property of ["layout", "constraints", "componentId"]) {
    const onNode = refusalOf(scene({ frames: [frame({ nodes: [node({ [property]: { mode: "auto" } })] })] }));
    assert.equal(onNode.reason, "unsupported_property", property);
    assert.equal(onNode.path, `frames[0].nodes[0].${property}`);
    assert.equal(onNode.detail?.property, property);

    const onFrame = refusalOf(scene({ frames: [frame({ [property]: "auto" })] }));
    assert.equal(onFrame.reason, "unsupported_property", property);
    assert.equal(onFrame.path, `frames[0].${property}`);
  }
});

test("nesting deeper than the format allows is refused", () => {
  const refusal = refusalOf(scene({ frames: [frame({ nodes: [node({ nodes: [node({ id: "nested" })] })] })] }));
  assert.equal(refusal.reason, "too_deep");
  assert.equal(refusal.path, "frames[0].nodes[0].nodes");
});

test("a scene over the node cap is refused instead of stored", () => {
  const nodes = Array.from({ length: SCENE_MAX_NODES + 1 }, (_unused, index) => node({ id: `n${index}`, w: 0, h: 0 }));
  const refusal = refusalOf(scene({ frames: [frame({ nodes })] }));
  assert.equal(refusal.reason, "node_limit");
  assert.equal(refusal.detail?.limit, SCENE_MAX_NODES);
});

test("a scene over the frame cap is refused instead of stored", () => {
  const frames = Array.from({ length: SCENE_MAX_FRAMES + 1 }, (_unused, index) =>
    frame({ id: `f${index}`, nodes: [] }),
  );
  const refusal = refusalOf(scene({ frames }));
  assert.equal(refusal.reason, "frame_limit");
  assert.equal(refusal.detail?.limit, SCENE_MAX_FRAMES);
});

test("a frame without a name is a shape refusal, not an unlabelled outline", () => {
  const unnamed = frame();
  delete unnamed.name;
  const refusal = refusalOf(scene({ frames: [unnamed] }));
  assert.equal(refusal.reason, "malformed_scene");
  assert.equal(refusal.path, "frames[0].name");
});

test("a document that is not a scene at all is refused", () => {
  assert.equal(refusalOf(null).reason, "malformed_scene");
  assert.equal(refusalOf([]).reason, "malformed_scene");
  assert.equal(refusalOf({ formatVersion: SCENE_FORMAT_VERSION }).reason, "malformed_scene");
  const notJson = readScene("{ this is not json");
  assert.equal(notJson.ok, false);
  if (!notJson.ok) assert.equal(notJson.reason, "malformed_scene");
});

test("the same scene serialises to the same bytes whatever the key order", () => {
  const left = {
    formatVersion: 1,
    frames: [
      {
        h: 100,
        y: 0,
        name: "Home",
        id: "f1",
        w: 100,
        x: 0,
        nodes: [{ y: 0, type: "rect", h: 10, x: 0, w: 10, fill: "#fff", id: "n1", radius: -0 }],
      },
    ],
  };
  const right = {
    frames: [
      {
        nodes: [{ id: "n1", fill: "#fff", radius: 0, w: 10, x: 0, h: 10, type: "rect", y: 0 }],
        x: 0,
        w: 100,
        id: "f1",
        name: "Home",
        y: 0,
        h: 100,
      },
    ],
    formatVersion: 1,
  };
  const canonical = canonicalScene(accepted(left));
  assert.equal(canonical, canonicalScene(accepted(right)), "key order never changes the bytes");
  assert.deepEqual(sceneBytes(accepted(left)), sceneBytes(accepted(right)), "the stored bytes are identical");
  assert.equal(new TextDecoder().decode(sceneBytes(accepted(left))), canonical, "the bytes are the canonical text");
});

test("canonical serialisation sorts keys and carries no incidental whitespace", () => {
  const canonical = canonicalScene(
    accepted(
      scene({
        frames: [frame({ nodes: [node({ id: "n1", type: "rect", fill: "#fff", radius: 2 })] })],
      }),
    ),
  );
  assert.equal(
    canonical,
    '{"formatVersion":1,"frames":[{"h":100,"id":"f1","name":"Home","nodes":[{"fill":"#fff","h":10,"id":"n1","radius":2,"type":"rect","w":10,"x":0,"y":0}],"w":100,"x":0,"y":0}]}',
  );
  assert.equal(/\s/.test(canonical), false, "no incidental whitespace lands in the signature");
});

test("the node index names the frame and geometry of every node of the scene", () => {
  const valid = accepted(
    scene({
      frames: [
        frame({ id: "a", nodes: [node({ id: "a1" }), node({ id: "a2", type: "text", text: "hi" })] }),
        frame({
          id: "b",
          x: 400,
          nodes: [node({ id: "b1", type: "image", assetId: "asset-1", x: 5, y: 6, w: 7, h: 8 })],
        }),
      ],
    }),
  );
  const index = sceneIndex(valid);
  assert.deepEqual(Object.keys(index).sort(), ["a1", "a2", "b1"]);
  assert.deepEqual(index.a1, { frameId: "a", type: "rect", x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(index.a2, { frameId: "a", type: "text", x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(index.b1, { frameId: "b", type: "image", x: 5, y: 6, w: 7, h: 8 });
});

test("the outline exposes one row per frame and nothing else", () => {
  const valid = accepted(
    scene({
      frames: [
        frame({ id: "a", x: 0, y: 0, nodes: [node({ id: "a1" }), node({ id: "a2", x: 20, y: 10, w: 30, h: 40 })] }),
        frame({ id: "b", name: "Settings", x: 400, y: 20, nodes: [node({ id: "b1", x: 5, y: 6, w: 7, h: 8 })] }),
        frame({ id: "c", name: "Empty", x: 800, y: 10, w: 200, h: 150, nodes: [] }),
      ],
    }),
  );
  const outline = sceneOutline(valid);
  assert.deepEqual(
    outline.map((entry) => Object.keys(entry).sort()),
    [
      ["bbox", "id", "name", "nodeCount"],
      ["bbox", "id", "name", "nodeCount"],
      ["bbox", "id", "name", "nodeCount"],
    ],
    "the outline carries the four declared keys only",
  );
  assert.deepEqual(outline[0], { id: "a", name: "Home", nodeCount: 2, bbox: { x: 0, y: 0, w: 50, h: 50 } });
  assert.deepEqual(outline[1], { id: "b", name: "Settings", nodeCount: 1, bbox: { x: 405, y: 26, w: 7, h: 8 } });
  assert.deepEqual(outline[2], { id: "c", name: "Empty", nodeCount: 0, bbox: { x: 800, y: 10, w: 200, h: 150 } });
});

test("a subtree is one frame with its nodes, never the rest of the scene", () => {
  const valid = accepted(
    scene({
      frames: [frame({ id: "a", nodes: [node({ id: "a1" })] }), frame({ id: "b", nodes: [node({ id: "b1" })] })],
    }),
  );
  const only = sceneSubtree(valid, "b");
  assert.ok(only, "the named frame is returned");
  assert.equal(only.id, "b");
  assert.deepEqual(
    only.nodes.map((entry) => entry.id),
    ["b1"],
  );
  assert.equal("frames" in only, false, "the answer holds no other frame");
  assert.equal(sceneSubtree(valid, "missing"), null);
});

test("an unknown property survives a round trip through the canonical bytes", () => {
  const first = accepted(
    scene({
      frames: [
        frame({
          futureFrameProperty: { pinned: true },
          nodes: [node({ futureBlur: { amount: 3 }, hidden: true, style: { futureTracking: 0.1 } })],
        }),
      ],
    }),
  );
  const bytes = canonicalScene(first);
  const reread = readScene(bytes);
  assert.equal(reread.ok, true);
  if (!reread.ok) throw new Error("unreachable");
  const written = reread.value.frames[0] as Record<string, unknown>;
  assert.deepEqual(written.futureFrameProperty, { pinned: true });
  const writtenNode = (written.nodes as Record<string, unknown>[])[0];
  assert.deepEqual(writtenNode?.futureBlur, { amount: 3 });
  assert.equal(writtenNode?.hidden, true);
  assert.equal(canonicalScene(reread.value), bytes, "a reread scene serialises to the same bytes");
});

const loose = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "c1",
  type: "rect",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  fill: "#ffffff",
  ...overrides,
});

test("a scene with loose canvas nodes validates them without any frame", () => {
  const valid = accepted(
    scene({
      nodes: [
        loose({ id: "c-rect", x: -40, y: -20, radius: 2 }),
        loose({ id: "c-text", type: "text", text: "Loose", style: { align: "right" } }),
        loose({ id: "c-image", type: "image", assetId: "sha256-abc", w: 5000, h: 5000 }),
        loose({ id: "c-path", type: "path", d: "M0 0 L1 1", stroke: "#000", strokeWidth: 1 }),
      ],
    }),
  );
  assert.deepEqual(
    valid.nodes?.map((entry) => entry.id),
    ["c-rect", "c-text", "c-image", "c-path"],
  );
  assert.deepEqual(
    valid.nodes?.map((entry) => entry.type),
    ["rect", "text", "image", "path"],
  );
  assert.deepEqual(
    valid.frames[0]?.nodes.map((entry) => entry.id),
    ["n1"],
    "a loose node never lands in a frame",
  );
  assert.equal(
    valid.nodes?.[0]?.x,
    -40,
    "a loose node has no frame, so negative coordinates and overflowing sizes are legal",
  );
});

test("a loose node is refused by the same checks as a frame node", () => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    ["a loose id a frame node already uses", scene({ nodes: [loose({ id: "n1" })] }), "duplicate_id", "nodes[0].id"],
    [
      "two loose nodes sharing an id",
      scene({ nodes: [loose({ id: "c1" }), loose({ id: "c1" })] }),
      "duplicate_id",
      "nodes[1].id",
    ],
    ["a loose id a frame uses", scene({ nodes: [loose({ id: "f1" })] }), "duplicate_id", "nodes[0].id"],
    [
      "a loose type the renderer cannot draw",
      scene({ nodes: [loose({ type: "video" })] }),
      "unknown_node_type",
      "nodes[0].type",
    ],
    [
      "a coordinate that is not finite",
      scene({ nodes: [loose({ x: Number.NaN })] }),
      "non_finite_number",
      "nodes[0].x",
    ],
    ["an infinite size", scene({ nodes: [loose({ h: Number.POSITIVE_INFINITY })] }), "non_finite_number", "nodes[0].h"],
    ["a negative width", scene({ nodes: [loose({ w: -1 })] }), "malformed_scene", "nodes[0].w"],
    ["a negative height", scene({ nodes: [loose({ h: -1 })] }), "malformed_scene", "nodes[0].h"],
    ["a nested nodes key", scene({ nodes: [loose({ nodes: [] })] }), "too_deep", "nodes[0].nodes"],
    [
      "a property the renderer cannot honour",
      scene({ nodes: [loose({ layout: "auto" })] }),
      "unsupported_property",
      "nodes[0].layout",
    ],
    [
      "a shape the node type requires",
      scene({ nodes: [loose({ fill: undefined })] }),
      "malformed_scene",
      "nodes[0].fill",
    ],
    ["a loose node that is not an object", scene({ nodes: ["c1"] }), "malformed_scene", "nodes[0]"],
  ];
  for (const [label, input, reason, path] of cases) {
    const refusal = refusalOf(input);
    assert.equal(refusal.reason, reason, label);
    assert.equal(refusal.path, path, label);
  }
  assert.equal(refusalOf(scene({ nodes: [loose({ id: "n1" })] })).detail?.id, "n1");
  assert.equal(refusalOf(scene({ nodes: [loose({ type: "video" })] })).detail?.type, "video");
  assert.equal(refusalOf(scene({ nodes: [loose({ layout: "auto" })] })).detail?.property, "layout");
});

test("a nodes key that is not an array of nodes is refused instead of half read", () => {
  for (const nodes of ["c1", { id: "c1" }, 7]) {
    const refusal = refusalOf(scene({ nodes }));
    assert.equal(refusal.reason, "malformed_scene", JSON.stringify(nodes));
    assert.equal(refusal.path, "nodes");
  }
});

test("loose nodes and frame nodes share one node budget", () => {
  const inside = Array.from({ length: SCENE_MAX_NODES - 1 }, (_unused, index) => node({ id: `n${index}`, w: 0, h: 0 }));
  const full = accepted(scene({ frames: [frame({ nodes: inside })], nodes: [loose({ id: "c1", w: 0, h: 0 })] }));
  assert.equal((full.frames[0]?.nodes.length ?? 0) + (full.nodes?.length ?? 0), SCENE_MAX_NODES);
  const refusal = refusalOf(
    scene({ frames: [frame({ nodes: inside })], nodes: [loose({ id: "c1", w: 0, h: 0 }), loose({ id: "c2" })] }),
  );
  assert.equal(refusal.reason, "node_limit");
  assert.equal(refusal.detail?.limit, SCENE_MAX_NODES);
  assert.equal(refusal.path, "nodes[1]");
});

test("a scene without loose nodes serialises to the bytes it always had", () => {
  const canonical = canonicalScene(accepted(scene()));
  assert.equal(
    canonical,
    '{"formatVersion":1,"frames":[{"h":100,"id":"f1","name":"Home","nodes":[{"fill":"#ffffff","h":10,"id":"n1","type":"rect","w":10,"x":0,"y":0}],"w":100,"x":0,"y":0}]}',
    "the frame-only bytes are unchanged",
  );
  assert.equal(canonicalScene(accepted(scene({ nodes: [] }))), canonical, "an empty nodes array adds no key");
  const reread = readScene(canonical);
  assert.equal(reread.ok, true);
  if (reread.ok) assert.equal("nodes" in (reread.value as Record<string, unknown>), false, "no nodes key is invented");
});

test("loose nodes serialise after the frames and round trip exactly", () => {
  const first = accepted(scene({ nodes: [loose({ id: "c1" })] }));
  const bytes = canonicalScene(first);
  assert.equal(
    bytes,
    '{"formatVersion":1,"frames":[{"h":100,"id":"f1","name":"Home","nodes":[{"fill":"#ffffff","h":10,"id":"n1","type":"rect","w":10,"x":0,"y":0}],"w":100,"x":0,"y":0}],"nodes":[{"fill":"#ffffff","h":10,"id":"c1","type":"rect","w":10,"x":0,"y":0}]}',
  );
  const reread = readScene(bytes);
  assert.equal(reread.ok, true);
  if (!reread.ok) throw new Error("unreachable");
  assert.deepEqual(
    reread.value.nodes?.map((entry) => entry.id),
    ["c1"],
  );
  assert.equal(canonicalScene(reread.value), bytes, "a reread scene serialises to the same bytes");
});
