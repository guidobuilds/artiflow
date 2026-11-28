import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { SCENE_FORMAT_VERSION, type Scene } from "@artiflow/domain/scene";

import { DOCUMENT_CSP } from "../apps/api/src/viewer/artifact.ts";
import { escapeAttribute } from "../apps/api/src/viewer/chrome/theme.ts";
import { PLAY_CHANNEL, PLAY_VERSION, canvasControllerScript } from "../apps/api/src/viewer/views/canvas-controller.ts";
import { renderSceneDocument, type SceneArtboards } from "../apps/api/src/viewer/scene.ts";

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
    {
      id: "b",
      name: "Proposal B",
      x: 1400,
      y: 0,
      w: 1280,
      h: 720,
      nodes: [],
      source: { artifactId: SOURCE_ARTIFACT, revisionId: REVISION_ONE, mode: "fluid" },
    },
    { id: "c", name: "Notes board", x: 2800, y: 0, w: 200, h: 100, nodes: [] },
  ],
});

const artboards = (): SceneArtboards => ({
  a: { kind: "ready", html: "<h1>Proposal A</h1>", revisionNumber: 3, origin: "https://artiflow.test" },
  b: { kind: "ready", html: "<h1>Proposal B</h1>", revisionNumber: 4, origin: "https://artiflow.test" },
});

const frameTag = (html: string, id: string): string => {
  const start = html.indexOf(`data-frame-id="${id}"`);
  assert.ok(start >= 0, `frame ${id} is rendered`);
  const from = html.lastIndexOf("<section", start);
  const to = html.indexOf("</section>", start);
  return html.slice(from, to);
};

const markupOf = (html: string): string =>
  html.replace(/<style>[^]*?<\/style>/i, "").replace(/<script>[^]*?<\/script>/gi, "");

const bodyTag = (html: string): string => {
  const start = html.indexOf("<body");
  assert.ok(start >= 0);
  return html.slice(start, html.indexOf(">", start) + 1);
};

const dataUrlOf = (tag: string): string | null => {
  const match = /src="data:text\/html;base64,([A-Za-z0-9+/=]+)"/.exec(tag);
  return match === null ? null : Buffer.from(match[1] as string, "base64").toString("utf8");
};

const policyOf = (html: string): string => {
  const match = /content-security-policy" content="([^"]*)"/.exec(html);
  assert.ok(match !== null, "the document carries a policy");
  return match[1] as string;
};

const CANVAS_ARTBOARD_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src data:";

test("Focus opens the requested artboard with a width control and a way back", () => {
  const html = renderSceneDocument(scene(), "a", undefined, [], "canvas", artboards(), {
    kind: "focus",
    width: 390,
  });
  assert.match(bodyTag(html), /data-scene-view="focus"/);
  const a = frameTag(html, "a");
  assert.match(a, /data-scene-active="true"/);
  assert.match(a, /style="[^"]*width:390px/);
  assert.match(a, /data-artboard-width="390" aria-pressed="true"/);
  assert.match(a, /data-artboard-width="1280" aria-pressed="false"/);
  assert.match(a, /data-scene-exit="true"/);
  assert.equal(a.includes("data-scene-enter"), false, "focus does not offer to enter itself");
  assert.equal(frameTag(html, "b").includes('data-scene-active="true"'), false, "only one artboard is shown");
  assert.equal(html.includes('id="frame-index"'), false, "focus hides the canvas index");
  assert.equal(html.includes('id="fit"'), false, "focus hides the canvas tools");
});

test("Focus at 1280 gives the artboard the desktop width", () => {
  const html = renderSceneDocument(scene(), "a", undefined, [], "canvas", artboards(), {
    kind: "focus",
    width: 1280,
  });
  const a = frameTag(html, "a");
  assert.match(a, /style="width:1280px;height:100%"/);
  assert.match(a, /data-artboard-width="1280" aria-pressed="true"/);
  assert.match(a, /style="[^"]*width:1280px/);
});

