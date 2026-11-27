import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  SCENE_FORMAT_VERSION,
  surfaceLayout,
  type ImageNode,
  type PathNode,
  type RectNode,
  type Scene,
  type SceneFrame,
  type TextNode,
} from "@artiflow/domain/scene";

import { canvasControllerScript } from "../apps/api/src/viewer/views/canvas-controller.ts";
import { deckControllerScript } from "../apps/api/src/viewer/views/deck-controller.ts";
import { renderSceneDocument } from "../apps/api/src/viewer/scene.ts";
import { attributeSelectorsOf, matchesSelector } from "./helpers/frame-selector.ts";

const rect = (overrides: Partial<RectNode> = {}): RectNode => ({
  id: "rect-1",
  type: "rect",
  x: 10,
  y: 20,
  w: 100,
  h: 50,
  fill: "#ff0000",
  radius: 8,
  ...overrides,
});

const text = (overrides: Partial<TextNode> = {}): TextNode => ({
  id: "text-1",
  type: "text",
  x: 0,
  y: 0,
  w: 200,
  h: 40,
  text: "Hello",
  style: { fontSize: 24, fontWeight: 600, color: "#112233", align: "center" },
  ...overrides,
});

const path = (overrides: Partial<PathNode> = {}): PathNode => ({
  id: "path-1",
  type: "path",
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  d: "M0 0L100 100",
  fill: "#00ff00",
  stroke: "#000000",
  strokeWidth: 2,
  ...overrides,
});

const image = (overrides: Partial<ImageNode> = {}): ImageNode => ({
  id: "image-1",
  type: "image",
  x: 0,
  y: 0,
  w: 120,
  h: 80,
  assetId: "asset-42",
  ...overrides,
});

const frame = (overrides: Partial<SceneFrame> = {}): SceneFrame => ({
  id: "home",
  name: "Home",
  x: 0,
  y: 0,
  w: 390,
  h: 844,
  nodes: [],
  ...overrides,
});

const scene = (...frames: SceneFrame[]): Scene => ({ formatVersion: SCENE_FORMAT_VERSION, frames });

const twoFrames = scene(frame(), frame({ id: "checkout", name: "Checkout" }));

const inlineScript = (html: string): string => html.match(/<script>([^]*?)<\/script>/)?.[1] ?? "";

const frameTag = (html: string, id: string): string =>
  html.match(new RegExp(`<section[^>]*id="frame-${id}"[^>]*>`))?.[0] ?? "";

const indexMarkup = (html: string): string => html.match(/<nav class="scene-index"[^>]*>([^]*?)<\/nav>/)?.[1] ?? "";

const attrOf = (tag: string, name: string): string | null => new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

const sectionTags = (html: string): string[] => html.match(/<section class="scene-frame"[^>]*>/g) ?? [];

const surfaceTag = (html: string): string => html.match(/<div class="scene-surface"[^>]*>/)?.[0] ?? "";

const idsIn = (html: string): string[] =>
  sectionTags(html)
    .map((tag) => attrOf(tag, "data-frame-id"))
    .filter((id): id is string => id !== null);

const placedAt = (html: string, id: string): { x: number; y: number } => ({
  x: Number(attrOf(frameTag(html, id), "data-frame-x")),
  y: Number(attrOf(frameTag(html, id), "data-frame-y")),
});

const STAGE = { w: 1280, h: 800 };
const FIT_RATIO = 0.86;

type View = { x: number; y: number; scale: number };
type Size = { w: number; h: number };

const fittedSurface = (surface: { width: number; height: number }): View => {
  const scale = Math.min(STAGE.w / surface.width, STAGE.h / surface.height) * FIT_RATIO;
  return { scale, x: (STAGE.w - surface.width * scale) / 2, y: (STAGE.h - surface.height * scale) / 2 };
};

const centredOn = (at: { x: number; y: number }, size: Size, scale: number): View => ({
  scale,
  x: STAGE.w / 2 - (at.x + size.w / 2) * scale,
  y: STAGE.h / 2 - (at.y + size.h / 2) * scale,
});

