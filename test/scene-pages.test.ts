import assert from "node:assert/strict";
import { test } from "node:test";

import { SCENE_FORMAT_VERSION, canonicalScene, validateScene, type Scene } from "@artiflow/domain/scene";
import { applySceneOperations, diffSceneOperations, type SceneOperation } from "@artiflow/domain/scene-operations";
import { guideLines, scenePageContent, setSceneGuides, DEFAULT_SCENE_GUIDES } from "@artiflow/domain/scene-pages";
import { parseSceneLink, planSceneView, sceneViewHref } from "@artiflow/domain/scene-link";

import { renderSceneDocument, type SceneRenderView } from "../apps/api/src/viewer/views/scene.ts";

const CANVAS: SceneRenderView = { kind: "canvas" };
const PLAY_1280: SceneRenderView = { kind: "play", width: 1280 };

const frame = (id: string, name: string, x: number): Scene["frames"][number] =>
  ({ id, name, x, y: 0, w: 390, h: 640, nodes: [] }) as Scene["frames"][number];

const base = (): Scene =>
  ({
    formatVersion: SCENE_FORMAT_VERSION,
    frames: [
      { ...frame("a", "Proposal A", 0), nodes: [{ id: "a1", type: "text", x: 0, y: 0, w: 100, h: 20, text: "A" }] },
      frame("b", "Proposal B", 500),
      frame("c", "Approved A", 1000),
    ],
    nodes: [
      {
        id: "label-explore",
        type: "text",
        x: 0,
        y: -80,
        w: 890,
        h: 40,
        text: "Exploration",
        annotation: { kind: "title", targets: ["a", "b"] },
      },
      {
        id: "note-b",
        type: "rect",
        x: 520,
        y: 660,
        w: 220,
        h: 120,
        fill: "#fff2c2",
        annotation: { kind: "note" },
      },
    ],
  }) as unknown as Scene;

const OPERATIONS: SceneOperation[] = [
  { op: "add_page", page: { id: "page-explore", name: "Exploration" } },
  { op: "add_page", page: { id: "page-approved", name: "Approved" } },
  { op: "update_frame", id: "a", props: { page: "page-explore" } },
  { op: "update_frame", id: "b", props: { page: "page-explore" } },
  { op: "update_frame", id: "c", props: { page: "page-approved" } },
  { op: "update_canvas_node", id: "label-explore", props: { page: "page-explore" } },
  { op: "update_canvas_node", id: "note-b", props: { page: "page-explore" } },
];

const apply = (scene: Scene, operations: readonly SceneOperation[]): Scene => {
  const outcome = applySceneOperations(scene, operations);
  if (!outcome.ok) assert.fail(`${outcome.reason} at operation ${outcome.opIndex}`);
  return outcome.value.scene;
};

const paged = (): Scene => apply(base(), OPERATIONS);

const render = (scene: Scene, pageId: string | null = null, view: SceneRenderView = CANVAS): string =>
  renderSceneDocument(
    scene,
    undefined,
    undefined,
    [],
    "canvas",
    {},
    view,
    undefined,
    pageId,
  );

test("two design pages hold their own artboards and notes and the second page link opens it", () => {
  const scene = paged();
  const content = scenePageContent(scene, "page-approved");
  assert.equal(content.page?.name, "Approved");
  assert.deepEqual(
    content.frames.map((entry) => entry.id),
    ["c"],
    "the second page holds its own artboard",
  );
  assert.deepEqual(
    content.notes.map((entry) => entry.id),
    [],
    "the second page holds none of the first page's notes",
  );

  const approved = render(scene, "page-approved");
  assert.ok(approved.includes('data-frame-id="c"'), "the approved artboard renders on its page");
  assert.equal(approved.includes('data-frame-id="a"'), false, "the exploration artboard stays off the approved page");
  assert.equal(approved.includes('data-annotation="note"'), false, "the note stays off the approved page");
  assert.ok(approved.includes('href="?page=page-explore"'), "the page switcher links the other page");
  assert.ok(approved.includes('class="scene-page" href="?page=page-approved" aria-current="page"'), "the opened page is marked current");

  const link = parseSceneLink(new URLSearchParams("?page=page-approved"));
  assert.equal(link.page, "page-approved");
  assert.deepEqual(planSceneView(scene, link), { kind: "canvas", frameId: null, page: "page-approved" });
  assert.equal(sceneViewHref("/artifact/design", link), "/artifact/design?page=page-approved");

  const exploration = render(scene, "page-explore");
  assert.ok(exploration.includes('data-frame-id="a"'), "the first page keeps its artboards");
  assert.ok(exploration.includes('data-frame-id="b"'), "the first page keeps its variants");
  assert.ok(exploration.includes('data-annotation="title"'), "the group title renders with its page");
});