test("Focus keeps the artboard sealed while it fills the view", () => {
  const html = renderSceneDocument(scene(), "a", undefined, [], "canvas", artboards(), {
    kind: "focus",
    width: 390,
  });
  const a = frameTag(html, "a");
  assert.match(a, /sandbox="allow-scripts"/);
  assert.match(a, /referrerpolicy="no-referrer"/);
  assert.equal(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/.test(a), false);
  const page = dataUrlOf(a);
  assert.ok(page !== null, "the artboard is still an inline sealed document");
  assert.ok(page.includes(escapeAttribute(DOCUMENT_CSP)), "the sealed document keeps its own policy");
  assert.ok(page.includes(escapeAttribute("connect-src 'self'")), "the sealed page cannot reach another origin");
  assert.equal(page.includes("connect-src *"), false);
  assert.equal(page.includes("frame-src"), false, "the sealed page cannot frame anything");
});

test("Play starts at the artboard of the link and shows no editing chrome", () => {
  const html = renderSceneDocument(scene(), "a", undefined, [], "canvas", artboards(), {
    kind: "play",
    width: 390,
  });
  assert.match(bodyTag(html), /data-scene-view="play"/);
  const a = frameTag(html, "a");
  assert.match(a, /data-scene-active="true"/);
  assert.match(a, /data-artboard="true"/);
  assert.equal(a.includes("scene-artboard-bar"), false, "Play offers no artboard tools");
  assert.equal(a.includes("data-artboard-width"), false, "Play offers no width switch");
  assert.equal(a.includes("scene-frame-name"), false, "Play hides the frame label");
  assert.equal(markupOf(html).includes("scene-tools"), false, "Play hides the canvas tools");
  assert.equal(markupOf(html).includes("scene-index"), false, "Play hides the canvas index");
  assert.equal(markupOf(html).includes("scene-pin"), false, "Play hides comment pins");
  assert.match(html, /data-scene-exit="true"/);
  assert.match(a, /sandbox="allow-scripts"/);
});

test("Play keeps every screen rendered so a connection can reach another one", () => {
  const html = renderSceneDocument(scene(), "a", undefined, [], "canvas", artboards(), {
    kind: "play",
    width: 390,
  });
  const b = frameTag(html, "b");
  assert.match(b, /data-frame-id="b"/);
  assert.match(b, /data-artboard="true"/);
  assert.equal(b.includes('data-scene-active="true"'), false);
  assert.ok(dataUrlOf(b) !== null, "the destination artboard is ready before the connection is used");
});

test("a document without Play mode keeps its exact render and policy", () => {
  const canvas = renderSceneDocument(scene(), "a", undefined, [], "canvas", artboards());
  assert.equal(bodyTag(canvas).includes("data-scene-view"), false, "the canvas is the default view");
  assert.match(canvas, /id="fit"/);
  assert.match(canvas, /id="frame-index"/);
  assert.match(canvas, /data-scene-enter="focus"/);
  assert.match(canvas, /data-scene-enter="play"/);
  assert.equal(policyOf(canvas), CANVAS_ARTBOARD_POLICY);
  for (const view of [
    { kind: "focus", width: 390 } as const,
    { kind: "focus", width: 1280 } as const,
    { kind: "play", width: 390 } as const,
  ])
    assert.equal(
      policyOf(renderSceneDocument(scene(), "a", undefined, [], "canvas", artboards(), view)),
      CANVAS_ARTBOARD_POLICY,
      `${view.kind} keeps the canvas policy`,
    );
});

test("a scene without artboards keeps the policy it had before Play existed", () => {
  const plain: Scene = {
    formatVersion: SCENE_FORMAT_VERSION,
    frames: [{ id: "p", name: "Plain", x: 0, y: 0, w: 100, h: 80, nodes: [] }],
  };
  const html = renderSceneDocument(plain);
  assert.equal(html.includes("frame-src"), false);
  assert.equal(bodyTag(html).includes("data-scene-view"), false);
});

