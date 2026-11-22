import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import {
  SCENE_FORMAT_VERSION,
  type ImageNode,
  type PathNode,
  type RectNode,
  type Scene,
  type SceneFrame,
  type TextNode,
} from "@artiflow/domain/scene";

import { renderSceneDocument } from "../apps/api/src/viewer/scene.ts";

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

  querySelectorAll(): FakeElement[] {
    return this.children;
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
    const found = /translate\((-?[\d.]+)px, ?(-?[\d.]+)px\) scale\((-?[\d.]+)\)/.exec(this.style.transform ?? "");
    assert.ok(found !== null, `the frame carries a transform, got ${String(this.style.transform)}`);
    return { x: Number(found[1]), y: Number(found[2]), scale: Number(found[3]) };
  }
}

const runScript = (html: string, ids: readonly string[], hash = "", visible = ids[0]) => {
  const host = new FakeElement("document");
  const stage = new FakeElement("div");
  const index = new FakeElement("nav");
  const fit = new FakeElement("button");
  const window = new FakeElement("window");
  const frames = new Map<string, FakeElement>();
  const tabs = new Map<string, FakeElement>();
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
    ["fit", fit],
  ]);
  const location = { hash };
  const context = {
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: () => [...frames.values()],
      addEventListener: (type: string, listener: Listener) => host.addEventListener(type, listener),
    },
    location,
    history: { replaceState: () => {} },
    window,
  };
  vm.createContext(context);
  new vm.Script(inlineScript(html), { filename: "scene-viewer.js" }).runInContext(context);
  return { host, stage, index, fit, frames, tabs, window, location };
};