test("a frame and a note move between pages without changing their geometry", () => {
  const scene = paged();
  const moved = apply(scene, [
    { op: "update_frame", id: "b", props: { page: "page-approved" } },
    { op: "update_canvas_node", id: "note-b", props: { page: "page-approved" } },
  ]);
  assert.deepEqual(
    scenePageContent(moved, "page-approved").frames.map((entry) => entry.id).sort(),
    ["b", "c"],
  );
  assert.deepEqual(
    scenePageContent(moved, "page-approved").notes.map((entry) => entry.id),
    ["note-b"],
  );
  const before = scene.frames.find((entry) => entry.id === "b");
  const after = moved.frames.find((entry) => entry.id === "b");
  assert.deepEqual(
    { x: after?.x, y: after?.y, w: after?.w, h: after?.h },
    { x: before?.x, y: before?.y, w: before?.w, h: before?.h },
    "page membership never moves the artboard",
  );
});

test("a group title and a sticky note render on the canvas and never inside Play", () => {
  const scene = paged();
  const canvas = render(scene);
  assert.ok(canvas.includes('data-annotation="title"'), "the group title renders on the canvas");
  assert.ok(canvas.includes('data-annotation="note"'), "the sticky note renders on the canvas");
  assert.ok(canvas.includes("Exploration"), "the title text renders");

  const play = render(scene, null, PLAY_1280);
  assert.equal(play.includes('data-annotation="title"'), false, "no group title inside Play");
  assert.equal(play.includes('data-annotation="note"'), false, "no sticky note inside Play");
  assert.equal(play.includes('<nav class="scene-pages"'), false, "Play has no page switcher");
});

