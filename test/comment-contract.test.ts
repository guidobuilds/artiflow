import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMENT_ANCHOR_KINDS,
  MAX_COMMENT_QUOTE,
  commentAnchorSchema,
  createCommentRequestSchema,
  textRangeAnchorSchema,
} from "@artiflow/contracts/comments";
import {
  ANCHOR_KINDS_BY_DOCUMENT,
  acceptsSceneAnchors,
  anchorIsCurrent,
  anchorKindAllowed,
  anchorShapeIsValid,
  isSceneAnchor,
  sceneAnchorIsOrphaned,
  sceneAnchorRefusal,
  type BoardPointAnchor,
  type SlidePointAnchor,
} from "@artiflow/domain/comment-anchors";
import { SCENE_FORMAT_VERSION, type Scene } from "@artiflow/domain/scene";
import { anchorKindsFor } from "@artiflow/domain/kinds";

const textRange = { kind: "text-range", startLine: 1, startCol: 4, endLine: 1, endCol: 9, quotedText: "Hello" };
const element = {
  kind: "element",
  selector: "main > p:nth-child(2)",
  point: { x: 0.25, y: 0.75 },
  textHint: "Hello",
  viewportWidth: 800,
};
const pagePoint = { kind: "page-point", x: 0.5, y: 420, viewportWidth: 800 };
const boardPoint: BoardPointAnchor = {
  kind: "board-point",
  boardId: "frame-home",
  nodeId: "node-live",
  x: 0.25,
  y: 0.5,
};
const slidePoint: SlidePointAnchor = {
  kind: "slide-point",
  slideId: "slide-one",
  nodeId: "node-live",
  x: 0.5,
  y: 0.5,
};
const scene: Scene = {
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: "frame-home",
      name: "Home",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      nodes: [{ id: "node-live", type: "rect", x: 40, y: 20, w: 100, h: 60, fill: "#ffffff" }],
    },
    {
      id: "frame-away",
      name: "Away",
      x: 400,
      y: 0,
      w: 200,
      h: 200,
      nodes: [{ id: "node-away", type: "rect", x: 10, y: 10, w: 50, h: 50, fill: "#000000" }],
    },
  ],
};

const anchorIssues = (value: unknown): string[] => (commentAnchorSchema.safeParse(value).success ? [] : ["rejected"]);
const createIssues = (value: unknown): string[] =>
  createCommentRequestSchema.safeParse(value).error?.issues.map((issue) => String(issue.message)) ?? [];

test("every anchor kind parses a well-formed instance", () => {
  for (const anchor of [textRange, element, pagePoint, boardPoint, slidePoint])
    assert.deepEqual(anchorIssues(anchor), []);
  assert.deepEqual([...COMMENT_ANCHOR_KINDS].sort(), [
    "board-point",
    "element",
    "page-point",
    "slide-point",
    "text-range",
  ]);
});

test("malformed text-range anchors are rejected", () => {
  assert.deepEqual(anchorIssues({ ...textRange, endLine: 0 }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...textRange, startLine: 2, endLine: 1 }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...textRange, startCol: 1.5 }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...textRange, quotedText: "" }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...textRange, quotedText: "x".repeat(MAX_COMMENT_QUOTE + 1) }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...textRange, quotedText: undefined }), ["rejected"]);
});

test("an element anchor needs a locator but not necessarily a selector", () => {
  assert.deepEqual(anchorIssues({ ...element, selector: "" }), []);
  assert.deepEqual(anchorIssues({ ...element, selector: "", textHint: "Visible text" }), []);
  assert.deepEqual(anchorIssues({ ...element, selector: "", textHint: "" }), ["rejected"]);
  assert.equal(anchorShapeIsValid({ ...element, selector: "", textHint: "Visible text" }), true);
  assert.equal(anchorShapeIsValid({ ...element, selector: "", textHint: "" }), false);
});

test("malformed element anchors are rejected", () => {
  assert.deepEqual(anchorIssues({ ...element, selector: "x".repeat(513) }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...element, point: { x: 1.5, y: 0.5 } }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...element, point: { x: 0.5, y: -0.1 } }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...element, textHint: "x".repeat(121) }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...element, textHint: undefined }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...element, viewportWidth: 0 }), ["rejected"]);
});

test("malformed positional anchors are rejected", () => {
  assert.deepEqual(anchorIssues({ ...pagePoint, x: 1.5 }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...pagePoint, y: -1 }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...pagePoint, viewportWidth: 1.5 }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...boardPoint, boardId: "" }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...boardPoint, nodeId: "" }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...boardPoint, x: Number.NaN }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...slidePoint, slideId: "" }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...slidePoint, nodeId: "" }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...element, kind: "text-range" }), ["rejected"]);
  assert.deepEqual(anchorIssues({ kind: "unknown" }), ["rejected"]);
});

test("create requests require an anchor on roots and refuse anchors on replies", () => {
  assert.deepEqual(createIssues({ anchor: textRange, body: "b" }), []);
  assert.deepEqual(createIssues({ anchor: element, body: "b" }), []);
  assert.deepEqual(createIssues({ body: "b" }), ["root_requires_anchor"]);
  assert.deepEqual(createIssues({ anchor: textRange, body: "b", parentId: "p" }), ["reply_has_no_anchor"]);
  assert.deepEqual(createIssues({ body: "b", parentId: "p" }), []);
});

