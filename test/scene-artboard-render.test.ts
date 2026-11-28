import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { SCENE_FORMAT_VERSION, type Scene } from "@artiflow/domain/scene";

import { artboardControllerScript } from "../apps/api/src/viewer/views/artboard-controller.ts";
import { renderSceneDocument, type SceneArtboards } from "../apps/api/src/viewer/scene.ts";

const SOURCE_ARTIFACT = "0d5b0f6a-3f2b-4b4a-9a44-6a2f4a1f7c11";
const REVISION_ONE = "8f0d9c2e-51a4-4cbb-9a0e-2f3c4d5e6f70";

const scene = (overrides: Partial<Scene> = {}): Scene => ({
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: "a",
      name: "Proposal A",
      x: 0,
      y: 0,
      w: 1280,
      h: 640,
      nodes: [],
      source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_ONE, mode: "fluid" },
    },
    {
      id: "b",
      name: "Proposal B",
      x: 1320,
      y: 0,
      w: 640,
      h: 640,
      nodes: [],
      source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_ONE, mode: "fixed" },
    },
  ],
  ...overrides,
});

const artboards = (overrides: Partial<SceneArtboards> = {}): SceneArtboards => ({
  a: { kind: "ready", html: "<h1>Proposal A v3</h1>", revisionNumber: 3, origin: "https://artiflow.test" },
  b: { kind: "ready", html: "<h1>Proposal B v2</h1>", revisionNumber: 2, origin: "https://artiflow.test" },
  ...overrides,
});

const frameTag = (html: string, id: string): string => {
  const start = html.indexOf(`data-frame-id="${id}"`);
  assert.ok(start >= 0, `frame ${id} is rendered`);
  const from = html.lastIndexOf("<section", start);
  const to = html.indexOf("</section>", start);
  return html.slice(from, to);
};

const dataUrlOf = (tag: string): string | null => {
  const match = /src="data:text\/html;base64,([A-Za-z0-9+/=]+)"/.exec(tag);
  return match === null ? null : Buffer.from(match[1] as string, "base64").toString("utf8");
};

test("an artboard renders its pinned revision as a sandboxed page, not as nodes", () => {
  const html = renderSceneDocument(scene(), undefined, undefined, [], "canvas", artboards());
  const a = frameTag(html, "a");
  assert.match(a, /class="scene-artboard-frame"/);
  assert.match(a, /sandbox="allow-scripts"/);
  assert.match(a, /referrerpolicy="no-referrer"/);
  assert.match(a, /title="Proposal A"/);
  const page = dataUrlOf(a);
  assert.ok(page !== null, "the artboard carries an inline document");
  assert.match(page, /^<base href="https:\/\/artiflow\.test\/artifact\/0d5b0f6a-3f2b-4b4a-9a44-6a2f4a1f7c11\/">/);
  assert.match(page, /<h1>Proposal A v3<\/h1>/);
  assert.match(a, /Proposal A v3|v3/, "the pinned revision is named");
});

test("a fixed artboard keeps its authored width and offers no viewport switch", () => {
  const html = renderSceneDocument(scene(), undefined, undefined, [], "canvas", artboards());
  const b = frameTag(html, "b");
  assert.match(b, /style="width:640px;height:100%"/);
  assert.equal(b.includes("data-artboard-width"), false);
  assert.match(b, /Fixed/);
});

test("a fluid artboard offers 390 and 1280 and lays the page out at that width", () => {
  const html = renderSceneDocument(scene(), undefined, undefined, [], "canvas", artboards());
  const a = frameTag(html, "a");
  assert.match(a, /data-artboard-width="390"/);
  assert.match(a, /data-artboard-width="1280"/);
  assert.match(a, /data-artboard-width="1280" aria-pressed="true"/);
  assert.match(a, /data-artboard-width="390" aria-pressed="false"/);
  assert.match(a, /style="width:1280px;height:100%"/);
  assert.equal(/transform:scale/.test(a), false);
});