test("a title explains several artboards and a single-board title is refused", () => {
  const oneTarget = validateScene({
    ...base(),
    nodes: [
      { id: "lonely", type: "text", x: 0, y: 0, w: 10, h: 10, text: "One", annotation: { kind: "title", targets: ["a"] } },
    ],
  });
  assert.equal(oneTarget.ok, false);
  if (!oneTarget.ok) {
    assert.equal(oneTarget.reason, "invalid_annotation");
    assert.equal(oneTarget.path, "nodes[0].annotation.targets");
  }
  const unknownTarget = validateScene({
    ...base(),
    nodes: [
      { id: "odd", type: "text", x: 0, y: 0, w: 10, h: 10, text: "Odd", annotation: { kind: "title", targets: ["a", "ghost"] } },
    ],
  });
  assert.equal(unknownTarget.ok, false);
  const insideFrame = validateScene({
    ...base(),
    frames: [
      {
        ...frame("a", "Proposal A", 0),
        nodes: [{ id: "n", type: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#fff", annotation: { kind: "note" } }],
      },
    ],
    nodes: [],
  });
  assert.equal(insideFrame.ok, false, "a note belongs to the canvas level, never inside an artboard");
});

test("guides render as an overlay without touching node geometry", () => {
  const scene = setSceneGuides(base(), DEFAULT_SCENE_GUIDES);
  assert.deepEqual(scene.frames, base().frames, "adding guides keeps every frame box");
  assert.deepEqual(scene.nodes, base().nodes, "adding guides keeps every canvas node box");
  const lines = guideLines(DEFAULT_SCENE_GUIDES, { w: 900, h: 400 });
  assert.equal(lines.length, 3, "three columns produce three guides");
  assert.equal(lines[0]?.x, 24, "the first column starts at the margin");
  assert.equal(lines[0]?.h, 400, "each guide spans the surface height");

  const canvas = render(scene);
  assert.ok(canvas.includes('<div class="scene-guides"'), "the canvas draws the guides overlay");
  assert.ok(canvas.includes('id="guides"'), "the canvas offers a guides toggle");
  assert.ok(canvas.includes('data-guides="off"'), "the guides start hidden");

  const play = render(scene, null, PLAY_1280);
  assert.equal(play.includes('<div class="scene-guides"'), false, "Play never draws guides");
  assert.equal(play.includes('id="guides"'), false, "Play offers no guides toggle");
});

test("a locked artboard refuses moves and removals while its words stay editable", () => {
  const scene = apply(base(), [
    { op: "update_frame", id: "c", props: { locked: true } },
    { op: "add_node", frameId: "c", node: { id: "c1", type: "text", x: 0, y: 0, w: 100, h: 20, text: "C" } },
  ]);
  assert.equal(scene.frames[2]?.locked, true);

  const move = applySceneOperations(scene, [{ op: "move_node", id: "c1", x: 1, y: 1 }]);
  assert.equal(move.ok, false);
  if (!move.ok) assert.equal(move.reason, "frame_locked");

  const removeFrame = applySceneOperations(scene, [{ op: "remove_frame", id: "c" }]);
  assert.equal(removeFrame.ok, false);
  if (!removeFrame.ok) assert.equal(removeFrame.reason, "frame_locked");

  const nudgeFrame = applySceneOperations(scene, [{ op: "update_frame", id: "c", props: { x: 40 } }]);
  assert.equal(nudgeFrame.ok, false);
  if (!nudgeFrame.ok) assert.equal(nudgeFrame.reason, "frame_locked");

  const editWords = applySceneOperations(scene, [
    { op: "update_node", id: "c1", props: { text: "Approved v2" } },
    { op: "update_node", id: "c1", props: { fill: "#e8f0ff" } },
    { op: "update_node", id: "c1", props: { style: { fontSize: 18, color: "#112233" } } },
  ]);
  assert.equal(editWords.ok, true, "words and colours stay editable while the artboard is locked");

  const rename = applySceneOperations(scene, [{ op: "update_frame", id: "c", props: { name: "Approved B" } }]);
  assert.equal(rename.ok, false, "renaming the locked artboard is a structural change");
  if (!rename.ok) assert.equal(rename.reason, "frame_locked");

  const removeNode = applySceneOperations(scene, [{ op: "remove_node", id: "c1" }]);
  assert.equal(removeNode.ok, false);
  if (!removeNode.ok) assert.equal(removeNode.reason, "frame_locked");

  const unlocked = apply(scene, [{ op: "update_frame", id: "c", props: { locked: false } }]);
  const moved = applySceneOperations(unlocked, [{ op: "remove_node", id: "c1" }]);
  assert.equal(moved.ok, true, "unlocking restores moving and removing");
});

test("page operations refuse a page that still holds content and keep ids unique", () => {
  const scene = paged();
  const remove = applySceneOperations(scene, [{ op: "remove_page", id: "page-explore" }]);
  assert.equal(remove.ok, false);
  if (!remove.ok) assert.equal(remove.reason, "page_not_empty");

  const withEmpty = apply(scene, [{ op: "add_page", page: { id: "page-empty", name: "Empty" } }]);
  const empty = applySceneOperations(withEmpty, [{ op: "remove_page", id: "page-empty" }]);
  assert.equal(empty.ok, true, "a page with no content can be removed");
  if (empty.ok) assert.deepEqual(empty.value.scene.pages?.map((page) => page.id), ["page-explore", "page-approved"]);

  const duplicateId = validateScene({
    ...base(),
    pages: [{ id: "a", name: "Collides with a frame" }],
  });
  assert.equal(duplicateId.ok, false, "a page id can never reuse a frame id");

  const unknown = validateScene({
    ...base(),
    pages: [{ id: "page-1", name: "One" }],
    frames: [{ ...frame("a", "Proposal A", 0), page: "page-two" }],
    nodes: [],
  });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, "unknown_page");

  const renamed = apply(scene, [
    { op: "update_page", id: "page-approved", props: { name: "Approved v2" } },
    { op: "reorder_page", id: "page-approved", index: 0 },
  ]);
  assert.deepEqual(renamed.pages, [
    { id: "page-approved", name: "Approved v2" },
    { id: "page-explore", name: "Exploration" },
  ]);
});

test("a scene without pages, notes, guides or lock keeps the document it always had", () => {
  const legacy = {
    formatVersion: SCENE_FORMAT_VERSION,
    frames: [frame("a", "Proposal A", 0), frame("c", "Approved A", 1000)],
    nodes: [{ id: "stick", type: "rect", x: 0, y: 700, w: 200, h: 120, fill: "#fff2c2" }],
  } as unknown as Scene;
  const checked = validateScene(legacy);
  assert.equal(checked.ok, true);
  const plain = canonicalScene(legacy);
  assert.equal(plain.includes("pages"), false);
  assert.equal(plain.includes("guides"), false);
  assert.equal(plain.includes("locked"), false);
  if (!checked.ok) return;
  assert.equal(canonicalScene(checked.value), plain, "an untouched legacy document canonicalizes to the same bytes");

  const html = render(legacy);
  assert.equal(html.includes(".scene-pages{"), false, "a legacy design ships none of the new stylesheet");
  assert.equal(render(paged()).includes(".scene-pages{"), true, "a paged design ships the page stylesheet");
  for (const absent of [
    '<nav class="scene-pages"',
    '<div class="scene-guides"',
    'data-annotation="',
    '<span class="scene-frame-lock">',
  ])
    assert.equal(html.includes(absent), false, `a legacy design renders no ${absent}`);
  assert.ok(html.includes('data-frame-id="a"') && html.includes('data-frame-id="c"'), "every frame still renders");

  const unknown = validateScene({ ...legacy, futureField: { keep: true } });
  assert.equal(unknown.ok, true);
  if (unknown.ok) assert.deepEqual(unknown.value.futureField, { keep: true }, "unknown fields survive validation");
});

test("the operation diff carries pages, notes and lock back into the scene", () => {
  const previous = base();
  const next = apply(previous, [
    ...OPERATIONS,
    { op: "update_frame", id: "c", props: { locked: true } },
  ]);
  const operations = diffSceneOperations(previous, next);
  assert.ok(operations.some((operation) => operation.op === "add_page"), "the diff adds the new pages");
  assert.ok(operations.some((operation) => operation.op === "update_canvas_node"), "the diff moves the notes");
  const replay = apply(previous, operations);
  assert.equal(canonicalScene(replay), canonicalScene(next), "replaying the diff rebuilds the same document");
});

const plain = (): Scene => ({
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    { id: "a", name: "A", x: 0, y: 0, w: 390, h: 640, nodes: [{ id: "a1", type: "text", x: 0, y: 0, w: 100, h: 20, text: "A" }] },
    { id: "b", name: "B", x: 500, y: 0, w: 390, h: 640, nodes: [] },
  ],
  nodes: [],
}) as unknown as Scene;

