import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { escapeAttribute, wrapperPage, type ViewerRefresh } from "../apps/api/src/viewer/html.ts";
import { draftFlagOf, publishDraftFlag, republishedSince } from "../apps/dashboard/src/viewer-thread-sync.ts";

const META = "/api/artifacts/abc";
const REFRESH: ViewerRefresh = { plan: { kind: "reload", metaUrl: META }, revisionNumber: 3, sha256: "aaa" };
const TAIL = "if (!document.hidden) startPolling();";
const scriptOf = (refresh: ViewerRefresh = REFRESH): string => {
  const page = wrapperPage(escapeAttribute("<p>x</p>"), "/", { title: "T", version: 3 }, false, refresh);
  const start = page.indexOf("const refresh =");
  const end = page.indexOf(TAIL);
  assert.ok(start > 0 && end > start, "poller present");
  return page.slice(start, end + TAIL.length);
};

type ProbeNode = {
  attrs: Map<string, string>;
  writes: Map<string, number>;
  dataset: Record<string, string | undefined>;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  getAttribute: (name: string) => string | null;
  textContent: string | null;
};
const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const nodeOf = (): ProbeNode => {
  const attrs = new Map<string, string>();
  const writes = new Map<string, number>();
  const node: ProbeNode = {
    attrs,
    writes,
    dataset: {} as Record<string, string | undefined>,
    setAttribute: (name, value) => {
      attrs.set(name, value);
      writes.set(name, (writes.get(name) ?? 0) + 1);
    },
    removeAttribute: (name) => {
      attrs.delete(name);
    },
    getAttribute: (name) => attrs.get(name) ?? null,
    textContent: null,
  };
  node.dataset = new Proxy({} as Record<string, string | undefined>, {
    get: (_target, key: string) => attrs.get(`data-${kebab(key)}`),
    set: (_target, key: string, value: unknown) => {
      node.setAttribute(`data-${kebab(key)}`, String(value));
      return true;
    },
    deleteProperty: (_target, key: string) => {
      attrs.delete(`data-${kebab(key)}`);
      return true;
    },
  });
  return node;
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function env(options: {
  respond: () => { ok: boolean; status: number; json?: () => Promise<unknown> };
  hidden?: boolean;
}) {
  const elements = new Map<string, ProbeNode>();
  for (const selector of [".vbar-version", "#docshell"]) elements.set(selector, nodeOf());
  const timers = new Map<number, () => void>();
  const documentListeners = new Map<string, Array<() => void>>();
  const windowListeners = new Map<string, Array<() => void>>();
  const observers: Array<{ callback: () => void; targets: Set<ProbeNode> }> = [];
  const fetches: string[] = [];
  const history = { scrollRestoration: "manual" };
  let reloads = 0;
  let counter = 1;
  const doc = {
    hidden: options.hidden ?? false,
    getElementById: (id: string) => elements.get(`#${id}`) ?? null,
    querySelector: (selector: string) => elements.get(selector) ?? null,
    addEventListener: (type: string, callback: () => void) => {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), callback]);
    },
  };
  const win = {
    addEventListener: (type: string, callback: () => void) => {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), callback]);
    },
  };
  class Observer {
    targets: Set<ProbeNode>;
    constructor(callback: () => void) {
      const targets = new Set<ProbeNode>();
      observers.push({ callback, targets });
      this.targets = targets;
    }
    observe(target: ProbeNode): void {
      this.targets.add(target);
    }
  }
  const context = createContext({
    document: doc,
    window: win,
    location: {
      reload: () => {
        reloads += 1;
      },
    },
    history,
    fetch: async (url: string) => {
      fetches.push(url);
      return options.respond();
    },
    setInterval: (handler: () => void) => {
      const id = counter;
      counter += 1;
      timers.set(id, handler);
      return id;
    },
    clearInterval: (id: number) => {
      timers.delete(id);
    },
    MutationObserver: Observer,
  });
  runInContext(scriptOf(), context);
  return {
    elements,
    fetches,
    history,
    reloads: () => reloads,
    intervals: () => timers.size,
    async tick() {
      for (const handler of Array.from(timers.values())) handler();
      await settle();
    },
    fire(name: "visibilitychange"): void {
      for (const callback of Array.from(documentListeners.get(name) ?? [])) callback();
    },
    async fireWindow(name: string) {
      for (const callback of Array.from(windowListeners.get(name) ?? [])) callback();
      await settle();
    },
    setHidden(hidden: boolean): void {
      doc.hidden = hidden;
    },
    mutate(target: ProbeNode): void {
      for (const observer of observers) if (observer.targets.has(target)) observer.callback();
    },
  };
}