test("the scene document allows the inline artboard frames it emits", () => {
  const html = renderSceneDocument(scene(), undefined, undefined, [], "canvas", artboards());
  assert.match(html, /content-security-policy" content="[^"]*frame-src data:/);
});

test("an artboard without access shows a clear state and leaks nothing", () => {
  const html = renderSceneDocument(scene(), undefined, undefined, [], "canvas", {
    a: { kind: "unavailable", reason: "forbidden" },
    b: { kind: "unavailable", reason: "missing" },
  });
  const a = frameTag(html, "a");
  assert.match(a, /scene-artboard-unavailable/);
  assert.match(a, /not available/i);
  assert.equal(a.includes("data:text/html"), false);
  assert.equal(a.includes("Proposal A v3"), false);
  assert.equal(a.includes("scene-artboard-frame"), false);
  const b = frameTag(html, "b");
  assert.match(b, /deleted|no longer available/i);
});

test("an artboard that is too large to inline says so instead of failing the scene", () => {
  const html = renderSceneDocument(scene(), undefined, undefined, [], "canvas", {
    a: { kind: "unavailable", reason: "too_large" },
    b: { kind: "ready", html: "<p>b</p>", revisionNumber: 1, origin: null },
  });
  assert.match(frameTag(html, "a"), /too large/i);
  const b = dataUrlOf(frameTag(html, "b"));
  assert.equal(b?.startsWith("<base"), false, "no base is injected without an origin");
});

test("an artboard without a resolved source is reported as unavailable, never blank", () => {
  const html = renderSceneDocument(scene(), undefined, undefined, [], "canvas", {});
  assert.match(frameTag(html, "a"), /not available/i);
  assert.equal(html.includes("data:text/html"), false);
});

test("a scene without artboards renders exactly as before", () => {
  const plain: Scene = {
    formatVersion: SCENE_FORMAT_VERSION,
    frames: [{ id: "p", name: "Plain", x: 0, y: 0, w: 100, h: 80, nodes: [] }],
  };
  const html = renderSceneDocument(plain);
  const p = frameTag(html, "p");
  assert.equal(p.includes("scene-artboard"), false);
  assert.equal(p.includes("scene-artboard-frame"), false);
  assert.match(p, /scene-frame-body/);
});

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
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

  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.children.filter((child) => selectorOfElement(child).includes(selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.children.find((child) => selectorOfElement(child).includes(selector)) ?? null;
  }

  closest(selector: string): FakeElement | null {
    if (selectorOfElement(this).includes(selector)) return this;
    return this.parent === null ? null : this.parent.closest(selector);
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  setPointerCapture(): void {}

  emit(type: string, event: Record<string, unknown> = {}): void {
    const payload = { preventDefault: () => {}, altKey: false, ctrlKey: false, metaKey: false, ...event };
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }
}

const selectorOfElement = (element: FakeElement): string[] => {
  const names: string[] = [];
  if (element.getAttribute("data-frame-id") !== null) names.push("[data-frame-id]");
  const width = element.getAttribute("data-artboard-width");
  if (width !== null) names.push(".scene-artboard-width", `button[data-artboard-width="${width}"]`);
  if (element.classes.has("scene-artboard-frame")) names.push(".scene-artboard-frame");
  return names;
};

test("the canvas controller reflows a fluid artboard by width, without scaling it", () => {
  const host = new FakeElement("document");
  const stage = new FakeElement("div");
  const frame = new FakeElement("section");
  frame.setAttribute("data-frame-id", "a");
  frame.setAttribute("data-frame-w", "1280");
  frame.setAttribute("data-frame-h", "640");
  const iframe = new FakeElement("iframe");
  iframe.classes.add("scene-artboard-frame");
  iframe.style.width = "1280px";
  const narrow = new FakeElement("button");
  narrow.classes.add("scene-artboard-width");
  narrow.setAttribute("data-artboard-width", "390");
  narrow.setAttribute("aria-pressed", "false");
  const wide = new FakeElement("button");
  wide.classes.add("scene-artboard-width");
  wide.setAttribute("data-artboard-width", "1280");
  wide.setAttribute("aria-pressed", "true");
  frame.children.push(iframe, narrow, wide);
  for (const child of frame.children) child.parent = frame;
  const context = {
    document: {
      getElementById: (id: string) => (id === "stage" ? stage : null),
      querySelectorAll: (selector: string) => (selector === "[data-frame-id]" ? [frame] : []),
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        host.addEventListener(type, listener),
    },
    location: { hash: "" },
    history: { replaceState: () => {} },
    window: new FakeElement("window"),
  };
  vm.createContext(context);
  new vm.Script(artboardControllerScript(), { filename: "artboard-controller.js" }).runInContext(context);

  host.emit("click", { target: { closest: (selector: string) => (selector === ".scene-artboard-width" ? narrow : null) } });
  assert.equal(iframe.style.width, "390px");
  assert.equal(narrow.getAttribute("aria-pressed"), "true");
  assert.equal(wide.getAttribute("aria-pressed"), "false");
  assert.equal(frame.style.transform, undefined, "the frame is not scaled to fake a narrower page");

  host.emit("click", { target: { closest: (selector: string) => (selector === ".scene-artboard-width" ? wide : null) } });
  assert.equal(iframe.style.width, "1280px");
  assert.equal(narrow.getAttribute("aria-pressed"), "false");
  assert.equal(wide.getAttribute("aria-pressed"), "true");
});
