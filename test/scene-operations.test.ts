import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SCENE_FORMAT_VERSION,
  canonicalScene,
  readScene,
  validateScene,
  type Scene,
  type SceneNode,
} from "@artiflow/domain/scene";
import { applySceneOperations, diffSceneOperations, type SceneOperation } from "@artiflow/domain/scene-operations";

const accepted = (input: unknown): Scene => {
  const result = validateScene(input);
  assert.equal(result.ok, true, result.ok ? "" : `${result.reason} at ${result.path}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
};

const base = (): Record<string, unknown> => ({
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: "f1",
      name: "Home",
      x: 100,
      y: 50,
      w: 200,
      h: 100,
      nodes: [
        { id: "n1", type: "rect", x: 10, y: 20, w: 30, h: 40, fill: "#ffffff" },
        { id: "n2", type: "rect", x: 60, y: 10, w: 20, h: 20, fill: "#000000" },
      ],
    },
    {
      id: "f2",
      name: "Settings",
      x: 400,
      y: 20,
      w: 100,
      h: 100,
      nodes: [{ id: "n3", type: "rect", x: 5, y: 6, w: 7, h: 8, fill: "#0af" }],
    },
  ],
});

const refusalOf = (
  scene: Scene,
  operations: SceneOperation[],
): { reason: string; opIndex: number; detail: Record<string, unknown> } => {
  const result = applySceneOperations(scene, operations);
  assert.equal(result.ok, false, "the batch is refused");
  if (result.ok) throw new Error("unreachable");
  return { reason: result.reason, opIndex: result.opIndex, detail: result.detail };
};

const outcomeOf = (scene: Scene, operations: SceneOperation[]) => {
  const result = applySceneOperations(scene, operations);
  assert.equal(result.ok, true, result.ok ? "" : `${result.reason} at ${String(result.detail.path)}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
};

const idsOf = (scene: Scene): string[] =>
  scene.frames.flatMap((frame) => [frame.id, ...frame.nodes.map((node) => node.id)]);

const nodeOf = (scene: Scene, id: string) =>
  scene.frames.flatMap((frame) => frame.nodes).find((node) => node.id === id);

const asNode = (value: Record<string, unknown>): SceneNode => value as unknown as SceneNode;

test("add_node appends one node and reports its absolute box", () => {
  const value = outcomeOf(accepted(base()), [
    { op: "add_node", frameId: "f1", node: asNode({ id: "n4", type: "rect", x: 5, y: 6, w: 7, h: 8, fill: "#0af" }) },
  ]);
  assert.equal(value.applied, 1);
  assert.deepEqual(value.boxes, [{ id: "n4", frameId: "f1", x: 105, y: 56, w: 7, h: 8 }]);
  assert.deepEqual(value.violations, [], "a sound batch reports no violation");
  assert.equal(value.scene.frames[0]?.nodes.length, 3);
  assert.equal(value.scene.frames[0]?.nodes[2]?.id, "n4");
});

test("add_frame appends one frame with its nodes and reports their absolute boxes", () => {
  const value = outcomeOf(accepted(base()), [
    {
      op: "add_frame",
      frame: {
        id: "f3",
        name: "New",
        x: 10,
        y: 20,
        w: 100,
        h: 100,
        nodes: [{ id: "n4", type: "rect", x: 1, y: 2, w: 3, h: 4, fill: "#fff" }],
      },
    },
  ]);
  assert.deepEqual(
    value.scene.frames.map((frame) => frame.id),
    ["f1", "f2", "f3"],
  );
  assert.deepEqual(value.boxes, [{ id: "n4", frameId: "f3", x: 11, y: 22, w: 3, h: 4 }]);
  assert.deepEqual(value.violations, []);
});

test("update_node changes only the given properties and keeps the absolute box", () => {
  const value = outcomeOf(accepted(base()), [{ op: "update_node", id: "n1", props: { fill: "#123456", radius: 4 } }]);
  const node = nodeOf(value.scene, "n1");
  assert.equal(node?.type === "rect" && node.fill, "#123456");
  assert.equal(node?.type === "rect" && node.radius, 4);
  assert.deepEqual(value.boxes, [{ id: "n1", frameId: "f1", x: 110, y: 70, w: 30, h: 40 }]);
  assert.equal(nodeOf(value.scene, "n2")?.type, "rect", "an untouched node keeps its shape");
});

test("move_node moves and optionally resizes inside the node's frame", () => {
  const moved = outcomeOf(accepted(base()), [{ op: "move_node", id: "n1", x: 40, y: 30 }]);
  assert.deepEqual(moved.boxes, [{ id: "n1", frameId: "f1", x: 140, y: 80, w: 30, h: 40 }]);
  const resized = outcomeOf(accepted(base()), [{ op: "move_node", id: "n1", x: 0, y: 0, w: 25, h: 35 }]);
  assert.deepEqual(resized.boxes, [{ id: "n1", frameId: "f1", x: 100, y: 50, w: 25, h: 35 }]);
  assert.equal(nodeOf(resized.scene, "n2")?.w, 20, "a sibling keeps its geometry");
});

test("reorder_node moves one node to an index inside its frame", () => {
  const value = outcomeOf(accepted(base()), [{ op: "reorder_node", id: "n1", index: 1 }]);
  assert.deepEqual(
    value.scene.frames[0]?.nodes.map((node) => node.id),
    ["n2", "n1"],
    "index 1 puts the node in front of its sibling",
  );
  assert.equal(value.applied, 1);
  assert.deepEqual(value.boxes, [], "a reordering changes no geometry");
  assert.deepEqual(value.violations, []);
  assert.equal(nodeOf(value.scene, "n1")?.x, 10, "the node keeps its coordinates");
  assert.equal(nodeOf(value.scene, "n2")?.x, 60, "the sibling keeps its coordinates");
  const back = outcomeOf(value.scene, [{ op: "reorder_node", id: "n1", index: 0 }]);
  assert.deepEqual(
    back.scene.frames[0]?.nodes.map((node) => node.id),
    ["n1", "n2"],
    "index 0 is the back of the frame",
  );
});

test("reorder_node refuses an index outside its frame or an unknown node", () => {
  for (const index of [-1, 2, 1.5]) {
    const refusal = refusalOf(accepted(base()), [{ op: "reorder_node", id: "n1", index }] as SceneOperation[]);
    assert.equal(refusal.reason, "invalid_arguments", String(index));
    assert.equal(refusal.detail.property, "index", String(index));
    assert.equal(refusal.opIndex, 0);
  }
  const notANumber = refusalOf(accepted(base()), [
    { op: "reorder_node", id: "n1", index: "1" },
  ] as unknown as SceneOperation[]);
  assert.equal(notANumber.reason, "invalid_arguments");
  assert.equal(notANumber.detail.property, "index");
  const missing = refusalOf(accepted(base()), [{ op: "reorder_node", id: "ghost", index: 0 }]);
  assert.equal(missing.reason, "unknown_node");
  assert.equal(missing.detail.id, "ghost");
});

test("remove_node drops the node and reports no box for it", () => {
  const value = outcomeOf(accepted(base()), [{ op: "remove_node", id: "n2" }]);
  assert.deepEqual(
    value.scene.frames[0]?.nodes.map((node) => node.id),
    ["n1"],
  );
  assert.deepEqual(value.boxes, []);
  assert.deepEqual(value.violations, []);
});

test("update_frame renames or moves a frame and reports its nodes' absolute boxes", () => {
  const renamed = outcomeOf(accepted(base()), [{ op: "update_frame", id: "f2", props: { name: "Second" } }]);
  assert.equal(renamed.scene.frames[1]?.name, "Second");
  assert.deepEqual(renamed.boxes, [{ id: "n3", frameId: "f2", x: 405, y: 26, w: 7, h: 8 }]);
  const moved = outcomeOf(accepted(base()), [{ op: "update_frame", id: "f2", props: { x: 0, y: 0 } }]);
  assert.deepEqual(moved.boxes, [{ id: "n3", frameId: "f2", x: 5, y: 6, w: 7, h: 8 }]);
});

test("remove_frame drops the frame and its nodes", () => {
  const value = outcomeOf(accepted(base()), [{ op: "remove_frame", id: "f2" }]);
  assert.deepEqual(
    value.scene.frames.map((frame) => frame.id),
    ["f1"],
  );
  assert.deepEqual(value.boxes, []);
  assert.equal(nodeOf(value.scene, "n3"), undefined);
});

test("replace_scene is the escape hatch and reports the boxes of the whole new scene", () => {
  const replacement = accepted({
    formatVersion: SCENE_FORMAT_VERSION,
    frames: [
      {
        id: "z",
        name: "Only",
        x: 0,
        y: 0,
        w: 50,
        h: 50,
        nodes: [{ id: "z1", type: "rect", x: 1, y: 1, w: 2, h: 2, fill: "#fff" }],
      },
    ],
  });
  const value = outcomeOf(accepted(base()), [{ op: "replace_scene", scene: replacement }]);
  assert.deepEqual(
    value.scene.frames.map((frame) => frame.id),
    ["z"],
  );
  assert.deepEqual(value.boxes, [{ id: "z1", frameId: "z", x: 1, y: 1, w: 2, h: 2 }]);
  assert.equal(canonicalScene(value.scene), canonicalScene(replacement), "the bytes are the replacement's");
});

test("an added id that already exists refuses instead of replacing", () => {
  for (const operations of [
    [
      {
        op: "add_node",
        frameId: "f2",
        node: asNode({ id: "n1", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: "#fff" }),
      },
    ],
    [
      {
        op: "add_frame",
        frame: { id: "f1", name: "Copy", x: 0, y: 0, w: 10, h: 10, nodes: [] },
      },
    ],
    [{ op: "add_node", frameId: "f1", node: asNode({ id: "f2", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: "#fff" }) }],
  ] as SceneOperation[][]) {
    const refusal = refusalOf(accepted(base()), operations);
    assert.equal(refusal.reason, "duplicate_id");
    assert.equal(refusal.opIndex, 0);
  }
});

test("adding a node of a type the renderer cannot draw refuses by name", () => {
  const refusal = refusalOf(accepted(base()), [
    { op: "add_node", frameId: "f1", node: asNode({ id: "n4", type: "video", x: 0, y: 0, w: 5, h: 5 }) },
  ]);
  assert.equal(refusal.reason, "unknown_node_type");
  assert.equal(refusal.opIndex, 0);
  assert.equal(refusal.detail.type, "video");
});

test("adding a node outside its frame refuses and names the node", () => {
  const refusal = refusalOf(accepted(base()), [
    {
      op: "add_node",
      frameId: "f1",
      node: asNode({ id: "n4", type: "rect", x: 180, y: 0, w: 30, h: 10, fill: "#fff" }),
    },
  ]);
  assert.equal(refusal.reason, "outside_frame_bounds");
  assert.equal(refusal.opIndex, 0);
  assert.equal(refusal.detail.id, "n4");
  assert.equal(refusal.detail.frameId, "f1");
});

test("moving a node out of its frame refuses", () => {
  const refusal = refusalOf(accepted(base()), [{ op: "move_node", id: "n1", x: 190, y: 0 }]);
  assert.equal(refusal.reason, "outside_frame_bounds");
  assert.equal(refusal.opIndex, 0);
  assert.equal(refusal.detail.id, "n1");
  const negative = refusalOf(accepted(base()), [{ op: "move_node", id: "n1", x: -1, y: 0 }]);
  assert.equal(negative.reason, "outside_frame_bounds");
});

test("resizing to zero refuses, whichever operation asks for it", () => {
  const cases: SceneOperation[][] = [
    [{ op: "move_node", id: "n1", x: 0, y: 0, w: 0 }],
    [{ op: "move_node", id: "n1", x: 0, y: 0, h: 0 }],
    [{ op: "update_node", id: "n1", props: { w: 0 } }],
    [{ op: "add_node", frameId: "f1", node: asNode({ id: "n4", type: "rect", x: 0, y: 0, w: 0, h: 5, fill: "#fff" }) }],
    [{ op: "update_frame", id: "f1", props: { h: 0 } }],
  ];
  for (const operations of cases) {
    const refusal = refusalOf(accepted(base()), operations);
    assert.equal(refusal.reason, "non_positive_size", JSON.stringify(operations));
    assert.equal(refusal.opIndex, 0);
  }
});

test("a coordinate that is not a finite number refuses", () => {
  for (const operations of [
    [{ op: "move_node", id: "n1", x: Number.NaN, y: 0 }],
    [{ op: "update_node", id: "n1", props: { y: Number.POSITIVE_INFINITY } }],
    [{ op: "add_frame", frame: { id: "f3", name: "Bad", x: 0, y: 0, w: Number.NaN, h: 10, nodes: [] } }],
  ] as SceneOperation[][]) {
    const refusal = refusalOf(accepted(base()), operations);
    assert.equal(refusal.reason, "non_finite_number");
    assert.equal(refusal.opIndex, 0);
  }
});

test("a property the renderer cannot honour refuses instead of landing in the scene", () => {
  for (const property of ["layout", "constraints", "componentId"]) {
    const refusal = refusalOf(accepted(base()), [
      { op: "update_node", id: "n1", props: { [property]: { mode: "auto" } } },
    ]);
    assert.equal(refusal.reason, "unsupported_property", property);
    assert.equal(refusal.detail.property, property);
    const onFrame = refusalOf(accepted(base()), [{ op: "update_frame", id: "f1", props: { [property]: "auto" } }]);
    assert.equal(onFrame.reason, "unsupported_property", property);
  }
});

test("an unknown address refuses by name", () => {
  const cases: [SceneOperation[], string, Record<string, unknown>][] = [
    [[{ op: "update_node", id: "ghost", props: { fill: "#fff" } }], "unknown_node", { id: "ghost" }],
    [[{ op: "remove_node", id: "ghost" }], "unknown_node", { id: "ghost" }],
    [[{ op: "move_node", id: "ghost", x: 0, y: 0 }], "unknown_node", { id: "ghost" }],
    [[{ op: "update_frame", id: "ghost", props: { name: "x" } }], "unknown_frame", { id: "ghost" }],
    [[{ op: "remove_frame", id: "ghost" }], "unknown_frame", { id: "ghost" }],
    [
      [
        {
          op: "add_node",
          frameId: "ghost",
          node: asNode({ id: "n4", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: "#fff" }),
        },
      ],
      "unknown_frame",
      { frameId: "ghost" },
    ],
  ];
  for (const [operations, reason, detail] of cases) {
    const refusal = refusalOf(accepted(base()), operations);
    assert.equal(refusal.reason, reason, JSON.stringify(operations));
    assert.equal(refusal.opIndex, 0);
    for (const key of Object.keys(detail)) assert.equal(refusal.detail[key], detail[key], key);
  }
});

test("a node id cannot be renamed, an empty batch and an unknown operation refuse", () => {
  const renamed = refusalOf(accepted(base()), [{ op: "update_node", id: "n1", props: { id: "renamed" } }]);
  assert.equal(renamed.reason, "invalid_arguments");
  assert.equal(renamed.detail.property, "id");
  const empty = refusalOf(accepted(base()), []);
  assert.equal(empty.reason, "empty_operations");
  assert.equal(empty.opIndex, -1);
  const unknown = refusalOf(accepted(base()), [{ op: "scale_scene", factor: 2 }] as unknown as SceneOperation[]);
  assert.equal(unknown.reason, "unknown_operation");
  assert.equal(unknown.opIndex, 0);
});

test("a batch whose second operation fails leaves the input byte-identical", () => {
  const input = accepted(base());
  const before = canonicalScene(input);
  const snapshot = JSON.stringify(input);
  const result = applySceneOperations(input, [
    { op: "add_node", frameId: "f1", node: asNode({ id: "n4", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: "#fff" }) },
    { op: "move_node", id: "n4", x: 500, y: 0 },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "outside_frame_bounds");
  assert.equal(result.opIndex, 1, "the refusal names the operation that failed");
  assert.equal(canonicalScene(input), before, "the input keeps its bytes");
  assert.equal(JSON.stringify(input), snapshot, "no operation touched the input object");
});

test("the same batch on the same scene serialises to the same bytes", () => {
  const operations: SceneOperation[] = [
    { op: "add_node", frameId: "f1", node: asNode({ id: "n4", type: "rect", x: 5, y: 5, w: 5, h: 5, fill: "#fff" }) },
    { op: "move_node", id: "n1", x: 40, y: 30 },
    { op: "update_node", id: "n2", props: { fill: "#abcdef" } },
  ];
  const first = outcomeOf(accepted(base()), operations);
  const second = outcomeOf(accepted(base()), operations);
  assert.equal(canonicalScene(first.scene), canonicalScene(second.scene));
  assert.deepEqual(idsOf(first.scene), ["f1", "n1", "n2", "n4", "f2", "n3"]);
  const reread = readScene(canonicalScene(first.scene));
  assert.equal(reread.ok, true);
  if (reread.ok) assert.equal(canonicalScene(reread.value), canonicalScene(first.scene));
  assert.deepEqual(
    first.boxes.map((box) => box.id),
    ["n1", "n2", "n4"],
    "boxes arrive in scene order whatever order the operations arrived in",
  );
});

test("a pure reordering diffs to one reorder operation, not a whole scene", () => {
  const before = accepted(base());
  const frame = before.frames[0]!;
  const after = accepted({
    formatVersion: SCENE_FORMAT_VERSION,
    frames: [{ ...frame, nodes: [frame.nodes[1], frame.nodes[0]] }, before.frames[1]],
  });
  const operations = diffSceneOperations(before, after);
  assert.deepEqual(
    operations,
    [{ op: "reorder_node", id: "n2", index: 0 }],
    "a reordering is expressible, so it is not replaced whole",
  );
  const replay = applySceneOperations(before, operations);
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(canonicalScene(replay.value.scene), canonicalScene(after));
});

test("a frame reordering the operations cannot express still falls back whole", () => {
  const before = accepted(base());
  const after = accepted({
    formatVersion: SCENE_FORMAT_VERSION,
    frames: [before.frames[1], before.frames[0]],
  });
  assert.deepEqual(
    diffSceneOperations(before, after),
    [{ op: "replace_scene", scene: after }],
    "no operation reorders frames, so the escape hatch stays the only answer",
  );
});

test("a reorder mixed with a removal, an add and a move replays exactly", () => {
  const before = accepted(base());
  const frame = before.frames[0]!;
  const after = accepted({
    formatVersion: SCENE_FORMAT_VERSION,
    frames: [
      {
        ...frame,
        nodes: [
          { id: "n9", type: "rect", x: 5, y: 50, w: 10, h: 10, fill: "#0af" },
          { ...frame.nodes[1]!, x: 70 },
        ],
      },
      before.frames[1],
    ],
  });
  const operations = diffSceneOperations(before, after);
  assert.deepEqual(
    operations.map((operation) => operation.op),
    ["remove_node", "add_node", "move_node", "reorder_node"],
    "a batch that mixes a reorder keeps its deterministic order",
  );
  const replay = applySceneOperations(before, operations);
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(canonicalScene(replay.value.scene), canonicalScene(after));
});

test("every ordering of a frame's nodes diffs to reorders that replay exactly", () => {
  const frame = {
    id: "f1",
    name: "Home",
    x: 100,
    y: 50,
    w: 200,
    h: 100,
    nodes: [
      { id: "a", type: "rect", x: 10, y: 10, w: 20, h: 20, fill: "#ffffff" },
      { id: "b", type: "rect", x: 40, y: 10, w: 20, h: 20, fill: "#000000" },
      { id: "c", type: "rect", x: 70, y: 10, w: 20, h: 20, fill: "#0af" },
    ],
  };
  const before = accepted({ formatVersion: SCENE_FORMAT_VERSION, frames: [frame] });
  const orders = [
    ["a", "b", "c"],
    ["a", "c", "b"],
    ["b", "a", "c"],
    ["b", "c", "a"],
    ["c", "a", "b"],
    ["c", "b", "a"],
  ];
  for (const order of orders) {
    const nodes = order.map((id) => frame.nodes.find((node) => node.id === id)!);
    const after = accepted({ formatVersion: SCENE_FORMAT_VERSION, frames: [{ ...frame, nodes }] });
    const operations = diffSceneOperations(before, after);
    const label = order.join();
    if (label === "a,b,c") {
      assert.deepEqual(operations, [], "the identity order needs no operation");
      continue;
    }
    assert.equal(
      operations.every((operation) => operation.op === "reorder_node"),
      true,
      `${label}: only reorders, never a whole replacement`,
    );
    const replay = applySceneOperations(before, operations);
    assert.equal(replay.ok, true, label);
    if (replay.ok) assert.equal(canonicalScene(replay.value.scene), canonicalScene(after), label);
  }
});

test("a scene that does not validate refuses the batch before any operation runs", () => {
  const broken = { formatVersion: SCENE_FORMAT_VERSION, frames: base().frames } as unknown as Scene;
  (broken.frames[0] as unknown as { nodes: unknown[] }).nodes.push({
    id: "n9",
    type: "rect",
    x: 0,
    y: 0,
    w: 500,
    h: 10,
    fill: "#fff",
  });
  const result = applySceneOperations(broken, [{ op: "remove_node", id: "n1" }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "outside_frame_bounds");
  assert.equal(result.opIndex, -1, "no operation is blamed for a scene that was already unsound");
});

const withCanvas = (): Record<string, unknown> => ({
  ...base(),
  nodes: [
    { id: "c1", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#ffffff" },
    { id: "c2", type: "rect", x: 20, y: 0, w: 10, h: 10, fill: "#000000" },
  ],
});

const canvasNode = (scene: Scene, id: string) => (scene.nodes ?? []).find((node) => node.id === id);

const canvasIds = (scene: Scene): (string | undefined)[] => (scene.nodes ?? []).map((node) => node.id);

const replayMatches = (from: Scene, to: Scene): SceneOperation[] => {
  const operations = diffSceneOperations(from, to);
  assert.equal(
    operations.some((operation) => operation.op === "replace_scene"),
    false,
    "a loose-node change is expressible, so it is never replaced whole",
  );
  const replay = applySceneOperations(from, operations);
  assert.equal(replay.ok, true, replay.ok ? "" : `${replay.reason} at ${String(replay.detail.path)}`);
  if (replay.ok) assert.equal(canonicalScene(replay.value.scene), canonicalScene(to));
  return operations;
};

test("add_canvas_node appends one loose node and reports no box", () => {
  const value = outcomeOf(accepted(base()), [
    { op: "add_canvas_node", node: asNode({ id: "c1", type: "rect", x: -30, y: 900, w: 10, h: 10, fill: "#0af" }) },
  ]);
  assert.equal(value.applied, 1);
  assert.deepEqual(canvasIds(value.scene), ["c1"]);
  assert.equal(canvasNode(value.scene, "c1")?.x, -30, "a loose node keeps coordinates no frame could hold");
  assert.deepEqual(value.boxes, [], "a loose node has no frame, so it reports no box");
  assert.deepEqual(value.violations, []);
  const appended = outcomeOf(accepted(withCanvas()), [
    { op: "add_canvas_node", node: asNode({ id: "c3", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: "#fff" }) },
  ]);
  assert.deepEqual(canvasIds(appended.scene), ["c1", "c2", "c3"], "a new loose node goes to the front of the canvas");
  assert.deepEqual(
    appended.scene.frames.map((frame) => frame.nodes.length),
    [2, 1],
    "creating a loose node never touches a frame",
  );
});

test("add_canvas_node refuses a duplicate id, an unknown type and bad geometry", () => {
  const duplicateFrameNode = refusalOf(accepted(base()), [
    { op: "add_canvas_node", node: asNode({ id: "n1", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: "#fff" }) },
  ]);
  assert.equal(duplicateFrameNode.reason, "duplicate_id");
  assert.equal(duplicateFrameNode.detail.id, "n1");
  assert.equal(duplicateFrameNode.opIndex, 0);
  const duplicateLooseNode = refusalOf(accepted(withCanvas()), [
    { op: "add_canvas_node", node: asNode({ id: "c1", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: "#fff" }) },
  ]);
  assert.equal(duplicateLooseNode.reason, "duplicate_id");
  assert.equal(duplicateLooseNode.detail.id, "c1");
  const unknownType = refusalOf(accepted(base()), [
    { op: "add_canvas_node", node: asNode({ id: "c1", type: "video", x: 0, y: 0, w: 5, h: 5 }) },
  ]);
  assert.equal(unknownType.reason, "unknown_node_type");
  assert.equal(unknownType.detail.type, "video");
  const zeroWidth = refusalOf(accepted(base()), [
    { op: "add_canvas_node", node: asNode({ id: "c1", type: "rect", x: 0, y: 0, w: 0, h: 5, fill: "#fff" }) },
  ]);
  assert.equal(zeroWidth.reason, "non_positive_size");
  assert.equal(zeroWidth.detail.property, "w");
  const notFinite = refusalOf(accepted(base()), [
    { op: "add_canvas_node", node: asNode({ id: "c1", type: "rect", x: Number.NaN, y: 0, w: 5, h: 5, fill: "#fff" }) },
  ]);
  assert.equal(notFinite.reason, "non_finite_number");
  assert.equal(notFinite.detail.property, "x");
  const withoutId = refusalOf(accepted(base()), [
    { op: "add_canvas_node", node: asNode({ type: "rect", x: 0, y: 0, w: 5, h: 5, fill: "#fff" }) },
  ]);
  assert.equal(withoutId.reason, "invalid_arguments");
  assert.equal(withoutId.detail.property, "id");
});

test("update_canvas_node changes only the given properties of a loose node", () => {
  const value = outcomeOf(accepted(withCanvas()), [
    { op: "update_canvas_node", id: "c1", props: { fill: "#123456", radius: 3 } },
  ]);
  const painted = canvasNode(value.scene, "c1");
  assert.equal(painted?.type === "rect" && painted.fill, "#123456");
  assert.equal(painted?.type === "rect" && painted.radius, 3);
  const sibling = canvasNode(value.scene, "c2");
  assert.equal(sibling?.type === "rect" && sibling.fill, "#000000", "a sibling keeps its paint");
  assert.equal(value.scene.frames[0]?.nodes[0]?.id, "n1", "a frame node is untouched");
  assert.deepEqual(value.boxes, [], "a loose node reports no box");
  assert.deepEqual(value.violations, []);
});

test("update_canvas_node refuses an unknown id, a rename and bad geometry", () => {
  const unknown = refusalOf(accepted(withCanvas()), [
    { op: "update_canvas_node", id: "ghost", props: { fill: "#fff" } },
  ]);
  assert.equal(unknown.reason, "unknown_node");
  assert.equal(unknown.detail.id, "ghost");
  assert.equal(unknown.opIndex, 0);
  const frameNode = refusalOf(accepted(base()), [{ op: "update_canvas_node", id: "n1", props: { fill: "#fff" } }]);
  assert.equal(frameNode.reason, "unknown_node", "a frame node is not a loose node");
  const renamed = refusalOf(accepted(withCanvas()), [{ op: "update_canvas_node", id: "c1", props: { id: "c9" } }]);
  assert.equal(renamed.reason, "invalid_arguments");
  assert.equal(renamed.detail.property, "id");
  const zero = refusalOf(accepted(withCanvas()), [{ op: "update_canvas_node", id: "c1", props: { w: 0 } }]);
  assert.equal(zero.reason, "non_positive_size");
  assert.equal(zero.detail.property, "w");
  const property = refusalOf(accepted(withCanvas()), [
    { op: "update_canvas_node", id: "c1", props: { layout: "auto" } },
  ]);
  assert.equal(property.reason, "unsupported_property");
  assert.equal(property.detail.property, "layout");
});

test("move_canvas_node moves and resizes a loose node without any frame bounds", () => {
  const value = outcomeOf(accepted(withCanvas()), [{ op: "move_canvas_node", id: "c1", x: -500, y: 900 }]);
  assert.equal(canvasNode(value.scene, "c1")?.x, -500);
  assert.equal(canvasNode(value.scene, "c1")?.y, 900);
  assert.deepEqual(value.boxes, [], "a loose node reports no box");
  assert.deepEqual(value.violations, []);
  const resized = outcomeOf(accepted(withCanvas()), [{ op: "move_canvas_node", id: "c2", x: 20, y: 0, w: 25, h: 35 }]);
  assert.equal(canvasNode(resized.scene, "c2")?.w, 25);
  assert.equal(canvasNode(resized.scene, "c2")?.h, 35);
  assert.equal(canvasNode(resized.scene, "c1")?.w, 10, "a sibling keeps its geometry");
  assert.equal(resized.scene.frames[0]?.nodes[0]?.x, 10, "no frame node moves with it");
});

test("move_canvas_node refuses an unknown node, a missing coordinate and a zero size", () => {
  const unknown = refusalOf(accepted(base()), [{ op: "move_canvas_node", id: "ghost", x: 0, y: 0 }]);
  assert.equal(unknown.reason, "unknown_node");
  assert.equal(unknown.detail.id, "ghost");
  for (const operations of [
    [{ op: "move_canvas_node", id: "c1", x: 0, y: 0, w: 0 }],
    [{ op: "move_canvas_node", id: "c1", x: 0, y: 0, h: 0 }],
  ] as SceneOperation[][]) {
    const refusal = refusalOf(accepted(withCanvas()), operations);
    assert.equal(refusal.reason, "non_positive_size", JSON.stringify(operations));
    assert.equal(refusal.opIndex, 0);
  }
  const notFinite = refusalOf(accepted(withCanvas()), [{ op: "move_canvas_node", id: "c1", x: Number.NaN, y: 0 }]);
  assert.equal(notFinite.reason, "non_finite_number");
  assert.equal(notFinite.detail.property, "x");
  const noY = refusalOf(accepted(withCanvas()), [
    { op: "move_canvas_node", id: "c1", x: 0 } as unknown as SceneOperation,
  ]);
  assert.equal(noY.reason, "invalid_arguments");
  assert.equal(noY.detail.property, "y");
});

test("remove_canvas_node drops one loose node and nothing else", () => {
  const value = outcomeOf(accepted(withCanvas()), [{ op: "remove_canvas_node", id: "c1" }]);
  assert.deepEqual(canvasIds(value.scene), ["c2"]);
  assert.deepEqual(
    value.scene.frames.map((frame) => frame.nodes.length),
    [2, 1],
    "the frames keep their nodes",
  );
  assert.deepEqual(value.boxes, [], "a removal reports no box");
  assert.deepEqual(value.violations, []);
  const unknown = refusalOf(accepted(withCanvas()), [{ op: "remove_canvas_node", id: "ghost" }]);
  assert.equal(unknown.reason, "unknown_node");
  assert.equal(unknown.detail.id, "ghost");
  const frameNode = refusalOf(accepted(base()), [{ op: "remove_canvas_node", id: "n1" }]);
  assert.equal(frameNode.reason, "unknown_node", "a frame node is removed with remove_node only");
});

test("reorder_canvas_node moves one loose node to an index inside the canvas", () => {
  const value = outcomeOf(accepted(withCanvas()), [{ op: "reorder_canvas_node", id: "c1", index: 1 }]);
  assert.deepEqual(canvasIds(value.scene), ["c2", "c1"], "index 1 puts the node in front of its sibling");
  assert.equal(value.applied, 1);
  assert.deepEqual(value.boxes, [], "a reordering changes no geometry");
  assert.deepEqual(value.violations, []);
  assert.equal(canvasNode(value.scene, "c1")?.x, 0, "the node keeps its coordinates");
  const back = outcomeOf(value.scene, [{ op: "reorder_canvas_node", id: "c1", index: 0 }]);
  assert.deepEqual(canvasIds(back.scene), ["c1", "c2"], "index 0 is the back of the canvas");
});

test("reorder_canvas_node refuses a non-integer or negative index and an unknown node", () => {
  for (const index of [-1, 1.5, 0.5, 99]) {
    const refusal = refusalOf(accepted(withCanvas()), [
      { op: "reorder_canvas_node", id: "c1", index },
    ] as SceneOperation[]);
    assert.equal(refusal.reason, "invalid_arguments", String(index));
    assert.equal(refusal.detail.property, "index", String(index));
    assert.equal(refusal.opIndex, 0);
  }
  const notANumber = refusalOf(accepted(withCanvas()), [
    { op: "reorder_canvas_node", id: "c1", index: "1" },
  ] as unknown as SceneOperation[]);
  assert.equal(notANumber.reason, "invalid_arguments");
  assert.equal(notANumber.detail.property, "index");
  const missing = refusalOf(accepted(withCanvas()), [{ op: "reorder_canvas_node", id: "ghost", index: 0 }]);
  assert.equal(missing.reason, "unknown_node");
  assert.equal(missing.detail.id, "ghost");
});

test("a pure loose-node change diffs to loose-node operations, never a whole replacement", () => {
  const empty = accepted(base());
  const rect = { id: "c1", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#ffffff" };
  const added = accepted({ ...base(), nodes: [rect] });
  assert.deepEqual(diffSceneOperations(empty, added), [{ op: "add_canvas_node", node: added.nodes?.[0] }]);
  assert.deepEqual(diffSceneOperations(added, empty), [{ op: "remove_canvas_node", id: "c1" }]);
  const moved = accepted({ ...base(), nodes: [{ ...rect, x: 40, y: 60 }] });
  assert.deepEqual(diffSceneOperations(added, moved), [{ op: "move_canvas_node", id: "c1", x: 40, y: 60 }]);
  const painted = accepted({ ...base(), nodes: [{ ...rect, fill: "#123456" }] });
  assert.deepEqual(diffSceneOperations(added, painted), [
    { op: "update_canvas_node", id: "c1", props: { fill: "#123456" } },
  ]);
  const two = accepted(withCanvas());
  const swapped = accepted({ ...base(), nodes: [...(withCanvas().nodes as Record<string, unknown>[])].reverse() });
  assert.deepEqual(diffSceneOperations(two, swapped), [{ op: "reorder_canvas_node", id: "c2", index: 0 }]);
  replayMatches(added, moved);
  replayMatches(added, painted);
  replayMatches(two, swapped);
  replayMatches(empty, added);
  replayMatches(added, empty);
});

test("a loose-node change replays even when the canvas array is created from nothing", () => {
  const before = accepted(base());
  const after = accepted(withCanvas());
  const operations = replayMatches(before, after);
  assert.deepEqual(
    operations.map((operation) => operation.op),
    ["add_canvas_node", "add_canvas_node"],
    "the whole canvas array is added node by node",
  );
  const removed = replayMatches(after, before);
  assert.deepEqual(
    removed.map((operation) => operation.op),
    ["remove_canvas_node", "remove_canvas_node"],
    "the whole canvas array is dropped node by node",
  );
});

test("a mixed frame and loose-node batch replays exactly", () => {
  const before = accepted(withCanvas());
  const after = accepted({
    ...base(),
    frames: [
      {
        ...(withCanvas().frames as Record<string, unknown>[])[0]!,
        nodes: [
          { id: "n1", type: "rect", x: 40, y: 30, w: 30, h: 40, fill: "#ffffff" },
          { id: "n2", type: "rect", x: 60, y: 10, w: 20, h: 20, fill: "#000000" },
        ],
      },
      (withCanvas().frames as Record<string, unknown>[])[1]!,
    ],
    nodes: [
      { id: "c1", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#00ff00" },
      { id: "c3", type: "rect", x: 90, y: 90, w: 5, h: 5, fill: "#fff" },
    ],
  });
  const operations = replayMatches(before, after);
  assert.deepEqual(
    operations.map((operation) => operation.op),
    ["remove_canvas_node", "add_canvas_node", "move_node", "update_canvas_node"],
    "frame and loose-node edits share one deterministic list",
  );
});

test("a scene with only frame changes still diffs exactly as before loose nodes", () => {
  const before = accepted(base());
  const moved = accepted({
    ...base(),
    frames: [
      {
        ...(base().frames as Record<string, unknown>[])[0]!,
        nodes: [
          { id: "n1", type: "rect", x: 40, y: 30, w: 30, h: 40, fill: "#ffffff" },
          { id: "n2", type: "rect", x: 60, y: 10, w: 20, h: 20, fill: "#000000" },
        ],
      },
      (base().frames as Record<string, unknown>[])[1]!,
    ],
  });
  assert.deepEqual(diffSceneOperations(before, moved), [{ op: "move_node", id: "n1", x: 40, y: 30 }]);
  const mixed = accepted({
    ...base(),
    frames: [
      {
        id: "f1",
        name: "Renamed",
        x: 100,
        y: 50,
        w: 200,
        h: 120,
        nodes: [
          { id: "n2", type: "rect", x: 60, y: 10, w: 20, h: 20, fill: "#111111" },
          { id: "n9", type: "rect", x: 5, y: 50, w: 10, h: 10, fill: "#0af" },
          { id: "n1", type: "rect", x: 10, y: 20, w: 30, h: 40, fill: "#ffffff" },
        ],
      },
      (base().frames as Record<string, unknown>[])[1]!,
    ],
  });
  assert.deepEqual(
    diffSceneOperations(before, mixed),
    [
      { op: "update_frame", id: "f1", props: { name: "Renamed", h: 120 } },
      { op: "add_node", frameId: "f1", node: mixed.frames[0]!.nodes[1]! },
      { op: "update_node", id: "n2", props: { fill: "#111111" } },
      { op: "reorder_node", id: "n2", index: 0 },
      { op: "reorder_node", id: "n9", index: 1 },
    ],
    "the frame diff keeps the order it always had",
  );
});

test("an unchanged canvas node adds no operation to a frame-only change", () => {
  const before = accepted(withCanvas());
  const after = accepted({
    ...withCanvas(),
    frames: [
      {
        ...(withCanvas().frames as Record<string, unknown>[])[0]!,
        nodes: [
          { id: "n1", type: "rect", x: 40, y: 30, w: 30, h: 40, fill: "#ffffff" },
          { id: "n2", type: "rect", x: 60, y: 10, w: 20, h: 20, fill: "#000000" },
        ],
      },
      (withCanvas().frames as Record<string, unknown>[])[1]!,
    ],
  });
  assert.deepEqual(diffSceneOperations(before, after), [{ op: "move_node", id: "n1", x: 40, y: 30 }]);
});

test("a batch that mixes frame and loose-node operation kinds replays exactly", () => {
  const before = accepted(withCanvas());
  const operations: SceneOperation[] = [
    { op: "add_canvas_node", node: asNode({ id: "c9", type: "rect", x: 0, y: 0, w: 5, h: 5, fill: "#fff" }) },
    { op: "move_canvas_node", id: "c1", x: 300, y: 400 },
    { op: "update_canvas_node", id: "c2", props: { fill: "#abcdef" } },
    { op: "reorder_canvas_node", id: "c9", index: 0 },
    { op: "move_node", id: "n1", x: 40, y: 30 },
  ];
  const value = outcomeOf(before, operations);
  assert.deepEqual(canvasIds(value.scene), ["c9", "c1", "c2"]);
  assert.deepEqual(value.boxes, [{ id: "n1", frameId: "f1", x: 140, y: 80, w: 30, h: 40 }]);
  const reread = readScene(canonicalScene(value.scene));
  assert.equal(reread.ok, true);
  if (reread.ok) assert.equal(canonicalScene(reread.value), canonicalScene(value.scene));
});

test("a failing loose-node operation leaves the input byte-identical", () => {
  const input = accepted(withCanvas());
  const before = canonicalScene(input);
  const result = applySceneOperations(input, [
    { op: "move_canvas_node", id: "c1", x: 500, y: 500 },
    { op: "remove_canvas_node", id: "ghost" },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unknown_node");
  assert.equal(result.opIndex, 1, "the refusal names the operation that failed");
  assert.equal(canonicalScene(input), before, "the input keeps its bytes");
});