const close = (actual: number, expected: number, what: string): void =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: expected ${expected}, got ${actual}`);

const sameView = (actual: View, expected: View, what: string): void => {
  close(actual.scale, expected.scale, `${what} scale`);
  close(actual.x, expected.x, `${what} x`);
  close(actual.y, expected.y, `${what} y`);
};

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  hidden = false;
  clientWidth = 1280;
  clientHeight = 800;

  readonly tag: string;

  constructor(tag: string) {
    this.tag = tag;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.children.filter((child) => matchesSelector(child, selector));
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  setPointerCapture(): void {}

  emit(type: string, event: Record<string, unknown> = {}): void {
    const payload = { preventDefault: () => {}, altKey: false, ctrlKey: false, metaKey: false, ...event };
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }

  view(): { x: number; y: number; scale: number } {
    const found = /translate\((-?[\d.e+-]+)px, ?(-?[\d.e+-]+)px\) scale\((-?[\d.e+-]+)\)/.exec(
      this.style.transform ?? "",
    );
    assert.ok(found !== null, `the surface carries a transform, got ${String(this.style.transform)}`);
    return { x: Number(found[1]), y: Number(found[2]), scale: Number(found[3]) };
  }
}

const runScript = (html: string, hash = "") => {
  const host = new FakeElement("document");
  const stage = new FakeElement("div");
  const surface = new FakeElement("div");
  const index = new FakeElement("nav");
  const fit = new FakeElement("button");
  const window = new FakeElement("window");
  for (const name of ["data-surface-w", "data-surface-h", "data-active-frame"]) {
    const value = attrOf(surfaceTag(html), name);
    if (value !== null) surface.setAttribute(name, value);
  }
  const frames = new Map<string, FakeElement>();
  const tabs = new Map<string, FakeElement>();
  for (const id of idsIn(html)) {
    const tag = frameTag(html, id);
    const element = new FakeElement("section");
    for (const name of ["data-frame-id", "data-frame-w", "data-frame-h", "data-frame-x", "data-frame-y"]) {
      const value = attrOf(tag, name);
      if (value !== null) element.setAttribute(name, value);
    }
    frames.set(id, element);
    const tab = new FakeElement("button");
    tab.setAttribute("data-target", id);
    tabs.set(id, tab);
  }
  index.children.push(...tabs.values());
  const elements = new Map<string, FakeElement>([
    ["stage", stage],
    ["frame-index", index],
    ["fit", fit],
  ]);
  if (surfaceTag(html) !== "") elements.set("surface", surface);
  const location = { hash };
  const context = {
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: (selector: string) => [...frames.values()].filter((frame) => matchesSelector(frame, selector)),
      addEventListener: (type: string, listener: Listener) => host.addEventListener(type, listener),
    },
    location,
    history: {
      replaceState: (_state: unknown, _title: unknown, next: string) => {
        location.hash = next;
      },
    },
    window,
  };
  vm.createContext(context);
  new vm.Script(inlineScript(html), { filename: "scene-viewer.js" }).runInContext(context);
  return { host, stage, surface, index, fit, frames, tabs, window, location, document: context.document };
};

test("the scene doubles answer only the selector they are given", () => {
  const run = runScript(renderSceneDocument(twoFrames));
  assert.equal(
    run.document.querySelectorAll('[data-frame-id="home"]').length,
    1,
    "a selector naming one frame answers it",
  );
  assert.equal(
    run.document.querySelectorAll('[data-frame-id="nope"]').length,
    0,
    "a selector naming a frame the scene does not hold answers nothing",
  );
  assert.deepEqual(run.document.querySelectorAll("[data-not-a-frame]"), [], "an unsupported selector fails closed");
  assert.equal(
    run.index.querySelectorAll('button[data-target="checkout"]').length,
    1,
    "the index answers the tab it names",
  );
  assert.deepEqual(run.index.querySelectorAll("a[href]"), [], "the index fails closed on an unsupported selector");
});

test("the scene script queries the attributes the markup emits", () => {
  const html = renderSceneDocument(twoFrames);
  const markup = html.replace(/<script>[^]*?<\/script>/i, "");
  const queried = attributeSelectorsOf(inlineScript(html));
  assert.ok(queried.length > 0, "the script queries at least one attribute selector");
  for (const name of queried)
    assert.ok(markup.includes(`${name}="`), `the markup emits ${name}, which the script queries`);
});

test("each scene kind runs exactly its own controller module and no other script", () => {
  assert.equal(
    inlineScript(renderSceneDocument(twoFrames)),
    `\n${canvasControllerScript()}\n`,
    "the canvas document runs the canvas controller and nothing beside it",
  );
  assert.equal(
    inlineScript(renderSceneDocument(twoFrames, undefined, undefined, [], "deck")),
    `\n${deckControllerScript()}\n`,
    "the deck document runs the deck controller and nothing beside it",
  );
  assert.notEqual(canvasControllerScript(), deckControllerScript(), "the two controllers are different scripts");
  assert.equal(
    (renderSceneDocument(twoFrames).match(/<script/gi) ?? []).length,
    1,
    "the canvas ships one script, not both",
  );
  assert.equal(
    (renderSceneDocument(twoFrames, undefined, undefined, [], "deck").match(/<script/gi) ?? []).length,
    1,
    "the deck ships one script, not both",
  );
});

test("the canvas controller owns the viewport and the deck controller never sees it", () => {
  const canvas = canvasControllerScript();
  for (const own of [
    'getElementById("surface")',
    'getElementById("fit")',
    "wheel",
    "pointerdown",
    "data-frame-x",
    "data-surface-w",
    "history.replaceState",
  ])
    assert.ok(canvas.includes(own), `the canvas controller owns ${own}`);
  for (const deckWord of [
    "frame-counter",
    'getElementById("prev")',
    'getElementById("next")',
    'getElementById("strip")',
    "aria-pressed",
  ])
    assert.equal(canvas.includes(deckWord), false, `the canvas controller knows no ${deckWord}`);
  const deck = deckControllerScript();
  for (const own of [
    'getElementById("prev")',
    'getElementById("next")',
    'getElementById("strip")',
    'getElementById("frame-counter")',
    "aria-pressed",
    "hidden =",
  ])
    assert.ok(deck.includes(own), `the deck controller owns ${own}`);
  for (const canvasWord of [
    "wheel",
    "pointerdown",
    "pointermove",
    "data-surface-w",
    "data-frame-x",
    'getElementById("surface")',
    'getElementById("fit")',
  ])
    assert.equal(deck.includes(canvasWord), false, `the deck controller knows no ${canvasWord}`);
});

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

