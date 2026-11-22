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
import { applySceneOperations, type SceneOperation } from "@artiflow/domain/scene-operations";

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