const rev = (revisionNumber: unknown, sha256: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ revision: { revisionNumber, sha256 } }),
});

test("P1 fresh page at N never reloads for N, reloads once for N+1 and stops the timer", async () => {
  let observed = 3;
  const environment = env({ respond: () => rev(observed, "aaa") });
  await environment.tick();
  assert.equal(environment.reloads(), 0, "served revision is not a change");
  assert.equal(environment.intervals(), 1, "timer alive");
  observed = 4;
  await environment.tick();
  assert.equal(environment.reloads(), 1);
  assert.equal(environment.intervals(), 0, "pending reload stops the timer");
  assert.equal(environment.history.scrollRestoration, "auto");
  await environment.tick();
  assert.equal(environment.reloads(), 1, "no second reload for the same revision");
});

test("P2 after a reload that did not navigate, resume polls again but never reloads the same revision", async () => {
  let observed = 4;
  const environment = env({ respond: () => rev(observed, `sha-${observed}`) });
  await environment.tick();
  assert.equal(environment.reloads(), 1);
  const before = environment.fetches.length;
  environment.fire("visibilitychange");
  await settle();
  assert.equal(environment.intervals(), 1, "poller is back");
  assert.equal(environment.fetches.length, before + 1, "one immediate poll");
  assert.equal(environment.reloads(), 1, "same revision never reloads twice in one document");
  observed = 5;
  await environment.tick();
  assert.equal(environment.reloads(), 2, "a genuinely newer revision still reloads");
  environment.fire("visibilitychange");
  await settle();
  assert.equal(environment.reloads(), 2, "and the resumed poll is deduped too");
});

test("P3 pageshow without a prior reload arms polling and polls immediately", async () => {
  const environment = env({ respond: () => rev(3, "aaa"), hidden: true });
  assert.equal(environment.intervals(), 0, "hidden page schedules nothing");
  environment.setHidden(false);
  await environment.fireWindow("pageshow");
  assert.equal(environment.intervals(), 1);
  assert.deepEqual(environment.fetches, [META], "immediate poll on pageshow");
  assert.equal(environment.reloads(), 0);
});

test("P4 two visibilitychange-visible events in a row: one timer, no duplicate reload", async () => {
  let observed = 3;
  const environment = env({ respond: () => rev(observed, observed === 3 ? "aaa" : "sha") });
  environment.setHidden(true);
  environment.fire("visibilitychange");
  environment.setHidden(false);
  environment.fire("visibilitychange");
  environment.fire("visibilitychange");
  await settle();
  assert.equal(environment.intervals(), 1, "one timer");
  assert.equal(environment.fetches.length, 1, "concurrent resumes coalesce into one in-flight poll");
  assert.equal(environment.reloads(), 0, "no reload while nothing changed");
  observed = 4;
  await environment.tick();
  assert.equal(environment.reloads(), 1, "one reload only");
});

test("P5 a persistent 404 reloads once and never loops", async () => {
  const environment = env({ respond: () => ({ ok: false, status: 404 }) });
  await environment.tick();
  assert.equal(environment.reloads(), 1, "revocation reloads");
  environment.fire("visibilitychange");
  await settle();
  await environment.tick();
  await environment.tick();
  assert.equal(environment.reloads(), 1, "no reload loop for a page that keeps 404ing");
});