test("the registry maps document kinds to accepted anchor kinds", () => {
  assert.deepEqual(ANCHOR_KINDS_BY_DOCUMENT.markdown, ["text-range"]);
  assert.deepEqual(ANCHOR_KINDS_BY_DOCUMENT.html, ["element", "page-point"]);
  assert.deepEqual(ANCHOR_KINDS_BY_DOCUMENT.canvas, ["board-point"]);
  assert.equal(anchorKindAllowed("markdown", "text-range"), true);
  assert.equal(anchorKindAllowed("markdown", "element"), false);
  assert.equal(anchorKindAllowed("html", "page-point"), true);
  assert.equal(anchorKindAllowed("html", "text-range"), false);
  assert.equal(anchorKindAllowed("canvas", "board-point"), true);
  assert.equal(anchorKindAllowed("canvas", "slide-point"), false, "a canvas names a node, not a slide");
  assert.equal(anchorKindAllowed("pdf", "text-range"), false);
});

test("a board-point is a normalized point inside the node it names", () => {
  assert.deepEqual(anchorIssues(boardPoint), []);
  assert.deepEqual(anchorIssues(slidePoint), []);
  for (const x of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.deepEqual(anchorIssues({ ...boardPoint, x }), ["rejected"], `x ${String(x)} is outside 0..1`);
  assert.deepEqual(anchorIssues({ ...boardPoint, y: 2 }), ["rejected"]);
  assert.deepEqual(anchorIssues({ ...boardPoint, nodeId: undefined }), ["rejected"]);
  assert.equal(anchorShapeIsValid(boardPoint), true);
  assert.equal(anchorShapeIsValid({ ...boardPoint, nodeId: "" }), false);
  assert.equal(anchorShapeIsValid({ ...boardPoint, x: 1.5 }), false);
  assert.equal(anchorShapeIsValid({ ...slidePoint, nodeId: "" }), false);
  assert.equal(anchorShapeIsValid({ ...slidePoint, y: Number.POSITIVE_INFINITY }), false);
});

test("a scene anchor resolves against the frame that holds its node", () => {
  assert.equal(acceptsSceneAnchors("canvas"), true);
  assert.equal(acceptsSceneAnchors("markdown"), false);
  assert.equal(acceptsSceneAnchors("html"), false);
  assert.equal(acceptsSceneAnchors("pdf"), false);
  assert.equal(isSceneAnchor(boardPoint), true);
  assert.equal(isSceneAnchor(slidePoint), true);
  assert.equal(isSceneAnchor(pagePoint), false);
  assert.equal(isSceneAnchor(null), false);
  assert.equal(sceneAnchorRefusal(scene, boardPoint), null, "the node is in the frame the anchor names");
  assert.equal(sceneAnchorRefusal(scene, { ...boardPoint, nodeId: "node-missing" }), "unknown_node");
  assert.equal(sceneAnchorRefusal(scene, { ...boardPoint, boardId: "frame-missing" }), "unknown_node");
  assert.equal(
    sceneAnchorRefusal(scene, { ...boardPoint, nodeId: "node-away" }),
    "unknown_node",
    "a node that lives in another frame does not resolve",
  );
  assert.equal(sceneAnchorIsOrphaned(scene, boardPoint), false);
  assert.equal(sceneAnchorIsOrphaned(scene, { ...boardPoint, nodeId: "node-missing" }), true);
  assert.equal(sceneAnchorIsOrphaned(scene, pagePoint), false, "an anchor that names no node is never orphaned");
  assert.equal(sceneAnchorIsOrphaned(scene, null), false);
});

test("every anchor kind a canvas accepts is a scene anchor", () => {
  for (const anchor of anchorKindsFor("canvas")) assert.equal(isSceneAnchor({ kind: anchor }), true);
});

test("shape validation accepts stored anchors and refuses junk", () => {
  for (const anchor of [textRange, element, pagePoint, boardPoint, slidePoint])
    assert.equal(anchorShapeIsValid(anchor), true);
  assert.equal(anchorShapeIsValid(null), false);
  assert.equal(
    anchorShapeIsValid({ kind: "text-range", startLine: 0, startCol: 1, endLine: 1, endCol: 2, quotedText: "x" }),
    false,
  );
  assert.equal(
    anchorShapeIsValid({ kind: "element", selector: "p", point: { x: 2, y: 0 }, textHint: "", viewportWidth: 1 }),
    false,
  );
  assert.equal(anchorShapeIsValid({ kind: "unknown" }), false);
});

test("text-range currency keeps the exact-match rule; other kinds only validate shape", () => {
  assert.equal(anchorIsCurrent("markdown", "Hi Hello there", textRange), true);
  assert.equal(anchorIsCurrent("markdown", "Hi Changed there", textRange), false);
  assert.equal(anchorIsCurrent("markdown", "Hello", element), false);
  assert.equal(anchorIsCurrent("html", "", element), true);
  assert.equal(anchorIsCurrent("html", "", pagePoint), true);
  assert.equal(anchorIsCurrent("html", "", textRange), false);
  assert.equal(anchorIsCurrent("markdown", "Hello", { ...element, selector: "" }), false);
  assert.equal(textRangeAnchorSchema.safeParse(textRange).success, true);
});
