import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { BRIDGE_CHANNEL, BRIDGE_VERSION, MAX_SELECTION_SELECTOR } from "@artiflow/domain/html-bridge";

import { designRequestControllerScript } from "../apps/api/src/viewer/design-request-controller.ts";

const bridgeNonce = "design-nonce:frame-a";
const designNonce = "design-nonce";

type Node = {
  children: Node[];
  textContent: string;
  className: string;
  value: string;
  rows: number;
  maxLength: number;
  disabled: boolean;
  type: string;
  style: Record<string, unknown>;
  listeners: Record<string, (() => void)[]>;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  addEventListener: (name: string, run: () => void) => void;
  append: (...items: Node[]) => void;
  focus: () => void;
  querySelector: () => Node | null;
  scrollIntoView: () => void;
};

function node(overrides: Partial<Node> = {}): Node {
  const attributes: Record<string, string> = {};
  const base: Node = {
    children: [],
    textContent: "",
    className: "",
    value: "",
    rows: 0,
    maxLength: 0,
    disabled: false,
    type: "",
    style: {},
    listeners: {},
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
    getAttribute: (name) => attributes[name] ?? null,
    addEventListener: (name, run) => {
      base.listeners[name] = [...(base.listeners[name] ?? []), run];
    },
    append: (...items) => {
      base.children.push(...items);
    },
    focus: () => {},
    querySelector: () => null,
    scrollIntoView: () => {},
  };
  return Object.assign(base, overrides);
}

type Harness = {
  messages: Record<string, unknown>[];
  panel: Node;
  clickStart: () => void;
  selectFromArtboard: (data?: Record<string, unknown>) => void;
  setSceneView: (view: string) => void;
  submitToParent: () => Record<string, unknown>[];
};

function harness(sceneView: string): Harness {
  const windowListeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
  const frameWindow = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
  const messages: Record<string, unknown>[] = [];
  const toParent: Record<string, unknown>[] = [];
  const panel = node();
  const stage = node();
  const start = node();
  const frameHost = node({
    querySelector: () => node({ contentWindow: frameWindow } as unknown as Partial<Node>),
  });
  const config = {
    nonce: designNonce,
    canComment: true,
    frames: [{ id: "frame-a", name: "Variant A", revisionId: "rev-a", bridgeNonce }],
  };
  const body = node();
  const bodyAttributes: Record<string, string> = { "data-scene-view": sceneView };
  body.getAttribute = (name) => bodyAttributes[name] ?? null;
  let observer: (() => void) | null = null;
  const context = {
    document: {
      body,
      getElementById: (id: string) =>
        id === "scene-request-data"
          ? { textContent: JSON.stringify(config) }
          : id === "scene-request-draft"
            ? panel
            : id === "stage"
              ? stage
              : null,
      querySelector: (selector: string) =>
        selector === "[data-request-start]" ? start : selector.startsWith('[data-frame-id="') ? frameHost : null,
      createElement: () => node(),
      addEventListener: () => {},
    },
    window: {
      parent: { postMessage: (message: Record<string, unknown>) => toParent.push(message) },
      addEventListener: (type: string, run: (event: { source: unknown; data: unknown }) => void) => {
        if (type === "message") windowListeners.push(run);
      },
      CSS: { escape: (value: string) => value },
    },
    MutationObserver: class {
      constructor(run: () => void) {
        observer = run;
      }
      observe(): void {}
    },
    CSS: { escape: (value: string) => value },
    JSON,
    console,
  };
  vm.createContext(context);
  new vm.Script(designRequestControllerScript()).runInContext(context);
  return {
    messages,
    panel,
    clickStart: () => {
      for (const run of start.listeners.click ?? []) run();
    },
    selectFromArtboard: (data = {}) => {
      for (const listener of windowListeners) {
        listener({
          source: (frameHost.querySelector() as unknown as { contentWindow: unknown }).contentWindow,
          data: {
            channel: BRIDGE_CHANNEL,
            version: BRIDGE_VERSION,
            nonce: bridgeNonce,
            type: "select",
            selector: "#cta",
            textHint: "Start free",
            x: 0.4,
            y: 0.6,
            viewportWidth: 1280,
            ...data,
          },
        });
      }
    },
    setSceneView: (view: string) => {
      bodyAttributes["data-scene-view"] = view;
      if (observer !== null) (observer as () => void)();
    },
    submitToParent: () => toParent,
  };
}

test("Play never shows the request surface", () => {
  const run = harness("play");
  assert.equal(run.panel.children.length, 0, "entering Play leaves no draft card");
  assert.deepEqual(
    run.messages.map((message) => message.type),
    ["mode"],
    "the controller turns the artboard bridge off instead of selecting",
  );
  assert.equal(run.messages[0]?.on, false);
});

test("Play ignores a selection the artboard still proposes", () => {
  const run = harness("play");
  run.clickStart();
  assert.equal(
    run.messages.some((message) => message.on === true),
    false,
    "Play cannot start a selection",
  );
  run.selectFromArtboard();
  assert.equal(run.panel.children.length, 0, "no request card is built in Play");
  assert.deepEqual(run.submitToParent(), [], "the shell never receives a submit from Play");
});

test("the controller enforces the domain selector limit on an incoming selection", () => {
  const accepted = harness("canvas");
  accepted.selectFromArtboard({ selector: "a".repeat(MAX_SELECTION_SELECTOR), textHint: "" });
  assert.equal(accepted.panel.children.length > 0, true, "the boundary selector builds a request card");
  const refused = harness("canvas");
  refused.selectFromArtboard({ selector: "a".repeat(MAX_SELECTION_SELECTOR + 1), textHint: "" });
  assert.equal(refused.panel.children.length, 0, "one character past the boundary is dropped");
});

test("Canvas starts a selection and turns it off when Play begins", () => {
  const run = harness("canvas");
  run.clickStart();
  assert.ok(
    run.messages.some((message) => message.type === "mode" && message.on === true),
    "Canvas can start a selection",
  );
  run.setSceneView("play");
  assert.equal(
    run.messages.at(-1)?.on,
    false,
    "the transition to Play turns the bridge off so clicks are not intercepted",
  );
  run.selectFromArtboard();
  assert.deepEqual(run.submitToParent(), [], "a late selection in Play is dropped");
});
