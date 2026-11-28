import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import { DESIGN_BRIDGE_CHANNEL, DESIGN_BRIDGE_VERSION } from "@artiflow/domain/design-bridge";

import { designRequestShellScript } from "../apps/api/src/viewer/design-request-shell.ts";
import { designRequestControllerScript } from "../apps/api/src/viewer/design-request-controller.ts";
import { selectionBridgeScript } from "../apps/api/src/viewer/selection-bridge-script.ts";

const nonce = "design-nonce";
const frameWindow = { postMessage: (message: unknown) => replies.push(message) };
const replies: unknown[] = [];

type Harness = {
  fetch: (url: string, init: { body: string; method: string }) => Promise<{ status: number; json(): Promise<unknown> }>;
  dispatch: (data: unknown, source?: unknown) => void;
  reloads: () => number;
  flush: () => void;
  calls: { url: string; body: unknown; method: string }[];
};

function harness(options: { canComment?: boolean; status?: number } = {}): Harness {
  const config = {
    nonce,
    canComment: options.canComment ?? true,
    commentsEndpoint: "/api/artifacts/design-1/comments",
    expectedRevisionId: "revision-design",
    designId: "design-1",
    designTitle: "Shared version picker",
  };
  const listeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
  const timers: (() => void)[] = [];
  const calls: { url: string; body: unknown; method: string }[] = [];
  let reloads = 0;
  const context = {
    document: {
      getElementById: (id: string) =>
        id === "viewer-design-request-data" ? { textContent: JSON.stringify(config) } : null,
      querySelector: () => ({ contentWindow: frameWindow }),
    },
    window: {
      addEventListener: (_type: string, run: (event: { source: unknown; data: unknown }) => void) =>
        listeners.push(run),
    },
    location: { reload: () => (reloads += 1) },
    setTimeout: (run: () => void) => timers.push(run),
    fetch: async (url: string, init: { body: string; method: string }) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      const status = options.status ?? 201;
      return { status, json: async () => ({ id: "request-1" }) };
    },
    JSON,
    console,
  };
  vm.createContext(context);
  new vm.Script(designRequestShellScript()).runInContext(context);
  return {
    fetch: context.fetch,
    dispatch: (data, source) => {
      for (const listener of listeners) listener({ source: source ?? frameWindow, data });
    },
    reloads: () => reloads,
    flush: () => {
      for (const timer of timers.splice(0)) timer();
    },
    calls,
  };
}

const submit = {
  channel: DESIGN_BRIDGE_CHANNEL,
  version: DESIGN_BRIDGE_VERSION,
  nonce,
  type: "submit",
  frameId: "frame-a",
  revisionId: "33333333-3333-4333-8333-333333333333",
  selection: { selector: "#cta", textHint: "Start free", point: { x: 0.4, y: 0.6 }, viewportWidth: 1280 },
  body: "Change the label",
};

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test("the shell posts the artboard anchor with the revision it holds, never one the message asks for", async () => {
  replies.length = 0;
  const run = harness();
  run.dispatch({ ...submit });
  await settle();
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0]?.url, "/api/artifacts/design-1/comments");
  assert.equal(run.calls[0]?.method, "POST");
  assert.deepEqual(run.calls[0]?.body, {
    anchor: {
      kind: "artboard-point",
      boardId: "frame-a",
      revisionId: submit.revisionId,
      selector: "#cta",
      textHint: "Start free",
      x: 0.4,
      y: 0.6,
      viewportWidth: 1280,
    },
    body: "Change the label",
    expectedRevisionId: "revision-design",
  });
  assert.deepEqual(plain(replies[0]), {
    channel: DESIGN_BRIDGE_CHANNEL,
    version: DESIGN_BRIDGE_VERSION,
    nonce,
    type: "result",
    requestId: "request-1",
    error: null,
  });
  assert.equal(run.reloads(), 0, "the reload is scheduled, not run inline");
  run.flush();
  assert.equal(run.reloads(), 1, "the page reloads so the anchored thread comes back from the server");
});

test("the shell refuses a submit that smuggles fields, a foreign nonce or a foreign window", async () => {
  for (const data of [
    { ...submit, expectedRevisionId: "other" },
    { ...submit, token: "secret" },
    { ...submit, permission: "editor" },
    { ...submit, nonce: "other" },
    { ...submit, version: DESIGN_BRIDGE_VERSION + 1 },
    { ...submit, body: "   " },
    { ...submit, selection: { ...submit.selection, x: 2 } },
  ]) {
    replies.length = 0;
    const run = harness();
    run.dispatch(data);
    await settle();
    assert.equal(run.calls.length, 0, `${JSON.stringify(data).slice(0, 60)} never reaches the API`);
    assert.deepEqual(replies, []);
  }
  const run = harness();
  run.dispatch({ ...submit }, { id: "other-window" });
  await settle();
  assert.equal(run.calls.length, 0);
});

test("a reader never posts a request, even if the scene document asks", async () => {
  replies.length = 0;
  const run = harness({ canComment: false });
  run.dispatch({ ...submit });
  await settle();
  assert.equal(run.calls.length, 0);
  assert.deepEqual(plain(replies[0]), {
    channel: DESIGN_BRIDGE_CHANNEL,
    version: DESIGN_BRIDGE_VERSION,
    nonce,
    type: "result",
    requestId: null,
    error: "You can see this design but you cannot comment on it.",
  });
});

test("a failed save reports the failure and never a publication", async () => {
  for (const [status, expected] of [
    [403, "You cannot comment on this design."],
    [409, "This design changed while you were writing. Reopen it and try again."],
    [500, "The request was not saved (500)."],
  ] as const) {
    replies.length = 0;
    const run = harness({ status });
    run.dispatch({ ...submit });
    await settle();
    assert.deepEqual(plain(replies[0]), {
      channel: DESIGN_BRIDGE_CHANNEL,
      version: DESIGN_BRIDGE_VERSION,
      nonce,
      type: "result",
      requestId: null,
      error: expected,
    });
    assert.equal(JSON.stringify(replies[0]).includes("ublished"), false);
  }
});

test("the scene scripts are parseable and never reach the network or the browser store", () => {
  const scripts = [selectionBridgeScript({ nonce, pins: [], allowSelect: true }), designRequestControllerScript()];
  for (const raw of scripts) {
    const source = raw.includes("<script") ? raw.slice(raw.indexOf(">") + 1, raw.lastIndexOf("</script>")) : raw;
    new vm.Script(source, { filename: "inline.js" });
    for (const forbidden of ["fetch(", "XMLHttpRequest", "document.cookie", "localStorage", "sessionStorage"])
      assert.equal(source.includes(forbidden), false, `the inline script never uses ${forbidden}`);
  }
});

test("the selection bridge is generated per frame and only proposes a selection", () => {
  const script = selectionBridgeScript({
    nonce: `${nonce}:frame-a`,
    pins: [{ id: "thread-a", number: 1, selector: "#cta", textHint: "", x: 0.4, y: 0.6 }],
    allowSelect: true,
  });
  assert.ok(script.includes(`${nonce}:frame-a`));
  assert.ok(script.includes('type: "select"'));
  assert.equal(script.includes('type: "submit"'), false, "the artboard cannot open a request by itself");
  assert.ok(script.includes("event.source !== window.parent"));
  const source = readFileSync(new URL("../apps/api/src/viewer/selection-bridge-script.ts", import.meta.url), "utf8");
  assert.equal(source.includes("expectedRevisionId"), false, "the artboard never learns the design revision id");
});