const lockedPlain = (): Scene => apply(plain(), [{ op: "update_frame", id: "a", props: { locked: true } }]);

const withFrame = (scene: Scene, id: string, patch: Record<string, unknown>): Scene => ({
  ...scene,
  frames: scene.frames.map((frame) => (frame.id === id ? { ...frame, ...patch } : frame)),
});

test("a locked artboard cannot be moved, emptied or removed through replace_scene", () => {
  const locked = lockedPlain();
  const moved = applySceneOperations(locked, [
    { op: "replace_scene", scene: withFrame(locked, "a", { x: 40 }) },
  ]);
  assert.equal(moved.ok, false);
  if (!moved.ok) {
    assert.equal(moved.reason, "frame_locked");
    assert.equal(moved.detail.id, "a");
    assert.equal(moved.opIndex, 0, "the batch names the operation that broke the lock");
  }

  const emptied = applySceneOperations(locked, [
    {
      op: "replace_scene",
      scene: withFrame(locked, "a", { nodes: [{ id: "a1", type: "text", x: 90, y: 0, w: 100, h: 20, text: "A" }] }),
    },
  ]);
  assert.equal(emptied.ok, false);
  if (!emptied.ok) assert.equal(emptied.reason, "frame_locked");

  const removed = applySceneOperations(locked, [
    { op: "replace_scene", scene: { ...locked, frames: locked.frames.filter((frame) => frame.id !== "a") } },
  ]);
  assert.equal(removed.ok, false);
  if (!removed.ok) assert.equal(removed.reason, "frame_locked");

  const identical = applySceneOperations(locked, [
    { op: "replace_scene", scene: JSON.parse(JSON.stringify(locked)) as Scene },
  ]);
  assert.equal(identical.ok, true, "a replace that leaves the locked artboard untouched is allowed");
  if (identical.ok) assert.deepEqual(identical.value.scene, locked);

  const scrambled = {
    frames: locked.frames.map((frame) => ({
      locked: frame.locked,
      nodes: frame.nodes,
      h: frame.h,
      w: frame.w,
      y: frame.y,
      x: frame.x,
      name: frame.name,
      id: frame.id,
    })),
    formatVersion: SCENE_FORMAT_VERSION,
  } as unknown as Scene;
  const reordered = applySceneOperations(locked, [{ op: "replace_scene", scene: scrambled }]);
  assert.equal(reordered.ok, true, "the comparison ignores key order");
});