const SELECTOR_TOKEN = /([a-z][a-z0-9-]*)|\.([a-zA-Z0-9_-]+)|\[([a-zA-Z0-9-]+)(?:="([^"]*)")?\]/g;

type Listener = (event: Record<string, unknown>) => void;
type Posted = { data: unknown; target: string };

const matchesSelector = (node: FakeElement, selector: string): boolean => {
  const tokens = [...selector.matchAll(SELECTOR_TOKEN)];
  if (tokens.length === 0) return false;
  for (const token of tokens) {
    if (token[1] !== undefined) {
      if (token[1].toLowerCase() !== node.tag.toLowerCase()) return false;
    } else if (token[2] !== undefined) {
      if (!node.classes.has(token[2])) return false;
    } else {
      const actual = node.getAttribute(token[3] as string);
      if (actual === null) return false;
      if (token[4] !== undefined && actual !== token[4]) return false;
    }
  }
  return true;
};

const closestOf = (start: FakeElement | null, selector: string): FakeElement | null => {
  let node = start;
  while (node !== null) {
    if (matchesSelector(node, selector)) return node;
    node = node.parent;
  }
  return null;
};

class FakeElement {
  readonly tag: string;
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: Posted[] = [];
  parent: FakeElement | null = null;
  contentWindow: FakeElement | null = null;
  clientWidth = 1200;
  clientHeight = 800;
  hidden = false;
  readonly name: string;

  constructor(tag: string, name = tag, classes: readonly string[] = []) {
    this.tag = tag;
    this.name = name;
    for (const cls of classes) this.classes.add(cls);
  }

  getAttribute(attribute: string): string | null {
    return this.attributes.get(attribute) ?? null;
  }

  setAttribute(attribute: string, value: string): void {
    this.attributes.set(attribute, String(value));
  }

