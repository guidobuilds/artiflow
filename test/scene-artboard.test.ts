import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ARTBOARD_MODES,
  ARTBOARD_VIEWPORT_WIDTHS,
  SCENE_FORMAT_VERSION,
  artboardViewportWidth,
  canonicalScene,
  readScene,
  sceneOutline,
  validateScene,
  type Scene,
  type SceneFrame,
} from "@artiflow/domain/scene";

const SOURCE_ARTIFACT = "0d5b0f6a-3f2b-4b4a-9a44-6a2f4a1f7c11";
const SOURCE_REVISION = "8f0d9c2e-51a4-4cbb-9a0e-2f3c4d5e6f70";

const rect = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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
  name: "Proposal A",
  x: 0,
  y: 0,
  w: 390,
  h: 640,
  nodes: [],
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

const source = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  artifactId: SOURCE_ARTIFACT,
  revisionId: SOURCE_REVISION,
  mode: "fixed",
  ...overrides,
});

test("a frame source is accepted and preserved as an artboard reference", () => {
  const parsed = accepted(scene({ frames: [frame({ source: source() })] }));
  assert.deepEqual(parsed.frames[0]?.source, {
    artifactId: SOURCE_ARTIFACT,
    revisionId: SOURCE_REVISION,
    mode: "fixed",
  });
});

test("fluid and fixed are the only artboard presentation modes", () => {
  assert.deepEqual([...ARTBOARD_MODES], ["fixed", "fluid"]);
  for (const mode of ARTBOARD_MODES) {
    const parsed = accepted(scene({ frames: [frame({ source: source({ mode }) })] }));
    assert.equal(parsed.frames[0]?.source?.mode, mode);
  }
  const refused = refusalOf(scene({ frames: [frame({ source: source({ mode: "auto" }) })] }));
  assert.equal(refused.reason, "invalid_source");
  assert.equal(refused.path, "frames[0].source.mode");
});

test("an artboard source needs a canonical artifact and revision id", () => {
  for (const property of ["artifactId", "revisionId"] as const) {
    const without = { ...source() };
    delete without[property];
    const missing = refusalOf(scene({ frames: [frame({ source: without })] }));
    assert.equal(missing.reason, "invalid_source");
    assert.equal(missing.path, `frames[0].source.${property}`);

    const uppercase = refusalOf(
      scene({ frames: [frame({ source: source({ [property]: SOURCE_ARTIFACT.toUpperCase() }) })] }),
    );
    assert.equal(uppercase.reason, "invalid_source");

    const notUuid = refusalOf(scene({ frames: [frame({ source: source({ [property]: "latest" }) })] }));
    assert.equal(notUuid.reason, "invalid_source");
  }
});

test("an artboard frame carries the reference instead of loose nodes", () => {
  const refused = refusalOf(scene({ frames: [frame({ source: source(), nodes: [rect()] })] }));
  assert.equal(refused.reason, "invalid_source");
  assert.equal(refused.path, "frames[0].nodes");
});

test("an unknown source property is refused instead of silently kept", () => {
  const refused = refusalOf(scene({ frames: [frame({ source: source({ url: "https://example.test/a" }) })] }));
  assert.equal(refused.reason, "invalid_source");
  assert.equal(refused.path, "frames[0].source.url");
});

test("source is refused when it is not an object", () => {
  for (const value of [null, "artifact", [], 7]) {
    const refused = refusalOf(scene({ frames: [frame({ source: value })] }));
    assert.equal(refused.reason, "invalid_source");
    assert.equal(refused.path, "frames[0].source");
  }
});

test("a frame without source keeps validating and canonicalizing as before", () => {
  const parsed = accepted(scene({ frames: [frame({ nodes: [rect()] })] }));
  assert.equal(parsed.frames[0]?.source, undefined);
  const canonical = canonicalScene(parsed);
  assert.equal(canonical.includes("source"), false);
  assert.deepEqual(readScene(canonical), { ok: true, value: parsed });
});

test("canonical scene keeps the artboard reference stable across a JSON round trip", () => {
  const parsed = accepted(
    scene({
      frames: [
        frame({ id: "a", name: "A", source: source({ mode: "fluid" }) }),
        frame({ id: "b", name: "B", x: 430, nodes: [rect()] }),
      ],
    }),
  );
  const roundTripped = readScene(canonicalScene(parsed));
  assert.equal(roundTripped.ok, true);
  if (!roundTripped.ok) throw new Error("unreachable");
  assert.deepEqual(roundTripped.value, parsed);
  assert.deepEqual(
    roundTripped.value.frames.map((entry) => entry.source?.mode ?? null),
    ["fluid", null],
  );
});

test("the frame box stays the canvas geometry for an artboard without nodes", () => {
  const parsed = accepted(scene({ frames: [frame({ x: 12, y: 34, w: 1280, h: 800, source: source() })] }));
  assert.deepEqual(sceneOutline(parsed), [
    { id: "f1", name: "Proposal A", nodeCount: 0, bbox: { x: 12, y: 34, w: 1280, h: 800 } },
  ]);
});

test("a fluid artboard renders at the selected viewport width, a fixed one at its frame width", () => {
  assert.deepEqual([...ARTBOARD_VIEWPORT_WIDTHS], [390, 1280]);
  const fixed = { artifactId: SOURCE_ARTIFACT, revisionId: SOURCE_REVISION, mode: "fixed" } as SceneFrame["source"];
  const fluid = { artifactId: SOURCE_ARTIFACT, revisionId: SOURCE_REVISION, mode: "fluid" } as SceneFrame["source"];
  assert.equal(artboardViewportWidth(fixed!, 1280, 640), 640);
  assert.equal(artboardViewportWidth(fluid!, 390, 640), 390);
  assert.equal(artboardViewportWidth(fluid!, 1280, 640), 1280);
});