test("PRESERVE: each controller script is the script the split started from", () => {
  assert.equal(
    digest(canvasControllerScript()),
    "c43c1edc919d6770657f98bc800e0abb1987f8d43e92daa2614c889c9b34dbe1",
    "the canvas controller is byte for byte the script the renderer used to inline",
  );
  assert.equal(
    digest(deckControllerScript()),
    "3396420c51365406f188e0c3545f2f0f8ee690b499195db36cf6977c5da783f3",
    "the deck controller is byte for byte the script the renderer used to inline",
  );
});

test("the renderer inlines neither controller: it imports them", () => {
  const renderer = readFileSync(
    fileURLToPath(new URL("../apps/api/src/viewer/views/scene.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(renderer.includes('from "./canvas-controller.ts"'), "the renderer imports the canvas controller");
  assert.ok(renderer.includes('from "./deck-controller.ts"'), "the renderer imports the deck controller");
  for (const inlined of ['getElementById("stage")', 'getElementById("surface")', "pointerdown", "history.replaceState"])
    assert.equal(renderer.includes(inlined), false, `${inlined} lives in a controller module`);
  assert.ok(renderer.includes("sceneThreadPlacement"), "the renderer keeps the shared pin placement");
  assert.ok(renderer.includes("surfaceLayout"), "the renderer keeps the shared frame placement");
});

test("every canvas frame renders at its own placement on one surface, and all of them stay visible", () => {
  const html = renderSceneDocument(twoFrames);
  const layout = surfaceLayout(twoFrames.frames);
  const index = indexMarkup(html);
  assert.equal((html.match(/data-target="/g) ?? []).length, 2);
  assert.ok(index.includes(">Home</button>"), index);
  assert.ok(index.includes(">Checkout</button>"), index);
  assert.ok(index.indexOf("Home") < index.indexOf("Checkout"), "the index keeps the scene order");
  assert.ok(html.includes('aria-label="Frames"'));
  assert.deepEqual(idsIn(html), ["home", "checkout"], "both frames ship on the surface, in scene order");
  for (const tag of sectionTags(html)) assert.equal(tag.includes("hidden"), false, `no frame is hidden: ${tag}`);
  for (const placement of layout.placements) {
    assert.deepEqual(placedAt(html, placement.frameId), { x: placement.x, y: placement.y }, placement.frameId);
    assert.ok(
      frameTag(html, placement.frameId).includes(`style="left:${placement.x}px;top:${placement.y}px"`),
      `the frame is positioned where the shared layout puts it: ${frameTag(html, placement.frameId)}`,
    );
  }
  const surface = surfaceTag(html);
  assert.ok(surface.length > 0, "the frames share one surface container");
  assert.equal(attrOf(surface, "data-surface-w"), String(layout.width));
  assert.equal(attrOf(surface, "data-surface-h"), String(layout.height));
  assert.ok(html.indexOf(surface) < html.indexOf('id="frame-home"'), "the surface wraps the frames");
});

test("frames that sit apart keep the x/y the scene stores, and a legacy scene shares one column", () => {
  const spread = renderSceneDocument(scene(frame(), frame({ id: "checkout", name: "Checkout", x: 500, y: 40 })));
  assert.deepEqual(placedAt(spread, "home"), { x: 0, y: 0 });
  assert.deepEqual(placedAt(spread, "checkout"), { x: 500, y: 40 }, "the stored x/y is the source of truth");
  assert.equal(attrOf(surfaceTag(spread), "data-surface-w"), "890", "the surface covers both placements");
  assert.equal(attrOf(surfaceTag(spread), "data-surface-h"), "884");

  const legacy = renderSceneDocument(twoFrames);
  const layout = surfaceLayout(twoFrames.frames);
  assert.deepEqual(
    placedAt(legacy, "checkout"),
    { x: 0, y: 884 },
    "two frames on the same origin are separated by the shared layout",
  );
  assert.equal(attrOf(surfaceTag(legacy), "data-surface-h"), String(layout.height));
  assert.deepEqual(placedAt(legacy, "home"), { x: 0, y: 0 });
});

test("the second frame opens from the URL fragment by centring it, and the hash keeps following navigation", () => {
  const html = renderSceneDocument(twoFrames);
  const layout = surfaceLayout(twoFrames.frames);
  const scale = fittedSurface(layout).scale;
  const checkout = layout.placements.find((entry) => entry.frameId === "checkout");
  const home = layout.placements.find((entry) => entry.frameId === "home");
  assert.ok(checkout !== undefined && home !== undefined);

  const linked = runScript(html, "#frame-checkout");
  sameView(linked.surface.view(), centredOn(checkout, { w: 390, h: 844 }, scale), "the fragment centres its frame");
  assert.equal(linked.tabs.get("checkout")?.getAttribute("aria-current"), "true");
  assert.equal(linked.tabs.get("home")?.getAttribute("aria-current"), null);
  for (const frame of linked.frames.values())
    assert.equal(frame.style.transform, undefined, "frames are not transformed one by one");

  const follow = runScript(html);
  sameView(follow.surface.view(), fittedSurface(layout), "without a fragment the whole surface is fitted");
  follow.location.hash = "#frame-checkout";
  follow.window.emit("hashchange");
  sameView(follow.surface.view(), centredOn(checkout, { w: 390, h: 844 }, scale), "the hash follows navigation");
  assert.equal(follow.tabs.get("checkout")?.getAttribute("aria-current"), "true");
});

test("left and right, page up and down, home and end move the active frame and centre it", () => {
  const travel = scene(frame(), frame({ id: "b", name: "B" }), frame({ id: "c", name: "C" }));
  const layout = surfaceLayout(travel.frames);
  const scale = fittedSurface(layout).scale;
  const nav = runScript(renderSceneDocument(travel));
  const current = () =>
    [...nav.tabs.entries()].filter(([, tab]) => tab.getAttribute("aria-current") === "true").map(([id]) => id);
  const centred = (id: string) => {
    const at = layout.placements.find((entry) => entry.frameId === id);
    assert.ok(at !== undefined, id);
    sameView(nav.surface.view(), centredOn(at, { w: 390, h: 844 }, scale), `${id} is centred`);
  };
  assert.deepEqual(current(), ["home"], "the first frame is active before any key");
  nav.host.emit("keydown", { key: "ArrowRight" });
  assert.deepEqual(current(), ["b"]);
  centred("b");
  nav.host.emit("keydown", { key: "PageDown" });
  assert.deepEqual(current(), ["c"]);
  centred("c");
  nav.host.emit("keydown", { key: "ArrowLeft" });
  assert.deepEqual(current(), ["b"]);
  nav.host.emit("keydown", { key: "PageUp" });
  assert.deepEqual(current(), ["home"]);
  centred("home");
  nav.host.emit("keydown", { key: "End" });
  assert.deepEqual(current(), ["c"]);
  nav.host.emit("keydown", { key: "Home" });
  assert.deepEqual(current(), ["home"]);
  assert.equal(nav.frames.size, 3, "every frame stays on the surface");
});

test("clicking an index entry centres that frame and leaves every other frame in place", () => {
  const html = renderSceneDocument(twoFrames);
  const layout = surfaceLayout(twoFrames.frames);
  const scale = fittedSurface(layout).scale;
  const click = runScript(html);
  const target = click.tabs.get("checkout");
  assert.ok(target !== undefined);
  click.index.emit("click", { target: { closest: () => target } });
  assert.equal(click.tabs.get("checkout")?.getAttribute("aria-current"), "true");
  const at = layout.placements.find((entry) => entry.frameId === "checkout");
  assert.ok(at !== undefined);
  sameView(click.surface.view(), centredOn(at, { w: 390, h: 844 }, scale), "the entry pans the surface to its frame");
  assert.deepEqual([...click.frames.keys()], ["home", "checkout"], "no frame leaves the surface");
  assert.equal(click.location.hash, "#frame-checkout", "the index writes the deep link");
});

test("ctrl or cmd with the wheel zooms the whole surface around the pointer", () => {
  const html = renderSceneDocument(scene(frame()));
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    const zoom = runScript(html);
    const before = zoom.surface.view();
    zoom.stage.emit("wheel", { deltaY: -240, deltaX: 0, clientX: 640, clientY: 400, ...modifier });
    const after = zoom.surface.view();
    assert.ok(after.scale > before.scale, `${JSON.stringify(modifier)}: ${after.scale} > ${before.scale}`);
    const anchorX = (view: View) => (640 - view.x) / view.scale;
    const anchorY = (view: View) => (400 - view.y) / view.scale;
    close(anchorX(after), anchorX(before), "the point under the pointer keeps its x");
    close(anchorY(after), anchorY(before), "the point under the pointer keeps its y");
    for (const frame of zoom.frames.values())
      assert.equal(frame.style.transform, undefined, "the zoom belongs to the surface, not to a frame");
  }
});

test("a plain wheel pans the whole surface instead of zooming", () => {
  const html = renderSceneDocument(twoFrames);
  const wheel = runScript(html);
  const start = wheel.surface.view();

  wheel.stage.emit("wheel", { deltaY: 120, deltaX: 40, clientX: 640, clientY: 400 });
  const scrolled = wheel.surface.view();
  close(scrolled.scale, start.scale, "a plain wheel never zooms");
  close(scrolled.x, start.x - 40, "a sideways deltaX moves the surface the other way");
  close(scrolled.y, start.y - 120, "scrolling down lifts the surface so the content below comes into view");

  wheel.stage.emit("wheel", { deltaY: -120, deltaX: -40, clientX: 640, clientY: 400 });
  sameView(wheel.surface.view(), start, "scrolling back returns the surface exactly where it was");

  wheel.stage.emit("wheel", { deltaY: 90, deltaX: 0, shiftKey: true, clientX: 640, clientY: 400 });
  const shifted = wheel.surface.view();
  close(shifted.x, start.x - 90, "shift turns a mouse wheel into a horizontal pan");
  close(shifted.y, start.y, "a shift pan does not drift vertically");
  close(shifted.scale, start.scale, "a shift pan never zooms");

  for (const frame of wheel.frames.values())
    assert.equal(frame.style.transform, undefined, "the pan belongs to the surface, not to a frame");
});

test("a presentation keeps its own script: no wheel, no pan", () => {
  const deck = inlineScript(renderSceneDocument(twoFrames, undefined, undefined, [], "deck"));
  assert.equal(deck.includes("wheel"), false, "a presentation never zooms or pans on the wheel");
  assert.equal(deck.includes("pointerdown"), false, "a presentation never pans by dragging");
});

test("space-drag and middle-drag pan the surface, and fit frames the whole canvas", () => {
  const html = renderSceneDocument(twoFrames);
  const layout = surfaceLayout(twoFrames.frames);
  const pan = runScript(html);
  const fitted = pan.surface.view();
  sameView(fitted, fittedSurface(layout), "the surface starts fitted to every frame");

  pan.host.emit("keydown", { key: " " });
  pan.stage.emit("pointerdown", { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  pan.stage.emit("pointermove", { clientX: 160, clientY: 140 });
  pan.stage.emit("pointerup", {});
  const dragged = pan.surface.view();
  close(dragged.x, fitted.x + 60, "the pan follows the pointer horizontally");
  close(dragged.y, fitted.y + 40, "the pan follows the pointer vertically");
  close(dragged.scale, fitted.scale, "panning does not zoom");

  pan.host.emit("keyup", { key: " " });
  pan.stage.emit("pointerdown", { button: 0, clientX: 0, clientY: 0 });
  pan.stage.emit("pointermove", { clientX: -20, clientY: 0 });
  close(pan.surface.view().x, dragged.x, "a plain drag without space does not pan");

  pan.stage.emit("pointerdown", { button: 1, clientX: 0, clientY: 0 });
  pan.stage.emit("pointermove", { clientX: 10, clientY: 0 });
  pan.stage.emit("pointerup", {});
  close(pan.surface.view().x, dragged.x + 10, "the middle button pans");

  pan.stage.emit("wheel", { deltaY: -400, deltaX: 0, ctrlKey: true, clientX: 100, clientY: 100 });
  pan.fit.emit("click");
  sameView(pan.surface.view(), fitted, "fit frames the whole surface again");
  const view = pan.surface.view();
  assert.ok(view.x >= -1e-6 && view.y >= -1e-6, "the fitted surface starts inside the viewport");
  assert.ok(view.x + layout.width * view.scale <= STAGE.w + 1e-6, "every frame is in view horizontally");
  assert.ok(view.y + layout.height * view.scale <= STAGE.h + 1e-6, "and vertically");
});

test("one shared view keeps the zoom and the pan when the active frame changes", () => {
  const html = renderSceneDocument(twoFrames);
  const layout = surfaceLayout(twoFrames.frames);
  const travel = runScript(html);
  const fitted = travel.surface.view();
  travel.stage.emit("wheel", { deltaY: -300, deltaX: 0, ctrlKey: true, clientX: 200, clientY: 200 });
  const zoomed = travel.surface.view();
  assert.notEqual(zoomed.scale, fitted.scale);
  travel.host.emit("keydown", { key: "ArrowRight" });
  const after = travel.surface.view();
  const checkout = layout.placements.find((entry) => entry.frameId === "checkout");
  assert.ok(checkout !== undefined);
  close(after.scale, zoomed.scale, "the zoom belongs to the surface, not to a frame");
  sameView(after, centredOn(checkout, { w: 390, h: 844 }, zoomed.scale), "the next frame is centred at the same zoom");
});

test("rect, text, path and image nodes render their markup", () => {
  const html = renderSceneDocument(scene(frame({ nodes: [rect(), text(), path(), image()] })));
  assert.ok(
    html.includes(
      'class="node node-rect" data-node-id="rect-1" style="left:10px;top:20px;width:100px;height:50px;background:#ff0000;border-radius:8px"',
    ),
    html,
  );
  assert.ok(html.includes("font-size:24px;font-weight:600;color:#112233;text-align:center"));
  assert.ok(html.includes(">Hello</div>"));
  assert.ok(html.includes('class="node node-path" data-node-id="path-1"'));
  assert.ok(html.includes('viewBox="0 0 100 100"'));
  assert.ok(html.includes('d="M0 0L100 100" fill="#00ff00" stroke="#000000" stroke-width="2"'));
  assert.ok(html.includes('class="node node-image" data-node-id="image-1"'));
  assert.ok(html.includes('<code class="node-image-id">asset-42</code>'), "the placeholder names the asset");
  assert.ok(html.includes("Image"));
});

test("frame names, text and asset ids are escaped and the document keeps one script tag", () => {
  const hostile = "<script>alert(1)</script>";
  const escaped = "&lt;script&gt;alert(1)&lt;/script&gt;";
  const html = renderSceneDocument(
    scene(frame({ name: hostile, nodes: [text({ text: hostile }), image({ assetId: hostile })] })),
  );
  assert.equal(html.includes(hostile), false);
  assert.ok(html.includes(`<title>${escaped}</title>`), "the document title is escaped");
  assert.ok(indexMarkup(html).includes(`>${escaped}</button>`), "the index entry is escaped");
  assert.ok(html.includes(`<p class="scene-frame-name">${escaped}`), "the frame caption is escaped");
  assert.ok(html.includes(`text-align:center">${escaped}</div>`), "the text content is escaped");
  assert.ok(html.includes(`<code class="node-image-id">${escaped}</code>`), "the asset id is escaped");
  assert.equal((html.match(/<script/gi) ?? []).length, 1, "only the renderer's own script tag");
  assert.equal(/<[a-z][^>]*\son[a-z]+\s*=/i.test(html), false, "no inline event handler attribute");
  assert.equal(/<link\b|@font-face|https?:\/\//i.test(html), false, "nothing is fetched");
});

test("a path d that tries to close the attribute is escaped, not obeyed", () => {
  const hostile = 'M0 0"><script>alert(1)</script>';
  const html = renderSceneDocument(scene(frame({ nodes: [path({ d: hostile })] })));
  assert.equal(html.includes('"><script>'), false);
  assert.ok(html.includes('d="M0 0&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'), html);
  assert.equal((html.match(/<script/gi) ?? []).length, 1);
});

test("attacker influenced colours are validated before they reach a style or svg attribute", () => {
  for (const fill of [
    'red";background:url(javascript:alert(1))',
    "url(#x)",
    "expression(alert(1))",
    "rgb(0,0,0);x:y",
  ]) {
    const html = renderSceneDocument(scene(frame({ nodes: [rect({ fill }), path({ fill, stroke: fill })] })));
    assert.equal(html.includes("url("), false, html);
    assert.equal(html.includes("javascript:"), false, html);
    assert.equal(html.includes("expression("), false, html);
    assert.equal(html.includes(";x:y"), false, html);
  }
  const accepted = renderSceneDocument(scene(frame({ nodes: [rect({ fill: "#0af" }), text()] })));
  assert.ok(accepted.includes("background:#0af"));
  assert.ok(accepted.includes("color:#112233"));
});

test("the document is self-contained: no network, no storage, no external font", () => {
  const html = renderSceneDocument(twoFrames);
  const script = inlineScript(html);
  assert.ok(html.includes("content-security-policy"), "the document carries its own policy");
  assert.ok(html.includes("default-src 'none'"), "the policy denies every fetch by default");
  for (const forbidden of ["fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "document.cookie", "import("])
    assert.equal(script.includes(forbidden), false, `${forbidden} stays out of the inline script`);
  assert.equal(/<link\b|<img\b|@import|https?:/i.test(html), false, "nothing is fetched");
  assert.ok(html.includes("system-ui"), "only system fonts are named");
});

test("the inline script parses", () => {
  const script = inlineScript(renderSceneDocument(twoFrames));
  assert.ok(script.length > 0);
  assert.doesNotThrow(() => new vm.Script(script, { filename: "scene-viewer.js" }));
});

test("the frame named in the URL query opens centred and the index marks it", () => {
  const html = renderSceneDocument(twoFrames, "checkout");
  assert.equal(
    attrOf(surfaceTag(html), "data-active-frame"),
    "checkout",
    "the server names the frame the link asked for",
  );
  for (const tag of sectionTags(html)) assert.equal(tag.includes("hidden"), false, "nothing is hidden to open a frame");
  const index = indexMarkup(html);
  assert.ok(index.includes('data-target="checkout" aria-current="true"'), index);
  assert.equal(index.includes('data-target="home" aria-current="true"'), false);
  const layout = surfaceLayout(twoFrames.frames);
  const at = layout.placements.find((entry) => entry.frameId === "checkout");
  assert.ok(at !== undefined);
  const opened = runScript(html);
  sameView(
    opened.surface.view(),
    centredOn(at, { w: 390, h: 844 }, fittedSurface(layout).scale),
    "the client pans to the frame the server named",
  );
  assert.equal(opened.tabs.get("checkout")?.getAttribute("aria-current"), "true");
});

test("an unknown or empty frame id fits the whole surface instead of failing the page", () => {
  const layout = surfaceLayout(twoFrames.frames);
  for (const frameId of ["missing", "", undefined]) {
    const html = renderSceneDocument(twoFrames, frameId);
    assert.equal(attrOf(surfaceTag(html), "data-active-frame"), null, `${String(frameId)} names no frame to open`);
    assert.equal(html.includes('id="frame-missing"'), false, "the unknown id renders nothing of its own");
    assert.equal((html.match(/data-target="/g) ?? []).length, 2, "both frames stay reachable");
    for (const tag of sectionTags(html)) assert.equal(tag.includes("hidden"), false, "every frame stays visible");
    assert.doesNotThrow(() => runScript(html), "the page still runs");
    const run = runScript(html);
    sameView(run.surface.view(), fittedSurface(layout), "the whole surface is fitted");
    run.host.emit("keydown", { key: "ArrowRight" });
    assert.equal(run.tabs.get("checkout")?.getAttribute("aria-current"), "true", "the keys reach every frame");
  }
});

test("an empty scene renders a clear empty state", () => {
  const html = renderSceneDocument(scene());
  assert.ok(html.includes('class="scene-empty"'), html);
  assert.ok(html.includes("no frames"), html);
  assert.equal((html.match(/class="scene-frame"/g) ?? []).length, 0);
  assert.equal((html.match(/data-target="/g) ?? []).length, 0);
  assert.doesNotThrow(() => runScript(html), "the script survives an empty scene");
});

test("a frame with no nodes still shows its name and its dimensions", () => {
  const html = renderSceneDocument(scene(frame({ name: "Checkout", w: 320, h: 640 })));
  assert.ok(html.includes('<p class="scene-frame-name">Checkout'), html);
  assert.ok(html.includes("320 × 640"), html);
  assert.ok(html.includes('style="width:320px;height:640px"'));
  assert.equal(html.includes('class="scene-empty"'), false);
});

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const ORIGIN = "https://canvas.test";
const imageScene = (node: Partial<ImageNode> = {}): Scene =>
  scene(frame({ nodes: [image({ assetId: DIGEST, ...node })] }));
const images = (
  overrides: Partial<{ origin: string; artifactId: string; digests: ReadonlySet<string>; token: string }> = {},
) => ({
  origin: ORIGIN,
  artifactId: "artifact-one",
  digests: new Set([DIGEST]),
  ...overrides,
});
const policyOf = (html: string): string => /content-security-policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
const imageTags = (html: string): string[] => html.match(/<img\b[^>]*>/g) ?? [];

test("the scene document allows images from exactly one origin and no other source", () => {
  const policy = policyOf(renderSceneDocument(imageScene(), undefined, images()));
  assert.equal(
    policy,
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://canvas.test; base-uri 'none'; form-action 'none'",
    "the policy adds img-src with the configured origin and keeps every other directive",
  );
  assert.equal((policy.match(/img-src/g) ?? []).length, 1, "exactly one image directive");
  const imageSources = (policy.split("; ").find((directive) => directive.startsWith("img-src")) ?? "")
    .split(" ")
    .slice(1);
  assert.deepEqual(imageSources, [ORIGIN], "the only image source is the configured origin");
});

test("a scene without an image source keeps the policy it has today", () => {
  assert.equal(
    policyOf(renderSceneDocument(twoFrames)),
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  );
});

test("a referenced asset renders one real image with the delivery url and the node box", () => {
  const html = renderSceneDocument(imageScene(), undefined, images());
  const tags = imageTags(html);
  assert.equal(tags.length, 1, html);
  const tag = tags[0] ?? "";
  assert.ok(tag.includes(`src="${ORIGIN}/artifact/artifact-one/asset/${DIGEST}"`), tag);
  assert.ok(tag.includes('data-node-id="image-1"'), tag);
  assert.ok(tag.includes("left:0px;top:0px;width:120px;height:80px"), tag);
  assert.ok(tag.includes("object-fit:contain"), tag);
  assert.ok(tag.includes('alt="image-1"'), tag);
  assert.equal(html.includes('<span class="node-image-label">'), false, "a real image draws no placeholder beside it");
  assert.equal(html.includes(`<code class="node-image-id">${DIGEST}</code>`), false, "and no digest label");
});

test("an asset the artifact does not reference keeps the labelled placeholder", () => {
  const html = renderSceneDocument(imageScene(), undefined, images({ digests: new Set([OTHER_DIGEST]) }));
  assert.deepEqual(imageTags(html), [], "no image is fetched for an unreferenced digest");
  assert.ok(html.includes('class="node node-image" data-node-id="image-1"'), html);
  assert.ok(html.includes('<span class="node-image-label">Image</span>'), "the placeholder stays diagnosable");
  assert.ok(html.includes(`<code class="node-image-id">${DIGEST}</code>`), "and names the missing asset");
});

test("an asset id that is not a sha256 digest degrades to the placeholder", () => {
  for (const assetId of [
    "asset-42",
    "A".repeat(64),
    `${"a".repeat(63)}g`,
    `${"a".repeat(64)}/../x`,
    `"><script>alert(1)</script>`,
  ]) {
    const html = renderSceneDocument(
      scene(frame({ nodes: [image({ assetId })] })),
      undefined,
      images({
        digests: new Set([assetId]),
      }),
    );
    assert.deepEqual(imageTags(html), [], `${assetId} never reaches the url`);
    assert.ok(html.includes('class="node node-image"'), `${assetId} degrades to the placeholder`);
  }
});

test("a public link's token rides on the image url the delivery route reads", () => {
  const token = "t".repeat(43);
  const html = renderSceneDocument(imageScene(), undefined, images({ token }));
  const tag = imageTags(html)[0] ?? "";
  assert.ok(tag.includes(`src="${ORIGIN}/artifact/artifact-one/asset/${DIGEST}?token=${token}"`), tag);
  assert.equal(renderSceneDocument(imageScene(), undefined, images()).includes("token="), false);
});

test("the alt text is a scene string and markup in it is escaped", () => {
  const hostile = '"><script>alert(1)</script>';
  const html = renderSceneDocument(
    scene(frame({ nodes: [image({ id: hostile, assetId: DIGEST })] })),
    undefined,
    images(),
  );
  const tag = imageTags(html)[0] ?? "";
  assert.ok(tag.includes('alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'), tag);
  assert.equal(html.includes(hostile), false, "the raw node id never reaches the document");
  assert.equal(/<[a-z][^>]*\son[a-z]+\s*=/i.test(tag), false, "an image carries no event handler attribute");
  assert.equal((tag.match(/\son[a-z]+=/gi) ?? []).length, 0);
});

const boardThread = (overrides: Record<string, unknown> = {}) => ({
  id: "thread-one",
  anchor: { kind: "board-point", boardId: "home", nodeId: "node-1", x: 0.25, y: 0.5, ...overrides },
});

const pinMarkup = (html: string): string[] => html.match(/<span class="scene-pin"[^>]*>[^<]*<\/span>/g) ?? [];

test("a scene pin stays decorative: no handler, no panel and no thread affordance", () => {
  for (const kind of ["canvas", "deck"]) {
    const html = renderSceneDocument(
      scene(frame({ nodes: [rect({ id: "node-1" })] })),
      undefined,
      undefined,
      [boardThread({ boardId: "home", nodeId: "node-1" })],
      kind,
    );
    const pin = pinMarkup(html)[0] ?? "";
    assert.ok(pin.length > 0, `${kind} draws the pin`);
    assert.equal(/\son[a-z]+\s*=/i.test(pin), false, `${kind} pin carries no event handler`);
    for (const affordance of ["role=", "href=", "data-action", "aria-haspopup", "aria-expanded", "contenteditable"])
      assert.equal(pin.includes(affordance), false, `${kind} pin offers no ${affordance}`);
    const script = inlineScript(html);
    for (const wired of ["scene-pin", "data-thread-id", "data-node-id"])
      assert.equal(script.includes(wired), false, `${kind} controller wires no ${wired}`);
    assert.equal(html.includes("scene-thread"), false, `${kind} ships no thread panel`);
  }
});

test("a scene-anchored thread draws one pin at the node-relative point", () => {
  const html = renderSceneDocument(
    scene(frame({ nodes: [rect({ id: "node-1", x: 40, y: 20, w: 100, h: 60 })] })),
    undefined,
    undefined,
    [boardThread()],
  );
  assert.equal((html.match(/class="scene-pin"/g) ?? []).length, 1, "exactly one pin");
  assert.ok(
    html.includes(
      '<span class="scene-pin" tabindex="0" data-thread-id="thread-one" data-node-id="node-1" aria-label="Comment thread 1" style="left:65px;top:50px">1</span>',
    ),
    html,
  );
  assert.equal(html.includes('class="scene-orphans"'), false, "a placed pin needs no orphan list");
});

test("the pin lands in the frame that holds the node, at the frame's own origin", () => {
  const html = renderSceneDocument(
    scene(
      frame({ id: "home", name: "Home", nodes: [rect({ id: "a", x: 0, y: 0, w: 10, h: 10 })] }),
      frame({ id: "away", name: "Away", x: 400, y: 100, nodes: [rect({ id: "b", x: 30, y: 40, w: 20, h: 20 })] }),
    ),
    undefined,
    undefined,
    [boardThread({ boardId: "away", nodeId: "b", x: 0.5, y: 0.25 })],
  );
  const home = html.indexOf('id="frame-home"');
  const away = html.indexOf('id="frame-away"');
  const pin = html.indexOf('class="scene-pin"');
  assert.ok(home < away && away < pin, "the pin is drawn inside the second frame body");
  const pins = pinMarkup(html);
  assert.equal(pins.length, 1);
  assert.ok(
    (pins[0] ?? "").includes('style="left:40px;top:45px"'),
    `20*0.5+30 and 20*0.25+40, never the frame offset: ${pins[0] ?? ""}`,
  );
});

test("a thread whose node is gone draws no pin and is listed in plain words", () => {
  for (const anchor of [boardThread({ nodeId: "node-gone" }).anchor, boardThread({ boardId: "frame-gone" }).anchor]) {
    const html = renderSceneDocument(scene(frame({ nodes: [rect({ id: "node-1" })] })), undefined, undefined, [
      { id: "thread-one", anchor },
    ]);
    assert.equal((html.match(/class="scene-pin"/g) ?? []).length, 0, "no pin at a stale position");
    assert.ok(html.includes('class="scene-orphans" aria-label="Comment threads without a node"'), html);
    assert.ok(html.includes("Threads without a node"));
    assert.ok(html.includes("Thread 1 points at something that no longer exists in this canvas."), html);
    assert.equal((html.match(/<script/gi) ?? []).length, 1, "the document keeps its one script tag");
    assert.doesNotThrow(() => new vm.Script(inlineScript(html), { filename: "scene-viewer.js" }));
  }
});

test("orphaned threads are listed when the scene has no frames at all", () => {
  const html = renderSceneDocument(scene(), undefined, undefined, [boardThread()]);
  assert.ok(html.includes('class="scene-empty"'), "the empty state stays");
  assert.ok(html.includes("Thread 1 points at something that no longer exists in this canvas."), html);
  assert.doesNotThrow(() => new vm.Script(inlineScript(html), { filename: "scene-viewer.js" }));
});

test("a pin id taken from the comment store is escaped", () => {
  const hostile = '"><script>alert(1)</script>';
  const html = renderSceneDocument(scene(frame({ nodes: [rect({ id: "node-1" })] })), undefined, undefined, [
    { id: hostile, anchor: boardThread().anchor },
  ]);
  assert.equal(html.includes(hostile), false, "the raw thread id never reaches the document");
  assert.ok(html.includes('data-thread-id="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'), html);
  assert.equal((html.match(/<script/gi) ?? []).length, 1, "the escaped id is not a script tag");
  assert.equal(/<[a-z][^>]*\son[a-z]+\s*=/i.test(html), false, "no inline event handler attribute");
});

test("omitting the threads argument renders the same document as passing none", () => {
  const pinnedScene = scene(frame({ nodes: [rect()] }));
  assert.equal(renderSceneDocument(pinnedScene, undefined, undefined, []), renderSceneDocument(pinnedScene));
});