  removeAttribute(attribute: string): void {
    this.attributes.delete(attribute);
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  postMessage(data: unknown): void {
    this.sent.push({ data, target: this.name });
  }

  descendants(): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) found.push(child, ...child.descendants());
    return found;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((node) => matchesSelector(node, selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): FakeElement | null {
    return closestOf(this, selector);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: Record<string, unknown> = {}): void {
    const payload = {
      preventDefault: () => {},
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...event,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }

  setPointerCapture(): void {}

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
}

type FrameSpec = { id: string; x: number; y: number; w: number; h: number; artboardWidth?: number };

const frameA: FrameSpec = { id: "a", x: 0, y: 0, w: 390, h: 640, artboardWidth: 390 };
const frameB: FrameSpec = { id: "b", x: 1400, y: 0, w: 1280, h: 720, artboardWidth: 1280 };
const frameC: FrameSpec = { id: "c", x: 2800, y: 0, w: 200, h: 100 };

const buildScene = (input: { frames: readonly FrameSpec[]; mode?: "canvas" | "focus" | "play"; active?: string }) => {
  const documentEvents = new FakeElement("document");
  const stage = new FakeElement("div", "stage", ["scene-stage"]);
  const surface = new FakeElement("div", "surface", ["scene-surface"]);
  const windowElement = new FakeElement("window", "window");
  const body = new FakeElement("body");
  const index = new FakeElement("nav", "index");
  index.hidden = input.mode !== undefined;
  stage.append(surface);

  const sections = new Map<string, FakeElement>();
  const tabs = new Map<string, FakeElement>();
  const contents = new Map<string, FakeElement>();
  for (const spec of input.frames) {
    const section = new FakeElement("section", spec.id, ["scene-frame"]);
    section.setAttribute("data-frame-id", spec.id);
    section.setAttribute("data-frame-w", String(spec.w));
    section.setAttribute("data-frame-h", String(spec.h));
    section.setAttribute("data-frame-x", String(spec.x));
    section.setAttribute("data-frame-y", String(spec.y));
    if (input.mode !== undefined && input.active === spec.id) section.setAttribute("data-scene-active", "true");
    if (input.mode !== undefined && input.active === spec.id) section.style.width = `${spec.artboardWidth ?? spec.w}px`;
    const host = new FakeElement("div", `${spec.id}-host`, ["scene-frame-body"]);
    host.style.width = `${spec.artboardWidth ?? spec.w}px`;
    section.append(host);
    if (spec.artboardWidth !== undefined) {
      section.setAttribute("data-artboard", "true");
      const artboard = new FakeElement("div", `${spec.id}-artboard`, ["scene-artboard"]);
      artboard.style.width = `${spec.artboardWidth}px`;
      const inner = new FakeElement("iframe", `${spec.id}-iframe`, ["scene-artboard-frame"]);
      inner.style.width = `${spec.artboardWidth}px`;
      inner.contentWindow = new FakeElement("window", `${spec.id}-content`);
      contents.set(spec.id, inner.contentWindow);
      artboard.append(inner);
      host.append(artboard);
      {
        const bar = new FakeElement("span", `${spec.id}-bar`, ["scene-artboard-bar"]);
        for (const width of [390, 1280]) {
          const button = new FakeElement("button", `${spec.id}-width-${width}`, ["scene-artboard-width"]);
          button.setAttribute("data-artboard-width", String(width));
          button.setAttribute("aria-pressed", width === spec.artboardWidth ? "true" : "false");
          bar.append(button);
        }
        const focus = new FakeElement("button", `${spec.id}-focus`, ["scene-artboard-enter"]);
        focus.setAttribute("data-scene-enter", "focus");
        focus.setAttribute("data-scene-target", spec.id);
        const play = new FakeElement("button", `${spec.id}-play`, ["scene-artboard-enter"]);
        play.setAttribute("data-scene-enter", "play");
        play.setAttribute("data-scene-target", spec.id);
        const back = new FakeElement("button", `${spec.id}-back`, ["scene-artboard-back"]);
        back.setAttribute("data-scene-exit", "true");
        bar.append(focus, play, back);
        artboard.append(bar);
      }
    }
    surface.append(section);
    sections.set(spec.id, section);
    const tab = new FakeElement("button", `${spec.id}-tab`);
    tab.setAttribute("data-target", spec.id);
    tabs.set(spec.id, tab);
  }
  index.append(...tabs.values());
  surface.setAttribute("data-surface-w", "3000");
  surface.setAttribute("data-surface-h", "720");
  if (input.active !== undefined) surface.setAttribute("data-active-frame", input.active);
  if (input.mode !== undefined) body.setAttribute("data-scene-view", input.mode);

  const documentElement = {
    body,
    getElementById: (id: string) => {
      if (id === "stage") return stage;
      if (id === "surface") return surface;
      if (id === "frame-index") return input.mode === undefined || input.mode === "canvas" ? index : null;
      return null;
    },
    querySelectorAll: (selector: string) =>
      [...sections.values(), ...[...sections.values()].flatMap((section) => section.descendants())].filter((node) =>
        matchesSelector(node, selector),
      ),
    addEventListener: (type: string, listener: Listener) => documentEvents.addEventListener(type, listener),
  };
  const location = { hash: "" };
  const context = {
    document: documentElement,
    window: windowElement,
    location,
    history: {
      replaceState: (_state: unknown, _title: unknown, next: string) => {
        location.hash = next;
      },
    },
  };
  vm.createContext(context);
  new vm.Script(canvasControllerScript(), { filename: "canvas-controller.js" }).runInContext(context);

  const section = (id: string): FakeElement => {
    const found = sections.get(id);
    assert.ok(found !== undefined, `frame ${id} exists`);
    return found;
  };
  const transform = (): { x: number; y: number; scale: number } => {
    const found = /translate\((-?[0-9.]+)px,(-?[0-9.]+)px\) scale\((-?[0-9.]+)\)/.exec(String(surface.style.transform));
    assert.ok(found !== null, `the surface carries a transform, got ${String(surface.style.transform)}`);
    return { x: Number(found[1]), y: Number(found[2]), scale: Number(found[3]) };
  };
  const contentOf = (id: string): FakeElement => {
    const inner = section(id).querySelector(".scene-artboard-frame");
    assert.ok(inner !== null && inner.contentWindow !== null, `frame ${id} has an artboard window`);
    return inner.contentWindow;
  };
  return {
    body,
    stage,
    surface,
    transform,
    section,
    shows: (id: string) => section(id).getAttribute("data-scene-active") === "true",
    contentOf,
    tab: (id: string) => tabs.get(id) as FakeElement,
    inner: (id: string) => section(id).querySelector(".scene-artboard-frame") as FakeElement,
    host: (id: string) => section(id).querySelector(".scene-frame-body") as FakeElement,
    click: (node: FakeElement) => documentEvents.emit("click", { target: node }),
    message: (data: unknown, source: unknown) => windowElement.emit("message", { data, source }),
    delivered: () => [...contents.values()].flatMap((entry) => entry.sent),
  };
};

const navigate = (frame: unknown, state?: unknown): Record<string, unknown> => ({
  channel: PLAY_CHANNEL,
  version: PLAY_VERSION,
  kind: "navigate",
  frame,
  ...(state === undefined ? {} : { state }),
});

test("Focus entered from the canvas returns to the same place and the same selection", () => {
  const run = buildScene({ frames: [frameA, frameB, frameC] });
  const before = run.transform();
  run.click(run.section("a").querySelector('[data-scene-enter="focus"]') as FakeElement);
  assert.equal(run.body.getAttribute("data-scene-view"), "focus");
  assert.equal(run.shows("a"), true);
  assert.equal(run.shows("b"), false);
  assert.equal(run.section("a").style.width, "390px", "the focused artboard fills the view at its width");
  assert.notDeepEqual(run.transform(), before, "the focused artboard is brought to the middle of the view");

  run.click(run.section("a").querySelector("[data-scene-exit]") as FakeElement);
  assert.equal(run.body.getAttribute("data-scene-view"), "canvas");
  assert.deepEqual(run.transform(), before, "the canvas comes back exactly where it was");
  assert.equal(run.shows("a"), false);
  assert.equal(run.section("a").style.width, "", "the artboard box returns to its canvas width");
  assert.equal(run.tab("a").getAttribute("aria-current"), "true", "the selection is kept");
});

test("the width control in Focus reflows the artboard and its box", () => {
  const run = buildScene({ frames: [frameA, frameB], mode: "focus", active: "a" });
  run.click(run.section("a").querySelector('[data-artboard-width="1280"]') as FakeElement);
  assert.equal(run.inner("a").style.width, "1280px");
  assert.equal(run.section("a").style.width, "1280px");
  assert.equal(run.host("a").style.width, "1280px");
  run.click(run.section("a").querySelector('[data-artboard-width="390"]') as FakeElement);
  assert.equal(run.inner("a").style.width, "390px");
  assert.equal(run.section("a").style.width, "390px");
});

test("the canvas leaves the artboard width to the artboard controller", () => {
  const run = buildScene({ frames: [frameA], mode: "canvas" });
  const before = run.transform();
  run.click(run.section("a").querySelector('[data-artboard-width="1280"]') as FakeElement);
  assert.equal(run.inner("a").style.width, "390px", "the canvas controller does not reflow the box");
  assert.equal(run.section("a").style.width, undefined);
  assert.deepEqual(run.transform(), before);
});

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test("Play follows a connection to another screen and carries the decision", () => {
  const run = buildScene({ frames: [frameA, frameB, frameC], mode: "play", active: "a" });
  const target = run.contentOf("b");
  run.message(navigate("b", { plan: "pro" }), run.contentOf("a"));
  assert.equal(run.shows("b"), true);
  assert.equal(run.shows("a"), false);
  assert.equal(run.section("b").style.width, "1280px");
  assert.deepEqual(plain(target.sent.map((entry) => entry.data)), [
    { channel: PLAY_CHANNEL, version: PLAY_VERSION, kind: "enter", frame: "b", state: { plan: "pro" } },
  ]);
});

test("Play follows a connection without state", () => {
  const run = buildScene({ frames: [frameA, frameB], mode: "play", active: "a" });
  run.message(navigate("b"), run.contentOf("a"));
  assert.equal(run.shows("b"), true);
  assert.deepEqual(plain(run.contentOf("b").sent.map((entry) => entry.data)), [
    { channel: PLAY_CHANNEL, version: PLAY_VERSION, kind: "enter", frame: "b", state: null },
  ]);
});

test("Play rejects a message that does not come from the screen being played", () => {
  const reject = (label: string, data: unknown, source: (run: ReturnType<typeof buildScene>) => unknown) => {
    const run = buildScene({ frames: [frameA, frameB, frameC], mode: "play", active: "a" });
    const before = run.transform();
    run.message(data, source(run));
    assert.equal(run.shows("a"), true, `${label}: the played screen stays`);
    assert.equal(run.shows("b"), false, `${label}: nothing is switched`);
    assert.deepEqual(run.transform(), before, `${label}: the view does not move`);
    assert.deepEqual(plain(run.delivered()), [], `${label}: nothing is delivered`);
  };
  reject("a message from a screen that is not being played", navigate("b"), (run) => run.contentOf("b"));
  reject("a destination the Design does not hold", navigate("zzz"), (run) => run.contentOf("a"));
  reject("a destination that is not an artboard", navigate("c"), (run) => run.contentOf("a"));
  reject("the screen being played", navigate("a"), (run) => run.contentOf("a"));
  reject("another Design's frame id", navigate("a-other"), (run) => run.contentOf("a"));
  reject("the wrong channel", { ...navigate("b"), channel: "artiflow-comments" }, (run) => run.contentOf("a"));
  reject("the wrong version", { ...navigate("b"), version: 2 }, (run) => run.contentOf("a"));
  reject("the wrong kind", { ...navigate("b"), kind: "location" }, (run) => run.contentOf("a"));
  reject("a frame that is not a string", navigate(42), (run) => run.contentOf("a"));
  reject("a frame that is missing", { channel: PLAY_CHANNEL, version: PLAY_VERSION, kind: "navigate" }, (run) =>
    run.contentOf("a"),
  );
  reject("state that is not an object", navigate("b", ["pro"]), (run) => run.contentOf("a"));
  reject("state that is too large", navigate("b", { plan: "x".repeat(4096) }), (run) => run.contentOf("a"));
  reject("data that is not an object", "navigate:b", (run) => run.contentOf("a"));
  reject("no data at all", null, (run) => run.contentOf("a"));
});

test("a canvas document ignores the navigation contract", () => {
  const run = buildScene({ frames: [frameA, frameB], mode: "canvas" });
  const before = run.transform();
  run.message(navigate("b"), run.contentOf("a"));
  assert.equal(run.shows("a"), false);
  assert.equal(run.shows("b"), false);
  assert.deepEqual(run.transform(), before);
  assert.deepEqual(plain(run.delivered()), []);
});

test("Play exits to the overview where the person left the canvas", () => {
  const run = buildScene({ frames: [frameA, frameB], mode: "canvas" });
  const before = run.transform();
  run.click(run.section("a").querySelector('[data-scene-enter="play"]') as FakeElement);
  assert.equal(run.body.getAttribute("data-scene-view"), "play");
  run.message(navigate("b"), run.contentOf("a"));
  assert.equal(run.shows("b"), true);
  run.click(run.section("b").querySelector("[data-scene-exit]") as FakeElement);
  assert.equal(run.body.getAttribute("data-scene-view"), "canvas");
  assert.deepEqual(run.transform(), before, "the canvas comes back exactly where it was");
  assert.equal(run.tab("b").getAttribute("aria-current"), "true", "the screen that was played stays selected");
  assert.equal(run.shows("b"), false);
});