test("P6 every non-revision body some route could return is ignored", async () => {
  const bodies: unknown[] = [
    {},
    [],
    { revision: null },
    { revision: {} },
    { revision: { revisionNumber: "4", sha256: "x" } },
    { revision: { revisionNumber: 4 } },
    { revision: { revisionNumber: 4, sha256: 42 } },
    { revision: { revisionNumber: Infinity, sha256: "x" } },
    { revision: { revisionNumber: NaN, sha256: "x" } },
    { revision: "gone" },
    { revision: 0 },
    { revision: [4, "x"] },
    "text",
    null,
  ];
  for (const body of bodies) {
    const environment = env({ respond: () => ({ ok: true, status: 200, json: async () => body }) });
    await environment.tick();
    assert.equal(environment.reloads(), 0, `no reload for ${JSON.stringify(body) ?? String(body)}`);
    assert.equal(environment.intervals(), 1, "polling continues");
    assert.equal(environment.elements.get("#docshell")?.dataset.revisionStale, undefined, "nothing marked");
  }
});

test("P7 a real revision never yields the revocation key, and keys are distinct per revision", async () => {
  for (const body of [
    { revisionNumber: 0, sha256: "gone" },
    { revisionNumber: 1, sha256: "" },
    { revisionNumber: 4, sha256: "gone" },
    { revisionNumber: 4.5, sha256: "x" },
  ]) {
    const environment = env({ respond: () => ({ ok: true, status: 200, json: async () => body }) });
    await environment.tick();
    assert.equal(environment.reloads(), 1, `reloads once for ${JSON.stringify(body)}`);
  }
  const gone = env({ respond: () => ({ ok: false, status: 404 }) });
  await gone.tick();
  assert.equal(gone.reloads(), 1);
});

test("P8 a typed draft defers, marks stale once, and releases exactly one reload", async () => {
  const environment = env({ respond: () => rev(4, "def") });
  const shell = environment.elements.get("#docshell");
  assert.ok(shell !== undefined, "the shell is addressable");
  shell.dataset.commentDraft = "typed";
  await environment.tick();
  await environment.tick();
  assert.equal(environment.reloads(), 0, "draft holds the reload");
  assert.equal(shell.dataset.revisionStale, "4");
  assert.equal(shell.writes.get("data-revision-stale"), 1, "marked once");
  shell.dataset.something = "else";
  environment.mutate(shell);
  assert.equal(environment.reloads(), 0, "unrelated mutation does not release");
  delete shell.dataset.commentDraft;
  environment.mutate(shell);
  assert.equal(environment.reloads(), 1, "ending the draft releases one reload");
  environment.mutate(shell);
  assert.equal(environment.reloads(), 1, "and only one");
});

test("P9 the republished reader follows the draft and the mark", () => {
  const shell = { dataset: {} as Record<string, string | undefined> };
  const hostEmpty = { querySelector: () => null };
  const hostTyped = { querySelector: () => ({}) };
  assert.equal(draftFlagOf(hostEmpty), null);
  publishDraftFlag(hostTyped, shell);
  assert.equal(shell.dataset.commentDraft, "typed");
  assert.equal(republishedSince(shell), false, "a draft alone is not a republish");
  shell.dataset.revisionStale = "4";
  assert.equal(republishedSince(shell), true);
  publishDraftFlag(hostTyped, shell);
  assert.equal(republishedSince(shell), true, "a republish stays readable while a typed draft is open");
  publishDraftFlag(hostEmpty, shell);
  assert.equal("commentDraft" in shell.dataset, false, "clearing the draft removes the flag");
  shell.dataset.revisionStale = "";
  assert.equal(republishedSince(shell), false, "an empty mark is not a republish");
});