test("unlocking is explicit and a move needs a later batch", () => {
  const locked = lockedPlain();
  const released = apply(locked, [{ op: "update_frame", id: "a", props: { locked: false } }]);
  assert.equal(released.frames[0]?.locked, false);
  const moved = applySceneOperations(released, [{ op: "update_frame", id: "a", props: { x: 40 } }]);
  assert.equal(moved.ok, true, "unlocking in its own batch restores moving");
  const removed = applySceneOperations(released, [{ op: "remove_frame", id: "a" }]);
  assert.equal(removed.ok, true, "unlocking in its own batch restores removing");

  for (const operations of [
    [
      { op: "update_frame", id: "a", props: { locked: false } },
      { op: "update_frame", id: "a", props: { x: 40 } },
    ],
    [
      { op: "update_frame", id: "a", props: { locked: false } },
      { op: "remove_frame", id: "a" },
    ],
  ] as SceneOperation[][]) {
    const outcome = applySceneOperations(locked, operations);
    assert.equal(outcome.ok, false, "unlock and move in one batch stay refused");
    if (!outcome.ok) assert.equal(outcome.reason, "frame_locked");
  }
});

test("the first page keeps its implicit content until that content names a page", () => {
  const twoPages = apply(plain(), [
    { op: "add_page", page: { id: "page-1", name: "One" } },
    { op: "add_page", page: { id: "page-2", name: "Two" } },
  ]);
  const refused = applySceneOperations(twoPages, [{ op: "remove_page", id: "page-1" }]);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "page_not_empty");

  const named = apply(twoPages, [
    { op: "update_frame", id: "a", props: { page: "page-1" } },
    { op: "update_frame", id: "b", props: { page: "page-1" } },
  ]);
  const accepted = applySceneOperations(named, [{ op: "remove_page", id: "page-2" }]);
  assert.equal(accepted.ok, true, "an empty page with no implicit content can still be removed");
});

test("removing an artboard a group title explains is refused, not silently pruned", () => {
  const scene = paged();
  const outcome = applySceneOperations(scene, [{ op: "remove_frame", id: "a" }]);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, "invalid_annotation");
    assert.equal(outcome.detail.path, "nodes[0].annotation.targets");
  }
  const repaired = applySceneOperations(scene, [
    { op: "update_canvas_node", id: "label-explore", props: { annotation: { kind: "title", targets: ["b", "c"] } } },
    { op: "remove_frame", id: "a" },
  ]);
  assert.equal(repaired.ok, true, "retargeting the title first lets the artboard go");
});

test("an unknown page link shows no frames from another page", () => {
  const scene = paged();
  assert.equal(scenePageContent(scene, "ghost").missing, true);
  assert.deepEqual(scenePageContent(scene, "ghost").frames, []);
  assert.deepEqual(scenePageContent(scene, "ghost").notes, []);

  const ghost = render(scene, "ghost");
  assert.equal(ghost.includes('data-frame-id="'), false, "no artboard of the first page leaks into the ghost page");
  assert.equal(ghost.includes('data-annotation="'), false, "no note of the first page leaks into the ghost page");
  assert.ok(ghost.includes("This design page is not available."), "the viewer says the page is not available");
  assert.ok(ghost.includes('href="?page=page-explore"'), "the switcher still offers the real pages");
  assert.equal(/<a[^>]*aria-current="page"/.test(ghost), false, "no page is marked current");

  assert.equal(render(scene, null).includes('data-frame-id="a"'), true, "no page parameter still opens the first page");
});