test("two frames render two index entries in order, the first visible and the rest hidden", () => {
  const html = renderSceneDocument(twoFrames);
  const index = indexMarkup(html);
  assert.equal((html.match(/data-target="/g) ?? []).length, 2);
  assert.ok(index.includes(">Home</button>"), index);
  assert.ok(index.includes(">Checkout</button>"), index);
  assert.ok(index.indexOf("Home") < index.indexOf("Checkout"), "the index keeps the scene order");
  assert.equal(frameTag(html, "home").includes("hidden"), false);
  assert.ok(frameTag(html, "checkout").includes("hidden"));
  assert.ok(html.includes('aria-label="Frames"'));
});

test("the second frame opens from the URL fragment and the hash keeps following navigation", () => {
  const html = renderSceneDocument(twoFrames);
  const linked = runScript(html, ["home", "checkout"], "#frame-checkout");
  assert.equal(linked.frames.get("home")?.hidden, true);
  assert.equal(linked.frames.get("checkout")?.hidden, false);
  assert.equal(linked.tabs.get("checkout")?.getAttribute("aria-current"), "true");
  assert.equal(linked.tabs.get("home")?.getAttribute("aria-current"), null);

  const follow = runScript(html, ["home", "checkout"]);
  assert.equal(follow.frames.get("home")?.hidden, false);
  follow.location.hash = "#frame-checkout";
  follow.window.emit("hashchange");
  assert.equal(follow.frames.get("checkout")?.hidden, false);
  assert.equal(follow.frames.get("home")?.hidden, true);
});

test("left and right, page up and down, home and end move between frames", () => {
  const nav = runScript(
    renderSceneDocument(scene(frame(), frame({ id: "b", name: "B" }), frame({ id: "c", name: "C" }))),
    ["home", "b", "c"],
  );
  const current = () => [...nav.frames.entries()].filter(([, element]) => !element.hidden).map(([id]) => id);
  nav.host.emit("keydown", { key: "ArrowRight" });
  assert.deepEqual(current(), ["b"]);
  nav.host.emit("keydown", { key: "PageDown" });
  assert.deepEqual(current(), ["c"]);
  nav.host.emit("keydown", { key: "ArrowLeft" });
  assert.deepEqual(current(), ["b"]);
  nav.host.emit("keydown", { key: "PageUp" });
  assert.deepEqual(current(), ["home"]);
  nav.host.emit("keydown", { key: "End" });
  assert.deepEqual(current(), ["c"]);
  nav.host.emit("keydown", { key: "Home" });
  assert.deepEqual(current(), ["home"]);
});

test("clicking an index entry shows that frame", () => {
  const click = runScript(renderSceneDocument(twoFrames), ["home", "checkout"]);
  const target = click.tabs.get("checkout");
  assert.ok(target !== undefined);
  click.index.emit("click", { target: { closest: () => target } });
  assert.equal(click.frames.get("checkout")?.hidden, false);
  assert.equal(click.frames.get("home")?.hidden, true);
});

test("the wheel zooms around the pointer", () => {
  const zoom = runScript(renderSceneDocument(scene(frame())), ["home"]);
  const home = zoom.frames.get("home");
  assert.ok(home !== undefined);
  const before = home.view();
  zoom.stage.emit("wheel", { deltaY: -240, deltaX: 0, clientX: 640, clientY: 400 });
  const after = home.view();
  assert.ok(after.scale > before.scale, `${after.scale} > ${before.scale}`);
  const anchor = (view: { x: number; y: number; scale: number }) => (640 - view.x) / view.scale;
  assert.ok(Math.abs(anchor(before) - anchor(after)) < 1e-6, "the point under the pointer stays put");
});

test("space-drag and middle-drag pan, and fit restores the frame", () => {
  const pan = runScript(renderSceneDocument(scene(frame())), ["home"]);
  const home = pan.frames.get("home");
  assert.ok(home !== undefined);
  const fitted = home.view();

  pan.host.emit("keydown", { key: " " });
  pan.stage.emit("pointerdown", { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  pan.stage.emit("pointermove", { clientX: 160, clientY: 140 });
  pan.stage.emit("pointerup", {});
  const dragged = home.view();
  assert.ok(Math.abs(dragged.x - (fitted.x + 60)) < 1e-6);
  assert.ok(Math.abs(dragged.y - (fitted.y + 40)) < 1e-6);
  assert.equal(dragged.scale, fitted.scale);

  pan.host.emit("keyup", { key: " " });
  pan.stage.emit("pointerdown", { button: 0, clientX: 0, clientY: 0 });
  pan.stage.emit("pointermove", { clientX: -20, clientY: 0 });
  assert.equal(home.view().x, dragged.x, "a plain drag without space does not pan");

  pan.stage.emit("pointerdown", { button: 1, clientX: 0, clientY: 0 });
  pan.stage.emit("pointermove", { clientX: 10, clientY: 0 });
  pan.stage.emit("pointerup", {});
  assert.equal(home.view().x, dragged.x + 10, "the middle button pans");

  pan.fit.emit("click");
  assert.deepEqual(home.view(), fitted);
});

test("zoom and pan are per frame and reset when the frame changes", () => {
  const travel = runScript(renderSceneDocument(twoFrames), ["home", "checkout"]);
  const home = travel.frames.get("home");
  const checkout = travel.frames.get("checkout");
  assert.ok(home !== undefined && checkout !== undefined);
  const fitted = home.view();
  travel.stage.emit("wheel", { deltaY: -300, clientX: 200, clientY: 200 });
  assert.notEqual(home.view().scale, fitted.scale);
  travel.host.emit("keydown", { key: "ArrowRight" });
  assert.deepEqual(checkout.view(), fitted, "the next frame starts fitted, not at the previous zoom");
  travel.host.emit("keydown", { key: "ArrowLeft" });
  assert.deepEqual(home.view(), fitted, "coming back resets the zoom and the pan");
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

test("the frame named in the URL query opens first and the index marks it", () => {
  const html = renderSceneDocument(twoFrames, "checkout");
  assert.ok(frameTag(html, "home").includes("hidden"), "the first frame is not the visible one");
  assert.equal(frameTag(html, "checkout").includes("hidden"), false);
  const index = indexMarkup(html);
  assert.ok(index.includes('data-target="checkout" aria-current="true"'), index);
  assert.equal(index.includes('data-target="home" aria-current="true"'), false);
  const opened = runScript(html, ["home", "checkout"], "", "checkout");
  assert.equal(opened.frames.get("checkout")?.hidden, false, "the client honours the frame the server marked visible");
  assert.equal(opened.frames.get("home")?.hidden, true);
});

test("an unknown or empty frame id falls back to the first frame instead of failing the page", () => {
  for (const frameId of ["missing", "", undefined]) {
    const html = renderSceneDocument(twoFrames, frameId);
    assert.equal(frameTag(html, "home").includes("hidden"), false, `${String(frameId)} opens the first frame`);
    assert.ok(frameTag(html, "checkout").includes("hidden"));
    assert.equal(html.includes('id="frame-missing"'), false, "the unknown id renders nothing of its own");
    assert.equal((html.match(/data-target="/g) ?? []).length, 2, "both frames stay reachable");
    assert.doesNotThrow(() => runScript(html, ["home", "checkout"]), "the page still runs");
  }
});

test("an empty scene renders a clear empty state", () => {
  const html = renderSceneDocument(scene());
  assert.ok(html.includes('class="scene-empty"'), html);
  assert.ok(html.includes("no frames"), html);
  assert.equal((html.match(/class="scene-frame"/g) ?? []).length, 0);
  assert.equal((html.match(/data-target="/g) ?? []).length, 0);
  assert.doesNotThrow(() => runScript(html, []), "the script survives an empty scene");
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
