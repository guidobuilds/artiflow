import assert from "node:assert/strict";
import { test } from "node:test";

import { SCENE_FORMAT_VERSION, type Scene } from "@artiflow/domain/scene";
import { DEFAULT_ARTBOARD_VIEWPORT, parseSceneLink, planSceneView, sceneViewHref } from "@artiflow/domain/scene-link";

const SOURCE_ARTIFACT = "0d5b0f6a-3f2b-4b4a-9a44-6a2f4a1f7c11";
const REVISION_ONE = "8f0d9c2e-51a4-4cbb-9a0e-2f3c4d5e6f70";

const scene = (): Scene => ({
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: "a",
      name: "Proposal A",
      x: 0,
      y: 0,
      w: 390,
      h: 640,
      nodes: [],
      source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_ONE, mode: "fluid" },
    },
    { id: "b", name: "Static screen", x: 420, y: 0, w: 200, h: 100, nodes: [] },
  ],
});

const linkOf = (search: string) => parseSceneLink(new URLSearchParams(search));

test("a viewer link without a view stays in the canvas", () => {
  assert.deepEqual(linkOf(""), { view: "canvas", frameId: null, width: null, page: null });
  assert.deepEqual(planSceneView(scene(), linkOf("")), { kind: "canvas", frameId: null, page: null });
});

test("a link opens a chosen artboard in focus at 390 or 1280", () => {
  const narrow = linkOf("?frame=a&view=focus&width=390");
  assert.deepEqual(narrow, { view: "focus", frameId: "a", width: 390, page: null });
  assert.deepEqual(planSceneView(scene(), narrow), { kind: "focus", frameId: "a", width: 390 });
  const wide = linkOf("?frame=a&view=focus&width=1280");
  assert.deepEqual(planSceneView(scene(), wide), { kind: "focus", frameId: "a", width: 1280 });
});

test("focus without a width starts at the desktop width", () => {
  assert.deepEqual(planSceneView(scene(), linkOf("?frame=a&view=focus")), {
    kind: "focus",
    frameId: "a",
    width: DEFAULT_ARTBOARD_VIEWPORT,
  });
});

test("play starts at the artboard in the link", () => {
  assert.deepEqual(planSceneView(scene(), linkOf("?frame=a&view=play&width=390")), {
    kind: "play",
    frameId: "a",
    width: 390,
  });
});

test("play needs a frame that is a live artboard", () => {
  assert.deepEqual(planSceneView(scene(), linkOf("?frame=b&view=play")), { kind: "canvas", frameId: "b", page: null });
});

test("an unknown view, an unsupported width and a malformed frame are ignored", () => {
  assert.equal(linkOf("?view=zoom&frame=a").view, "canvas");
  assert.equal(linkOf("?view=FOCUS").view, "canvas");
  for (const width of ["999", "390.0", "0", "-390", "1280px", ""])
    assert.equal(linkOf(`?view=focus&frame=a&width=${width}`).width, null, `width ${width} is rejected`);
  for (const frame of ["", "%20", "x".repeat(201), "a%00b", "a%0Ab"])
    assert.equal(linkOf(`?frame=${frame}`).frameId, null, `frame ${JSON.stringify(frame)} is rejected`);
});

test("a destination that the scene does not hold has no effect", () => {
  assert.deepEqual(planSceneView(scene(), linkOf("?frame=zzz&view=play&width=390")), { kind: "canvas", frameId: null, page: null });
  assert.deepEqual(planSceneView(scene(), linkOf("?frame=zzz&view=focus")), { kind: "canvas", frameId: null, page: null });
  assert.deepEqual(planSceneView(scene(), linkOf("?frame=zzz")), { kind: "canvas", frameId: null, page: null });
});

test("the canvas keeps the frame of the link selected", () => {
  assert.deepEqual(planSceneView(scene(), linkOf("?frame=b")), { kind: "canvas", frameId: "b", page: null });
});

test("a focus link ignores a width it does not carry", () => {
  const plan = planSceneView(scene(), linkOf("?frame=a&view=focus&width=999"));
  assert.deepEqual(plan, { kind: "focus", frameId: "a", width: DEFAULT_ARTBOARD_VIEWPORT });
});

test("a link built for sharing parses back into the same plan", () => {
  const focus = sceneViewHref("/artifact/design", { view: "focus", frameId: "a", width: 390, page: null });
  assert.equal(focus, "/artifact/design?frame=a&view=focus&width=390");
  const search = focus.slice(focus.indexOf("?") + 1);
  assert.deepEqual(planSceneView(scene(), parseSceneLink(new URLSearchParams(search))), {
    kind: "focus",
    frameId: "a",
    width: 390,
  });
  const canvas = sceneViewHref("/artifact/design", { view: "canvas", frameId: "a", width: null, page: null });
  assert.equal(canvas, "/artifact/design?frame=a");
  assert.deepEqual(planSceneView(scene(), parseSceneLink(new URLSearchParams(canvas.slice(canvas.indexOf("?") + 1)))), {
    kind: "canvas",
    frameId: "a",
    page: null,
  });
  assert.equal(sceneViewHref("/artifact/design", { view: "canvas", frameId: null, width: null, page: null }), "/artifact/design");
});
