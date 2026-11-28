import assert from "node:assert/strict";
import { test } from "node:test";

import { SCENE_FORMAT_VERSION, canonicalScene, validateScene, type Scene } from "@artiflow/domain/scene";
import { applySceneOperations, diffSceneOperations, type SceneOperation } from "@artiflow/domain/scene-operations";

const SOURCE_ARTIFACT = "0d5b0f6a-3f2b-4b4a-9a44-6a2f4a1f7c11";
const REVISION_ONE = "8f0d9c2e-51a4-4cbb-9a0e-2f3c4d5e6f70";
const REVISION_TWO = "c1b2a3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const accepted = (input: unknown): Scene => {
  const result = validateScene(input);
  assert.equal(result.ok, true, result.ok ? "" : `${result.reason} at ${result.path}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
};

const rect = (id = "n1"): Record<string, unknown> => ({
  id,
  type: "rect",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  fill: "#ffffff",
});

const artboard = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "a",
  name: "Proposal A",
  x: 0,
  y: 0,
  w: 390,
  h: 640,
  nodes: [],
  source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_ONE, mode: "fixed" },
  ...overrides,
});

const nodeFrame = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "b",
  name: "Proposal B",
  x: 430,
  y: 0,
  w: 390,
  h: 640,
  nodes: [rect("b1")],
  ...overrides,
});

const scene = (): Scene =>
  accepted({ formatVersion: SCENE_FORMAT_VERSION, frames: [artboard(), nodeFrame()] });

const applied = (operations: SceneOperation[]): Scene => {
  const result = applySceneOperations(scene(), operations);
  assert.equal(result.ok, true, result.ok ? "" : `${result.reason} at op ${result.opIndex}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value.scene;
};

const refused = (operations: SceneOperation[]): { reason: string; opIndex: number; detail: Record<string, unknown> } => {
  const result = applySceneOperations(scene(), operations);
  assert.equal(result.ok, false, "the batch is refused instead of applied");
  if (result.ok) throw new Error("unreachable");
  return { reason: result.reason, opIndex: result.opIndex, detail: result.detail };
};

test("add_frame creates an artboard that references one revision", () => {
  const next = applied([
    {
      op: "add_frame",
      frame: artboard({ id: "c", name: "Proposal C", x: 860, source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_TWO, mode: "fluid" } }),
    },
  ]);
  assert.deepEqual(next.frames[2]?.source, {
    artifactId: SOURCE_ARTIFACT,
    revisionId: REVISION_TWO,
    mode: "fluid",
  });
});

test("add_frame refuses an artboard that also carries loose nodes", () => {
  const outcome = refused([{ op: "add_frame", frame: artboard({ id: "c", nodes: [rect("c1")] }) }]);
  assert.equal(outcome.reason, "invalid_source");
  assert.equal(outcome.opIndex, 0);
  assert.equal(outcome.detail.property, "nodes");
});

test("update_frame pins a new revision on one artboard and leaves the others intact", () => {
  const next = applied([
    {
      op: "update_frame",
      id: "a",
      props: { source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_TWO, mode: "fluid" } },
    },
  ]);
  assert.deepEqual(next.frames[0]?.source, { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_TWO, mode: "fluid" });
  assert.deepEqual(next.frames[1], scene().frames[1]);
  assert.deepEqual(next.frames[0]?.nodes, []);
});

test("update_frame with source null clears the artboard reference", () => {
  const next = applied([{ op: "update_frame", id: "a", props: { source: null } }]);
  assert.equal(next.frames[0]?.source, undefined);
  assert.equal(next.frames[0]?.nodes.length, 0);
});

test("update_frame refuses a reference while the frame still holds nodes", () => {
  const outcome = refused([
    { op: "update_frame", id: "b", props: { source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_ONE, mode: "fixed" } } },
  ]);
  assert.equal(outcome.reason, "invalid_source");
  assert.equal(outcome.detail.property, "nodes");
  assert.equal(outcome.detail.id, "b");
});

test("update_frame refuses a malformed reference without touching the scene", () => {
  for (const source of [
    { artifactId: SOURCE_ARTIFACT, revisionId: "latest", mode: "fixed" },
    { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_TWO },
    { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_TWO, mode: "fixed", url: "https://example.test" },
    "artifact",
  ]) {
    const outcome = refused([{ op: "update_frame", id: "a", props: { source } }]);
    assert.equal(outcome.reason, "invalid_source");
  }
  assert.equal(canonicalScene(scene()), canonicalScene(scene()));
});

test("diffing a repinned artboard yields one update_frame with the new source", () => {
  const before = scene();
  const after = applied([
    {
      op: "update_frame",
      id: "a",
      props: { source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_TWO, mode: "fixed" } },
    },
  ]);
  const operations = diffSceneOperations(before, after);
  assert.deepEqual(operations, [
    {
      op: "update_frame",
      id: "a",
      props: { source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_TWO, mode: "fixed" } },
    },
  ]);
  const replayed = applySceneOperations(before, operations);
  assert.equal(replayed.ok, true);
  if (!replayed.ok) throw new Error("unreachable");
  assert.equal(canonicalScene(replayed.value.scene), canonicalScene(after));
});

test("diffing a move keeps the artboard reference out of the patch", () => {
  const before = scene();
  const after = applied([{ op: "update_frame", id: "a", props: { x: 40, y: 120 } }]);
  const operations = diffSceneOperations(before, after);
  assert.deepEqual(operations, [{ op: "update_frame", id: "a", props: { x: 40, y: 120 } }]);
  const replayed = applySceneOperations(before, operations);
  assert.equal(replayed.ok, true);
  if (!replayed.ok) throw new Error("unreachable");
  assert.deepEqual(replayed.value.scene.frames[0]?.source, before.frames[0]?.source);
});
