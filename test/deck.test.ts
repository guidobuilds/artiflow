import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import vm from "node:vm";

import {
  SCENE_FORMAT_VERSION,
  type RectNode,
  type Scene,
  type SceneFrame,
  type TextNode,
} from "@artiflow/domain/scene";
import {
  anchorKindAllowed,
  anchorShapeIsValid,
  sceneAnchorRefusal,
  type SlidePointAnchor,
} from "@artiflow/domain/comment-anchors";
import {
  KIND_ICONS,
  ARTIFACT_KINDS,
  anchorKindsFor,
  capabilitiesFor,
  extensionsFor,
  iconFor,
  kindForExtension,
  pluralFor,
  viewerFor,
  wireNameFor,
} from "@artiflow/domain/kinds";

import { renderSceneDocument } from "../apps/api/src/viewer/scene.ts";
import { sceneThreadPlacement } from "../apps/api/src/viewer/comments-data.ts";
import { attributeSelectorsOf, matchesSelector } from "./helpers/frame-selector.ts";

const rect = (overrides: Partial<RectNode> = {}): RectNode => ({
  id: "card",
  type: "rect",
  x: 10,
  y: 20,
  w: 100,
  h: 50,
  fill: "#ff0000",
  ...overrides,
});

const text = (overrides: Partial<TextNode> = {}): TextNode => ({
  id: "title",
  type: "text",
  x: 0,
  y: 0,
  w: 200,
  h: 40,
  text: "Hello",
  style: { fontSize: 24, fontWeight: 600, color: "#112233", align: "center" },
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

const slideScene = scene(
  frame({ id: "home", name: "Home", nodes: [rect()] }),
  frame({ id: "checkout", name: "Checkout", x: 400, y: 0, nodes: [text()] }),
);

const threeSlides = scene(
  frame({ id: "a", name: "A" }),
  frame({ id: "b", name: "B", x: 400 }),
  frame({ id: "c", name: "C", x: 800 }),
);

const inlineScript = (html: string): string => html.match(/<script>([^]*?)<\/script>/i)?.[1] ?? "";

const frameTag = (html: string, id: string): string =>
  html.match(new RegExp(`<section[^>]*id="frame-${id}"[^>]*>`))?.[0] ?? "";

const counterText = (html: string): string => html.match(/<p class="scene-counter"[^>]*>([^<]*)<\/p>/)?.[1] ?? "";

const indexTag = (html: string): string => html.match(/<nav class="scene-index"[^>]*>/)?.[0] ?? "";

const policyOf = (html: string): string => /content-security-policy" content="([^"]*)"/.exec(html)?.[1] ?? "";

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  hidden = false;
  textContent = "";
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

  emit(type: string, event: Record<string, unknown> = {}): void {
    const payload = { preventDefault: () => {}, altKey: false, ctrlKey: false, metaKey: false, ...event };
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }

  view(): { x: number; y: number; scale: number } {
    const found = /translate\((-?[\d.]+)px, ?(-?[\d.]+)px\) scale\((-?[\d.]+)\)/.exec(this.style.transform ?? "");
    assert.ok(found !== null, `the slide carries a transform, got ${String(this.style.transform)}`);
    return { x: Number(found[1]), y: Number(found[2]), scale: Number(found[3]) };
  }
}

const runDeck = (html: string, ids: readonly string[], hash = "", visible = ids[0]) => {
  const host = new FakeElement("document");
  const stage = new FakeElement("div");
  const index = new FakeElement("nav");
  const prev = new FakeElement("button");
  const next = new FakeElement("button");
  const strip = new FakeElement("button");
  const counter = new FakeElement("p");
  const window = new FakeElement("window");
  const frames = new Map<string, FakeElement>();
  const tabs = new Map<string, FakeElement>();
  index.hidden = indexTag(html).includes("hidden");
  counter.textContent = counterText(html);
  for (const id of ids) {
    const element = new FakeElement("section");
    element.setAttribute("data-frame-id", id);
    element.setAttribute("data-frame-w", "400");
    element.setAttribute("data-frame-h", "800");
    element.hidden = id !== visible;
    frames.set(id, element);
    const tab = new FakeElement("button");
    tab.setAttribute("data-target", id);
    tabs.set(id, tab);
  }
  index.children.push(...tabs.values());
  const elements = new Map([
    ["stage", stage],
    ["frame-index", index],
    ["prev", prev],
    ["next", next],
    ["strip", strip],
    ["frame-counter", counter],
  ]);
  const location = { hash };
  const context = {
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: (selector: string) => [...frames.values()].filter((frame) => matchesSelector(frame, selector)),
      addEventListener: (type: string, listener: Listener) => host.addEventListener(type, listener),
    },
    location,
    history: { replaceState: () => {} },
    window,
  };
  vm.createContext(context);
  new vm.Script(inlineScript(html), { filename: "slide-viewer.js" }).runInContext(context);
  return { host, stage, index, prev, next, strip, counter, frames, tabs, window, location, document: context.document };
};

const visibleSlides = (run: { frames: Map<string, FakeElement> }): string[] =>
  [...run.frames.entries()].filter(([, element]) => !element.hidden).map(([id]) => id);

test("the slide script queries the attributes the markup emits", () => {
  const html = renderSceneDocument(slideScene, undefined, undefined, [], "deck");
  const markup = html.replace(/<script>[^]*?<\/script>/i, "");
  const queried = attributeSelectorsOf(inlineScript(html));
  assert.ok(queried.length > 0, "the script queries at least one attribute selector");
  for (const name of queried)
    assert.ok(markup.includes(`${name}="`), `the markup emits ${name}, which the script queries`);
});

test("the deck doubles answer only the selector they are given", () => {
  const html = renderSceneDocument(threeSlides, undefined, undefined, [], "deck");
  const run = runDeck(html, ["a", "b", "c"]);
  assert.equal(
    run.document.querySelectorAll('[data-frame-id="a"]').length,
    1,
    "a selector naming one frame answers it",
  );
  assert.equal(
    run.document.querySelectorAll('[data-frame-id="nope"]').length,
    0,
    "a selector naming a frame the deck does not hold answers nothing",
  );
  assert.deepEqual(run.document.querySelectorAll("[data-not-a-frame]"), [], "an unsupported selector fails closed");
  assert.equal(run.index.querySelectorAll('button[data-target="b"]').length, 1, "the index answers the tab it names");
  assert.deepEqual(run.index.querySelectorAll("a[href]"), [], "the index fails closed on an unsupported selector");
});

test("space on a focused control activates it instead of stepping the deck", () => {
  const html = renderSceneDocument(threeSlides, undefined, undefined, [], "deck");
  const run = runDeck(html, ["a", "b", "c"]);
  const button = {
    tagName: "BUTTON",
    closest: (selector: string) => (selector.includes("button") ? button : null),
  };
  let prevented = false;
  run.host.emit("keydown", {
    key: " ",
    target: button,
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, false, "space keeps its native meaning on the focused control");
  assert.deepEqual(visibleSlides(run), ["a"], "the deck does not step while a control has focus");
});

test("a deck is the fourth kind with its own icon, plural and slide anchor", () => {
  assert.deepEqual([...ARTIFACT_KINDS], ["html", "markdown", "canvas", "deck"]);
  const capabilities = capabilitiesFor("deck");
  assert.ok(capabilities, "the registry holds a deck row");
  assert.equal(wireNameFor("deck"), "deck", "the wire value is the kind itself");
  assert.equal(viewerFor("deck"), "scene", "a deck is rendered by the scene renderer");
  assert.equal(capabilities.comments, true);
  assert.deepEqual(capabilities.anchors, ["slide-point"], "a deck anchors a comment to a slide");
  assert.equal(capabilities.agentWrite, "replace-document");
  assert.equal(capabilities.appEdit, false, "the deck editor is a later slice");
  assert.deepEqual(extensionsFor("deck"), [".deck"]);
  assert.equal(kindForExtension(".deck"), "deck");
  assert.equal(kindForExtension(".DECK"), "deck");
  assert.ok((KIND_ICONS as readonly string[]).includes(iconFor("deck")), "the icon is registry vocabulary");
  assert.equal(iconFor("deck"), "slides", "a deck has its own icon");
  assert.equal(pluralFor("deck"), "Decks", "a deck has its own plural");
  const icons = ARTIFACT_KINDS.map(iconFor);
  assert.equal(new Set(icons).size, icons.length, "no kind borrows another kind's icon");
});

test("a deck accepts the slide anchor and refuses the canvas one", () => {
  assert.deepEqual(anchorKindsFor("deck"), ["slide-point"]);
  assert.equal(anchorKindAllowed("deck", "slide-point"), true);
  assert.equal(anchorKindAllowed("deck", "board-point"), false, "a deck is not a board");
  assert.equal(anchorKindAllowed("canvas", "slide-point"), false, "a canvas is not a deck");
  const anchor: SlidePointAnchor = { kind: "slide-point", slideId: "home", nodeId: "card", x: 0.25, y: 0.5 };
  assert.equal(anchorShapeIsValid(anchor), true);
  assert.equal(sceneAnchorRefusal(slideScene, anchor), null, "the slide and the node both exist");
  assert.equal(sceneAnchorRefusal(slideScene, { ...anchor, nodeId: "gone" }), "unknown_node");
  assert.equal(sceneAnchorRefusal(slideScene, { ...anchor, slideId: "gone" }), "unknown_node");
});

test("a deck places a slide-anchored thread on the slide it names", () => {
  const placement = sceneThreadPlacement(slideScene, [
    { id: "thread-one", anchor: { kind: "slide-point", slideId: "home", nodeId: "card", x: 0.25, y: 0.5 } },
  ]);
  assert.deepEqual(placement.orphans, []);
  assert.deepEqual(placement.pins, [
    { id: "thread-one", number: 1, frameId: "home", nodeId: "card", left: 35, top: 45 },
  ]);
  const gone = sceneThreadPlacement(slideScene, [
    { id: "thread-two", anchor: { kind: "slide-point", slideId: "home", nodeId: "gone", x: 0.25, y: 0.5 } },
  ]);
  assert.deepEqual(gone.pins, [], "a thread the deck cannot place draws no pin");
  assert.deepEqual(gone.orphans, [{ id: "thread-two", number: 1 }]);
});

test("a deck renders one slide at a time with the counter and no index strip", () => {
  const html = renderSceneDocument(slideScene, undefined, undefined, [], "deck");
  assert.equal(counterText(html), "1 / 2", "the counter names the slide and the total");
  assert.ok(indexTag(html).includes("hidden"), "the strip starts hidden");
  assert.ok(indexTag(html).includes('aria-label="Slides"'));
  assert.ok(html.includes('id="prev"'), "a back control");
  assert.ok(html.includes('id="next"'), "a forward control");
  assert.ok(html.includes('id="strip"'), "a control that shows the strip");
  assert.ok(html.includes('aria-pressed="false"'));
  assert.equal(html.includes("hidden"), true);
  assert.equal(frameTag(html, "home").includes("hidden"), false, "only the first slide is shown");
  assert.ok(frameTag(html, "checkout").includes("hidden"));
  assert.equal((html.match(/<section class="scene-frame"/g) ?? []).length, 2, "every slide ships in one document");
  assert.ok(html.includes('data-node-id="card"'), "the slide renders its nodes");
});

test("the canvas keeps its index strip, its pan and its zoom, and grows no counter", () => {
  const html = renderSceneDocument(slideScene);
  assert.equal(counterText(html), "", "a canvas has no slide counter");
  assert.equal(html.includes('class="scene-counter"'), false);
  assert.equal(indexTag(html).includes("hidden"), false, "the canvas index strip is visible");
  assert.equal(html.includes('id="strip"'), false, "no presentation control");
  assert.ok(html.includes('id="fit"'), "the canvas keeps its fit control");
  const script = inlineScript(html);
  assert.ok(script.includes('stage.addEventListener(\n    "wheel"'), "the canvas keeps its zoom");
  assert.ok(script.includes("pointerdown"), "the canvas keeps its pan");
  assert.equal(script.includes("frame-counter"), false, "the canvas script knows no counter");
});

test("the deck's own ?frame deep link opens that slide and counts it", () => {
  const html = renderSceneDocument(slideScene, "checkout", undefined, [], "deck");
  assert.equal(counterText(html), "2 / 2");
  assert.ok(frameTag(html, "home").includes("hidden"));
  assert.equal(frameTag(html, "checkout").includes("hidden"), false);
  assert.ok(indexTag(html).includes("hidden"), "a deep link does not open the strip");
  const opened = runDeck(html, ["home", "checkout"], "", "checkout");
  assert.deepEqual(visibleSlides(opened), ["checkout"], "the client honours the slide the server marked visible");
  assert.equal(opened.counter.textContent, "2 / 2");
});

test("an unknown or empty ?frame opens the deck's first slide", () => {
  for (const frameId of ["missing", "", undefined]) {
    const html = renderSceneDocument(slideScene, frameId, undefined, [], "deck");
    assert.deepEqual(visibleSlides(runDeck(html, ["home", "checkout"])), ["home"], String(frameId));
    assert.equal(counterText(html), "1 / 2");
    assert.doesNotThrow(() => runDeck(html, ["home", "checkout"]), "the deck still runs");
  }
});

test("arrows, page up and down, space and shift-space move the deck forward and back", () => {
  const html = renderSceneDocument(threeSlides, undefined, undefined, [], "deck");
  const run = runDeck(html, ["a", "b", "c"]);
  assert.deepEqual(visibleSlides(run), ["a"]);
  assert.equal(run.counter.textContent, "1 / 3");
  run.host.emit("keydown", { key: "ArrowRight" });
  assert.deepEqual(visibleSlides(run), ["b"]);
  assert.equal(run.counter.textContent, "2 / 3", "the counter follows the slide");
  run.host.emit("keydown", { key: " " });
  assert.deepEqual(visibleSlides(run), ["c"], "space moves forward");
  run.host.emit("keydown", { key: " " });
  assert.deepEqual(visibleSlides(run), ["c"], "the deck stops at the last slide");
  assert.equal(run.counter.textContent, "3 / 3");
  run.host.emit("keydown", { key: " ", shiftKey: true });
  assert.deepEqual(visibleSlides(run), ["b"], "shift-space moves back");
  run.host.emit("keydown", { key: "PageUp" });
  assert.deepEqual(visibleSlides(run), ["a"]);
  run.host.emit("keydown", { key: "PageDown" });
  assert.deepEqual(visibleSlides(run), ["b"]);
  run.host.emit("keydown", { key: "ArrowLeft" });
  assert.deepEqual(visibleSlides(run), ["a"]);
  assert.equal(run.counter.textContent, "1 / 3");
  for (const key of ["ArrowRight", "PageDown"]) {
    const separate = runDeck(html, ["a", "b", "c"]);
    separate.host.emit("keydown", { key });
    assert.deepEqual(visibleSlides(separate), ["b"], key);
  }
});

test("the deck's forward and back controls step the slides", () => {
  const html = renderSceneDocument(threeSlides, undefined, undefined, [], "deck");
  const run = runDeck(html, ["a", "b", "c"]);
  run.next.emit("click");
  assert.deepEqual(visibleSlides(run), ["b"]);
  assert.equal(run.counter.textContent, "2 / 3");
  run.next.emit("click");
  assert.deepEqual(visibleSlides(run), ["c"]);
  run.next.emit("click");
  assert.deepEqual(visibleSlides(run), ["c"], "the last slide is the end of the deck");
  run.prev.emit("click");
  assert.deepEqual(visibleSlides(run), ["b"]);
  run.prev.emit("click");
  run.prev.emit("click");
  assert.deepEqual(visibleSlides(run), ["a"], "the first slide is the start of the deck");
});

test("the strip toggle shows and hides the slides without leaving the current one", () => {
  const html = renderSceneDocument(threeSlides, undefined, undefined, [], "deck");
  const run = runDeck(html, ["a", "b", "c"]);
  assert.equal(run.index.hidden, true, "no strip by default");
  run.next.emit("click");
  run.strip.emit("click");
  assert.equal(run.index.hidden, false, "the toggle shows the strip");
  assert.equal(run.strip.getAttribute("aria-pressed"), "true");
  assert.deepEqual(visibleSlides(run), ["b"], "showing the strip keeps the slide");
  run.strip.emit("click");
  assert.equal(run.index.hidden, true, "the toggle hides it again");
  assert.equal(run.strip.getAttribute("aria-pressed"), "false");
  assert.deepEqual(visibleSlides(run), ["b"]);
  run.strip.emit("click");
  const target = run.tabs.get("c");
  assert.ok(target !== undefined);
  run.index.emit("click", { target: { closest: () => target } });
  assert.deepEqual(visibleSlides(run), ["c"], "a strip entry opens its slide");
  assert.equal(run.counter.textContent, "3 / 3");
});

test("a deck fits its slide to the stage and never zooms or pans", () => {
  const html = renderSceneDocument(threeSlides, undefined, undefined, [], "deck");
  const script = inlineScript(html);
  assert.equal(script.includes("wheel"), false, "a presentation does not zoom");
  assert.equal(script.includes("pointerdown"), false, "a presentation does not pan");
  const run = runDeck(html, ["a", "b", "c"]);
  run.stage.emit("wheel", { deltaY: -300, clientX: 100, clientY: 100 });
  run.stage.emit("pointerdown", { button: 0, clientX: 0, clientY: 0 });
  run.stage.emit("pointermove", { clientX: 50, clientY: 50 });
  const slide = run.frames.get("a");
  assert.ok(slide !== undefined);
  const view = slide.view();
  assert.equal(view.scale, Math.min(1280 / 400, 800 / 800) * 0.86, "the slide is scaled to the viewport");
  assert.deepEqual([view.x, view.y], [(1280 - 400 * view.scale) / 2, (800 - 800 * view.scale) / 2], "and centred");
});

test("a deck changes no policy, keeps one script and escapes what it renders", () => {
  const canvas = renderSceneDocument(slideScene);
  const deck = renderSceneDocument(slideScene, undefined, undefined, [], "deck");
  assert.equal(policyOf(deck), policyOf(canvas), "the presentation keeps the document policy");
  assert.equal(
    policyOf(deck),
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  );
  assert.equal((deck.match(/<script/gi) ?? []).length, 1, "one script tag");
  assert.equal(/<link\b|<img\b|@import|https?:/i.test(deck), false, "the deck fetches nothing");
  const script = inlineScript(deck);
  for (const forbidden of ["fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "document.cookie", "import("])
    assert.equal(script.includes(forbidden), false, `${forbidden} stays out of the slide script`);
  const hostile = "<script>alert(1)</script>";
  const escaped = "&lt;script&gt;alert(1)&lt;/script&gt;";
  const hostileHtml = renderSceneDocument(
    scene(frame({ name: hostile, nodes: [text({ text: hostile })] })),
    undefined,
    undefined,
    [],
    "deck",
  );
  assert.equal(hostileHtml.includes(hostile), false);
  assert.ok(hostileHtml.includes(`<p class="scene-frame-name">${escaped}`), "the slide caption is escaped");
  assert.ok(hostileHtml.includes(`>${escaped}</div>`), "the slide text is escaped");
  assert.equal(/<[a-z][^>]*\son[a-z]+\s*=/i.test(hostileHtml), false, "no inline event handler attribute");
});

test("a deck with no slides says so and still runs", () => {
  const html = renderSceneDocument(scene(), undefined, undefined, [], "deck");
  assert.ok(html.includes("This deck has no slides yet."), html);
  assert.equal((html.match(/class="scene-frame"/g) ?? []).length, 0);
  assert.equal(counterText(html), "", "no counter without slides");
  assert.ok(indexTag(html).includes("hidden"));
  assert.doesNotThrow(() => runDeck(html, []), "the slide script survives an empty deck");
});

test("a deck draws a slide-anchored pin and lists a thread with no node", () => {
  const pinned = renderSceneDocument(
    slideScene,
    undefined,
    undefined,
    [{ id: "thread-one", anchor: { kind: "slide-point", slideId: "home", nodeId: "card", x: 0.25, y: 0.5 } }],
    "deck",
  );
  assert.equal((pinned.match(/class="scene-pin"/g) ?? []).length, 1);
  assert.ok(
    pinned.includes(
      '<span class="scene-pin" tabindex="0" data-thread-id="thread-one" data-node-id="card" aria-label="Comment thread 1" style="left:35px;top:45px">1</span>',
    ),
    pinned,
  );
  const orphaned = renderSceneDocument(
    slideScene,
    undefined,
    undefined,
    [{ id: "thread-one", anchor: { kind: "slide-point", slideId: "home", nodeId: "gone", x: 0.25, y: 0.5 } }],
    "deck",
  );
  assert.equal((orphaned.match(/class="scene-pin"/g) ?? []).length, 0);
  assert.ok(orphaned.includes("Thread 1 points at something that no longer exists in this canvas."), orphaned);
});

const CANVAS_GOLDEN = {
  first: "15b894cb988d3744695dd30256ba04df253358624b536cb6ca4f474ee7cf61c4",
  second: "5d8c4442f274da6b1fd9ec4ac468053dc8087e72498bf35300a49a99dedea01e",
  pinned: "453cb179386b0f439ff9517ec000c2c5cc055099caa8e9a261c37b2c3ba3a242",
  empty: "85c1b79d9730331f59dfa5d3027865f0e79d1657f53edca589dd1c7cb481cbbc",
};

const canvasScene = scene(
  frame({ id: "home", name: "Home", nodes: [rect(), text()] }),
  frame({ id: "checkout", name: "Checkout", x: 400, y: 0, nodes: [] }),
);
const digestOf = (html: string): string => createHash("sha256").update(html).digest("hex");

test("PRESERVE: the canvas document is byte-identical to the document it produced before the deck", () => {
  assert.equal(digestOf(renderSceneDocument(canvasScene)), CANVAS_GOLDEN.first);
  assert.equal(digestOf(renderSceneDocument(canvasScene, "checkout")), CANVAS_GOLDEN.second);
  assert.equal(
    digestOf(
      renderSceneDocument(canvasScene, undefined, undefined, [
        { id: "t1", anchor: { kind: "board-point", boardId: "home", nodeId: "card", x: 0.25, y: 0.5 } },
      ]),
    ),
    CANVAS_GOLDEN.pinned,
  );
  assert.equal(digestOf(renderSceneDocument(scene())), CANVAS_GOLDEN.empty);
});

test("PRESERVE: naming the canvas kind changes nothing, and no deck markup leaks into it", () => {
  const named = renderSceneDocument(canvasScene, undefined, undefined, [], "canvas");
  assert.equal(named, renderSceneDocument(canvasScene), "the canvas kind is the default");
  const html = renderSceneDocument(canvasScene, undefined, undefined, [
    { id: "t1", anchor: { kind: "board-point", boardId: "home", nodeId: "card", x: 0.25, y: 0.5 } },
  ]);
  for (const deckOnly of ["scene-counter", "frame-counter", 'id="prev"', 'id="next"', 'id="strip"', "scene-slides"])
    assert.equal(html.includes(deckOnly), false, `${deckOnly} is a deck-only addition`);
  assert.ok(html.includes('id="frame-index"'), "the canvas keeps its index strip");
});
