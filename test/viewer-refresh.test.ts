import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

import { Hono } from "hono";

import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { newRevisionStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import { createShareViewerApp } from "../apps/api/src/routes/sharing.ts";

import {
  escapeAttribute,
  NOT_FOUND_HEADERS,
  NOT_FOUND_PAGE,
  SANDBOX,
  sceneCsp,
  THEME_BOOTSTRAP,
  VIEWER_CSP,
  VIEWER_HEADERS,
  WRAPPER_CSP,
  wrapperPage,
  type ViewerRefresh,
} from "../apps/api/src/viewer/html.ts";
import { markdownViewerPage, renderMarkdownFragment } from "../apps/api/src/viewer/markdown.ts";

const TODAYS_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'";
const VIEWER_POLICY =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; connect-src 'self'";

const unescapeAttribute = (value: string): string =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

const srcdocOf = (page: string): string => {
  const attribute = /srcdoc="([^"]*)"/.exec(page)?.[1];
  assert.ok(attribute !== undefined, "the viewer page carries a srcdoc frame");
  return unescapeAttribute(attribute);
};

const scriptBodies = (page: string): string[] =>
  [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");

const refreshScriptOf = (page: string): string => {
  const body = scriptBodies(page).at(-1);
  assert.ok(body !== undefined, "the viewer page ships its refresh script");
  return body;
};

const OWNER_META = "/api/artifacts/1111";
const SHARE_META = "/share/token42?meta=1";
const OWNER_REFRESH: ViewerRefresh = {
  plan: { kind: "reload", metaUrl: OWNER_META },
  revisionNumber: 3,
  sha256: "aaa",
};
const SHARE_REFRESH: ViewerRefresh = {
  plan: { kind: "reload", metaUrl: SHARE_META },
  revisionNumber: 2,
  sha256: "bbb",
};
const NO_REFRESH: ViewerRefresh = { plan: { kind: "none" }, revisionNumber: 1, sha256: "bbb" };
const BYTES = `<!doctype html><p onclick="steal()">quotes "a" 'b' & more</p><script>document.title = "pwn"</script>`;

test("the served viewer policy is today's wrapper list plus the same-origin bundle and one connect-src", () => {
  assert.equal(WRAPPER_CSP, TODAYS_POLICY, "the wrapper policy stays byte-identical");
  assert.equal(VIEWER_CSP, VIEWER_POLICY);
  assert.equal(
    VIEWER_CSP.includes("script-src 'self' 'unsafe-inline'"),
    true,
    "the viewer needs the same-origin comment bundle, and adds no host",
  );
  assert.deepEqual(VIEWER_CSP.split("; ").slice(0, -1), [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "frame-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ]);
  assert.equal(VIEWER_CSP.split("; ").at(-1), "connect-src 'self'", "the only added directive is last");
  assert.equal(VIEWER_HEADERS["content-security-policy"], VIEWER_CSP);
  assert.deepEqual(Object.keys(VIEWER_HEADERS), ["content-security-policy", "x-content-type-options", "cache-control"]);
});

test("the widened policy adds no source, host or sandbox relaxation", () => {
  for (const forbidden of [
    "connect-src *",
    "connect-src 'self' https:",
    " ws:",
    "wss:",
    " data:",
    "blob:",
    "'unsafe-eval'",
    "frame-ancestors",
    "child-src",
    "worker-src",
    "default-src *",
    "allow-same-origin",
    "allow-forms",
    "allow-popups",
    "allow-top-navigation",
    "allow-modals",
    "allow-presentation",
  ]) {
    assert.equal(VIEWER_CSP.includes(forbidden), false, `the viewer policy never gains ${forbidden}`);
  }
  assert.equal(VIEWER_CSP.split("; ").length, TODAYS_POLICY.split("; ").length + 2, "exactly two directives added");
});

test("the 404 refusal keeps the narrow policy and never references the widened constant", () => {
  assert.equal(NOT_FOUND_HEADERS["content-security-policy"], WRAPPER_CSP);
  assert.equal(NOT_FOUND_HEADERS["content-security-policy"].includes("connect-src"), false);
  assert.equal(NOT_FOUND_PAGE.includes("connect-src"), false);
  assert.equal(NOT_FOUND_PAGE.includes("<script"), false);
  assert.equal(NOT_FOUND_PAGE.includes("<iframe"), false);
});

test("the HTML wrapper keeps one opaque-origin frame and hands it the stored bytes unchanged", () => {
  const page = wrapperPage(escapeAttribute(BYTES), "/", { title: "T", version: 3 }, false, OWNER_REFRESH);
  assert.equal((page.match(/<iframe /g) ?? []).length, 1, "exactly one frame");
  assert.ok(page.includes(`sandbox="${SANDBOX}"`));
  assert.equal(SANDBOX, "allow-scripts");
  assert.ok(page.includes('referrerpolicy="no-referrer"'));
  for (const token of ["allow-same-origin", "allow-forms", "allow-popups", "allow-top-navigation"]) {
    assert.equal(page.includes(token), false, `${token} never appears on the viewer page`);
  }
  assert.equal(srcdocOf(page), BYTES, "the frame receives the stored bytes and nothing else");
  assert.equal(/content-security-policy/i.test(page), false, "the HTML wrapper declares no policy of its own");
  assert.equal(/<(link|img)\b/.test(page), false, "no external asset is loaded");
});

test("the markdown wrapper keeps its scriptless sandbox and its own policy list", () => {
  const page = markdownViewerPage(renderMarkdownFragment("# Notas"), "/", { title: "T", version: 1 }, false, {
    plan: { kind: "reload", metaUrl: OWNER_META },
    revisionNumber: 1,
    sha256: "bbb",
  });
  assert.equal(/<iframe/.test(page), false, "the document renders in the page, so there is no second frame");
  assert.equal(/allow-scripts/.test(page), false, "and no script sandbox is granted anywhere");
  assert.equal(page.includes(THEME_BOOTSTRAP), false, "the markdown viewer ships no theme bootstrap");
  assert.equal(scriptBodies(page).length, 1, "exactly the one refresh script");
  assert.equal(
    /content-security-policy" content="([^"]*)"/.exec(page)?.[1],
    `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; base-uri 'none'; form-action 'none'; connect-src 'self'`,
  );
});

test("the additional gate: the artifact inherits the wrapper list and stays opaque-origin", () => {
  const html = wrapperPage(escapeAttribute("<p>x</p>"), "/", { title: "T", version: 1 }, false, OWNER_REFRESH);
  const markdown = markdownViewerPage(renderMarkdownFragment("# x"), "/", { title: "T", version: 1 }, false, {
    plan: { kind: "reload", metaUrl: OWNER_META },
    revisionNumber: 1,
    sha256: "bbb",
  });
  assert.equal(VIEWER_CSP, VIEWER_POLICY, "the inherited list equals the viewer's list");
  assert.notEqual(VIEWER_CSP, WRAPPER_CSP, "the inherited list is the widened one: this gate exists because of that");

  const hostDirectives = new Set(VIEWER_POLICY.split("; ").map((directive) => directive.split(" ")[0] ?? ""));
  const markdownMeta = /content-security-policy" content="([^"]*)"/.exec(markdown)?.[1] ?? "";
  for (const directive of markdownMeta.split("; ")) {
    const name = directive.split(" ")[0] ?? "";
    assert.ok(name === "img-src" || hostDirectives.has(name), `no extra directive: ${directive}`);
  }
  assert.equal(markdownMeta.includes("connect-src 'self'"), true);
  assert.equal(markdownMeta.includes("unsafe-eval"), false);

  assert.match(html, /<iframe sandbox="allow-scripts" referrerpolicy="no-referrer"/);
  assert.equal(/<iframe/.test(markdown), false, "the markdown page no longer ships a second frame");
  assert.match(markdown, /<main class="mdpage" id="document">/);
  assert.equal(/allow-same-origin/.test(html), false);

  assert.equal(srcdocOf(html), "<p>x</p>");
  const documentMarkup = /<main class="mdpage" id="document">([\s\S]*?)<\/main>/.exec(markdown)?.[1];
  assert.notEqual(documentMarkup, undefined, "the document region is addressable");
  assert.equal(/<script/i.test(documentMarkup ?? ""), false, "the fragment adds no script");
  assert.equal(scriptBodies(markdown).length, 1, "the page ships exactly its refresh script");
  const hostile = markdownViewerPage(
    renderMarkdownFragment("# x\n\n<script>alert(1)</script>\n"),
    "/",
    { title: "T", version: 1 },
    false,
    { plan: { kind: "reload", metaUrl: OWNER_META }, revisionNumber: 1, sha256: "bbb" },
  );
  const hostileDocument = /<main class="mdpage" id="document">([\s\S]*?)<\/main>/.exec(hostile)?.[1] ?? "";
  assert.equal(/<script/i.test(hostileDocument), false, "raw html in the source is escaped, never executed");
  assert.match(hostileDocument, /&lt;script&gt;/, "the reader sees the tag as text");
});

test("the served poller reloads instead of rebuilding the document", () => {
  const script = refreshScriptOf(wrapperPage(escapeAttribute(BYTES), "/", undefined, false, OWNER_REFRESH));
  for (const forbidden of [
    "srcdoc",
    "DOMParser",
    "contentWindow",
    "contentDocument",
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    "document.write",
    "eval(",
    "postMessage",
    '"message"',
    "document.cookie",
    "localStorage",
    "sessionStorage",
  ]) {
    assert.equal(script.includes(forbidden), false, `the poller never uses ${forbidden}`);
  }
  assert.ok(script.includes("location.reload()"), "the only document change the poller makes is a reload");
  assert.ok(script.includes("fetch(refresh.metaUrl"), "and it reads only the same-origin metadata route");
  assert.equal(script.includes("refresh.revisionNumber ="), false, "polled metadata never lands in the document");
});

test("a plan of none ships no poller at all", () => {
  for (const page of [
    wrapperPage(escapeAttribute(BYTES), "/", { title: "T", version: 1 }, false, NO_REFRESH),
    markdownViewerPage(renderMarkdownFragment("# x"), "/", { title: "T", version: 1 }, false, NO_REFRESH),
  ]) {
    assert.equal(page.includes("fetch("), false, "no plan, no request");
    assert.equal(page.includes("setInterval"), false, "no plan, no timer");
    assert.equal(page.includes("const refresh"), false, "no plan, no poller config");
    assert.equal(page.includes("location.reload"), false, "and nothing that could navigate on its own");
  }
});

type StubResponse = { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> };

const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

class StubElement {
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<() => void>>();
  textContent: string | null = null;
  focused = false;
  get dataset(): Record<string, string | undefined> {
    const attributes = this.attributes;
    const write = (name: string, value: string): void => this.setAttribute(name, value);
    return new Proxy({} as Record<string, string | undefined>, {
      get: (_target, key: string) => attributes.get(`data-${kebab(key)}`),
      set: (_target, key: string, value: unknown) => {
        write(`data-${kebab(key)}`, String(value));
        return true;
      },
      deleteProperty: (_target, key: string) => {
        attributes.delete(`data-${kebab(key)}`);
        return true;
      },
      has: (_target, key: string) => attributes.has(`data-${kebab(key)}`),
    });
  }
  addEventListener(type: string, handler: () => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(handler);
    this.listeners.set(type, current);
  }
  dispatch(type: string): void {
    for (const handler of Array.from(this.listeners.get(type) ?? [])) handler();
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  focus(): void {
    this.focused = true;
  }
}

type Environment = {
  run: (script: string) => void;
  tick: () => Promise<void>;
  intervals: () => number;
  fetches: string[];
  reloads: () => number;
  history: { scrollRestoration: string };
  element: (selector: string) => StubElement;
  fireDocument: (type: string, event?: { key?: string; target?: unknown }) => void;
  fireWindow: (type: string) => void;
  setHidden: (hidden: boolean) => void;
  mutate: (element: StubElement) => void;
};

function makeEnvironment(options: {
  selectors: string[];
  hidden?: boolean;
  respond: (url: string) => StubResponse;
}): Environment {
  const elements = new Map<string, StubElement>();
  for (const selector of options.selectors) elements.set(selector, new StubElement());
  const elementOf = (selector: string): StubElement => {
    const existing = elements.get(selector);
    if (existing !== undefined) return existing;
    const created = new StubElement();
    elements.set(selector, created);
    return created;
  };
  const documentListeners = new Map<string, Array<(event?: { key?: string; target?: unknown }) => void>>();
  const windowListeners = new Map<string, Array<() => void>>();
  const classes = new Set<string>();
  const timers = new Map<number, () => void>();
  const fetches: string[] = [];
  const observers: Array<{ callback: () => void; targets: Set<StubElement> }> = [];
  let nextTimer = 1;
  let reloads = 0;
  const history = { scrollRestoration: "manual" };
  class StubMutationObserver {
    targets = new Set<StubElement>();
    constructor(callback: () => void) {
      observers.push({ callback, targets: this.targets });
    }
    observe(target: StubElement): void {
      this.targets.add(target);
    }
    disconnect(): void {
      this.targets.clear();
    }
  }
  const documentStub = {
    hidden: options.hidden ?? false,
    body: {
      classList: {
        toggle: (name: string, on: boolean): void => {
          if (on) classes.add(name);
          else classes.delete(name);
        },
        contains: (name: string): boolean => classes.has(name),
      },
    },
    querySelector: (selector: string): StubElement | null => elements.get(selector) ?? null,
    getElementById: (id: string): StubElement => elementOf(`#${id}`),
    addEventListener: (type: string, handler: (event?: { key?: string; target?: unknown }) => void): void => {
      const current = documentListeners.get(type) ?? [];
      current.push(handler);
      documentListeners.set(type, current);
    },
  };
  const locationStub = {
    reload: (): void => {
      reloads += 1;
    },
  };
  const windowStub = {
    addEventListener: (type: string, handler: () => void): void => {
      const current = windowListeners.get(type) ?? [];
      current.push(handler);
      windowListeners.set(type, current);
    },
  };
  const fetchStub = async (url: string): Promise<StubResponse> => {
    fetches.push(url);
    return options.respond(url);
  };
  const setIntervalStub = (handler: () => void): number => {
    const id = nextTimer;
    nextTimer += 1;
    timers.set(id, handler);
    return id;
  };
  const clearIntervalStub = (id: number): void => {
    timers.delete(id);
  };
  return {
    run: (script: string): void => {
      runInNewContext(script, {
        document: documentStub,
        window: windowStub,
        location: locationStub,
        history,
        fetch: fetchStub,
        setInterval: setIntervalStub,
        clearInterval: clearIntervalStub,
        MutationObserver: StubMutationObserver,
      });
    },
    tick: async (): Promise<void> => {
      for (const handler of Array.from(timers.values())) handler();
      await settle();
    },
    intervals: (): number => timers.size,
    fetches,
    reloads: (): number => reloads,
    history,
    element: elementOf,
    fireDocument: (type: string, event?: { key?: string; target?: unknown }): void => {
      for (const handler of Array.from(documentListeners.get(type) ?? [])) handler(event);
    },
    fireWindow: (type: string): void => {
      for (const handler of Array.from(windowListeners.get(type) ?? [])) handler();
    },
    setHidden: (hidden: boolean): void => {
      documentStub.hidden = hidden;
    },
    mutate: (target: StubElement): void => {
      for (const observer of observers) if (observer.targets.has(target)) observer.callback();
    },
  };
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const json = (body: unknown): StubResponse => ({ ok: true, status: 200, json: async () => body });
const refused: StubResponse = { ok: false, status: 500 };
const gone: StubResponse = { ok: false, status: 404 };

const ownerPage = (): string =>
  wrapperPage(escapeAttribute(BYTES), "/", { title: "T", version: 3 }, false, OWNER_REFRESH);
const sharePage = (): string => wrapperPage(escapeAttribute(BYTES), undefined, undefined, false, SHARE_REFRESH);

test("a newer revision reloads the page once and never touches the frame document", async () => {
  const environment = makeEnvironment({
    selectors: [".vbar-focus", ".vbar-exit", ".vbar-version", "iframe"],
    respond: (url) => (url === OWNER_META ? json({ revision: { revisionNumber: 4, sha256: "def" } }) : json({})),
  });
  const frame = environment.element("iframe");
  frame.setAttribute("srcdoc", BYTES);

  environment.run(refreshScriptOf(ownerPage()));
  await environment.tick();

  assert.deepEqual(environment.fetches, [OWNER_META], "only the metadata route is read: there are no bytes to re-read");
  assert.equal(environment.reloads(), 1, "a newer revision reloads the page");
  assert.equal(frame.getAttribute("srcdoc"), BYTES, "the frame document is never rewritten in place");
  assert.equal(environment.history.scrollRestoration, "auto", "best-effort scroll restoration is requested first");

  await environment.tick();
  assert.equal(environment.reloads(), 1, "one reload, never one per tick");
});

test("an unchanged revision touches neither the document nor the page", async () => {
  const environment = makeEnvironment({
    selectors: [".vbar-focus", ".vbar-exit", ".vbar-version", "iframe"],
    respond: (url) => (url === OWNER_META ? json({ revision: { revisionNumber: 3, sha256: "aaa" } }) : refused),
  });
  const frame = environment.element("iframe");
  frame.setAttribute("srcdoc", BYTES);
  environment.run(refreshScriptOf(ownerPage()));
  await environment.tick();

  assert.deepEqual(environment.fetches, [OWNER_META], "one read on an unchanged revision");
  assert.equal(frame.getAttribute("srcdoc"), BYTES);
  assert.equal(environment.element(".vbar-version").textContent, null);
  assert.equal(environment.reloads(), 0);
});

test("the poller observes the shell's draft flag attribute", () => {
  const script = refreshScriptOf(wrapperPage(escapeAttribute(BYTES), "/", undefined, false, OWNER_REFRESH));
  const flat = script.replace(/\s+/g, " ");
  assert.ok(flat.includes("observe(host, {"), "the observer watches the shell");
  assert.ok(
    flat.includes('attributes: true, attributeFilter: ["data-comment-draft"]'),
    "the observer watches that one attribute, so an unrelated mutation cannot release the reload",
  );
});

test("the deferred reload is the one for the revision that was deferred", () => {
  const script = refreshScriptOf(wrapperPage(escapeAttribute(BYTES), "/", undefined, false, OWNER_REFRESH));
  const flat = script.replace(/\s+/g, " ");
  assert.ok(
    flat.includes('const keyOf = (revision) => "revision:" + revision.revisionNumber + ":" + revision.sha256;'),
    "a revision key is the pair, so it can never collide with the revocation key",
  );
  assert.ok(
    flat.includes("if (deferred && !draftTyped()) reloadOnce(keyOf(seen));"),
    "the released reload carries the deferred revision's key, not an arbitrary one",
  );
});

test("a 500 whose body is JSON is still a failure, never a revision", async () => {
  const environment = makeEnvironment({
    selectors: [".vbar-version", "#docshell"],
    respond: () => ({ ok: false, status: 500, json: async () => ({ revision: { revisionNumber: 9, sha256: "zzz" } }) }),
  });
  environment.run(refreshScriptOf(ownerPage()));
  await environment.tick();

  assert.equal(environment.reloads(), 0, "a 5xx reloads nothing, whatever its body claims");
  assert.equal(environment.element(".vbar-version").textContent, null, "and the badge keeps the served revision");
  assert.equal(environment.element("#docshell").getAttribute("data-revision-stale"), null);
  assert.equal(environment.intervals(), 1, "and polling continues");
});

test("a failed or refused metadata read changes nothing and keeps polling", async () => {
  const environment = makeEnvironment({ selectors: ["iframe", ".vbar-version"], respond: () => refused });
  environment.run(refreshScriptOf(ownerPage()));
  await environment.tick();
  assert.deepEqual(environment.fetches, [OWNER_META]);
  assert.equal(environment.element("iframe").getAttribute("srcdoc"), null);
  assert.equal(environment.reloads(), 0, "a 500 is not a revocation");
  assert.equal(environment.element(".vbar-version").textContent, null, "the badge keeps the served revision");
  assert.equal(environment.intervals(), 1, "the timer survives a refusal");
});

test("an unreachable origin is not a revocation either", async () => {
  const environment = makeEnvironment({
    selectors: ["iframe", ".vbar-version", "#docshell"],
    respond: () => {
      throw new Error("offline");
    },
  });
  environment.run(refreshScriptOf(ownerPage()));
  await environment.tick();

  assert.equal(environment.reloads(), 0, "offline never reloads");
  assert.equal(environment.element(".vbar-version").textContent, null, "offline never changes the badge");
  assert.equal(environment.element("#docshell").getAttribute("data-revision-stale"), null, "offline retracts nothing");
  assert.equal(environment.intervals(), 1, "polling continues");
});

test("a revocation never invents a revision in the badge", async () => {
  const environment = makeEnvironment({ selectors: ["iframe", ".vbar-version"], respond: () => gone });
  environment.run(refreshScriptOf(ownerPage()));
  await environment.tick();

  assert.equal(environment.element(".vbar-version").textContent, null, "a 404 has no revision to advertise");
});

test("a deferred revision marks the open draft stale, and only when the revision moved", async () => {
  const moved = makeEnvironment({
    selectors: [".vbar-version", "#docshell"],
    respond: () => json({ revision: { revisionNumber: 4, sha256: "def" } }),
  });
  const movedShell = moved.element("#docshell");
  movedShell.setAttribute("data-comment-draft", "typed");
  moved.run(refreshScriptOf(ownerPage()));
  await moved.tick();
  assert.equal(
    movedShell.getAttribute("data-revision-stale"),
    "4",
    "the draft is marked against the observed revision",
  );
  assert.equal(moved.reloads(), 0, "and the mark does not throw the draft away");

  const still = makeEnvironment({
    selectors: [".vbar-version", "#docshell"],
    respond: () => json({ revision: { revisionNumber: 3, sha256: "aaa" } }),
  });
  const stillShell = still.element("#docshell");
  stillShell.setAttribute("data-comment-draft", "typed");
  still.run(refreshScriptOf(ownerPage()));
  await still.tick();
  assert.equal(stillShell.getAttribute("data-revision-stale"), null, "an unchanged revision never marks the draft");
  assert.equal(still.reloads(), 0);
});

test("the badge and the deferred reload act on the revision the poll actually observed", async () => {
  let observed = 4;
  const environment = makeEnvironment({
    selectors: [".vbar-version", "#docshell"],
    respond: () => json({ revision: { revisionNumber: observed, sha256: `sha-${observed}` } }),
  });
  const shell = environment.element("#docshell");
  shell.setAttribute("data-comment-draft", "typed");

  environment.run(refreshScriptOf(ownerPage()));
  await environment.tick();
  observed = 5;
  await environment.tick();

  assert.equal(environment.element(".vbar-version").textContent, "v5", "the badge follows the last observation");
  assert.equal(shell.getAttribute("data-revision-stale"), "5", "so does the stale mark");

  shell.removeAttribute("data-comment-draft");
  environment.mutate(shell);
  assert.equal(environment.reloads(), 1, "exactly one reload, for the same observed revision");
});

test("polling pauses while the page is hidden and resumes with an immediate read", async () => {
  const environment = makeEnvironment({
    selectors: ["iframe"],
    hidden: true,
    respond: (url) => (url === OWNER_META ? json({ revision: { revisionNumber: 3, sha256: "aaa" } }) : refused),
  });
  environment.run(refreshScriptOf(ownerPage()));
  assert.equal(environment.intervals(), 0, "a hidden page schedules no poll");
  assert.deepEqual(environment.fetches, []);

  environment.setHidden(false);
  environment.fireDocument("visibilitychange");
  assert.equal(environment.intervals(), 1);
  await settle();
  assert.deepEqual(environment.fetches, [OWNER_META], "resuming reads immediately");

  environment.setHidden(true);
  environment.fireDocument("visibilitychange");
  assert.equal(environment.intervals(), 0, "hiding the page clears the timer");
  await environment.tick();
  assert.deepEqual(environment.fetches, [OWNER_META], "a paused page polls nothing");
});

test("the public share page reloads on a change in the four-field projection", async () => {
  const environment = makeEnvironment({
    selectors: ["iframe"],
    respond: () => json({ revisionNumber: 3, sha256: "ccc", sizeBytes: 42, kind: "html" }),
  });
  environment.run(refreshScriptOf(sharePage()));
  await environment.tick();

  assert.deepEqual(environment.fetches, [SHARE_META], "the public surface has no byte endpoint to read");
  assert.equal(environment.reloads(), 1, "the page reload is the shared path");
  assert.equal(environment.history.scrollRestoration, "auto", "best-effort scroll restoration is requested first");
});

test("an embed=1 page runs the same poller without a bar to attach to", async () => {
  const page = wrapperPage(escapeAttribute(BYTES), undefined, undefined, true, OWNER_REFRESH);
  assert.equal(page.includes("<header"), false, "embed mode renders no bar");
  const environment = makeEnvironment({
    selectors: ["iframe", "#docshell"],
    respond: (url) => (url === OWNER_META ? json({ revision: { revisionNumber: 4, sha256: "def" } }) : refused),
  });
  assert.doesNotThrow(() => environment.run(refreshScriptOf(page)), "no missing-element throw in embed mode");
  await environment.tick();
  assert.deepEqual(environment.fetches, [OWNER_META], "the poller runs in embed mode");
  assert.equal(environment.reloads(), 1, "and reloads on a newer revision with no bar rendered");

  assert.doesNotThrow(() => environment.fireDocument("keydown", { key: "f" }));
  assert.doesNotThrow(() => environment.fireDocument("keydown", { key: "Escape" }));
});

test("the owner bar still handles focus and the F shortcut", () => {
  const environment = makeEnvironment({ selectors: [".vbar-focus", ".vbar-exit", "iframe"], respond: () => refused });
  environment.run(refreshScriptOf(ownerPage()));
  environment.element(".vbar-focus").dispatch("click");
  assert.equal(environment.element(".vbar-exit").focused, true, "focus mode moves keyboard focus to the exit control");
  environment.element(".vbar-exit").dispatch("click");
  assert.equal(environment.element(".vbar-exit").focused, true);
});

test("the F shortcut stays native inside a form control", () => {
  const environment = makeEnvironment({ selectors: [".vbar-focus", ".vbar-exit", "iframe"], respond: () => refused });
  environment.run(refreshScriptOf(ownerPage()));
  const input = {
    tagName: "INPUT",
    isContentEditable: false,
    closest: (s: string) => (s.includes("input") ? {} : null),
  };
  environment.fireDocument("keydown", { key: "f", target: input });
  assert.equal(environment.element(".vbar-exit").focused, false, "F in a form control never enters focus mode");
  environment.fireDocument("keydown", { key: "f" });
  assert.equal(environment.element(".vbar-exit").focused, true, "F outside a control still enters focus mode");
});

test("the markdown page keeps its own policy and the fragment can only add text", () => {
  assert.equal(/img-src 'self'(;|$)/.test(VIEWER_CSP), true, "the response policy grants same-origin images only");
  assert.equal(VIEWER_CSP.includes("data:"), false);
  assert.equal(VIEWER_CSP.includes("https:"), false);

  const markdown = markdownViewerPage(
    renderMarkdownFragment("![alt](https://example.com/a.png)"),
    "/",
    { title: "T", version: 1 },
    false,
    { plan: { kind: "reload", metaUrl: OWNER_META }, revisionNumber: 1, sha256: "bbb" },
  );
  const meta = /content-security-policy" content="([^"]*)"/.exec(markdown)?.[1] ?? "";
  assert.equal(meta.includes("img-src 'self' data: https:"), true, "the page's own allowance stays on the page");
  assert.equal(
    meta.includes("frame-src"),
    false,
    "the page needs no frame source, so frames stay at default-src 'none'",
  );
  assert.match(markdown, /<img src="https:\/\/example\.com\/a\.png"/, "markdown images still render");
  assert.equal(/onerror=/i.test(markdown), false, "the escaped fragment cannot attach handlers");
  assert.equal(renderMarkdownFragment("<img src=x onerror=alert(1)>").includes("<img"), false);
});

test("the public share 200s all spread the widened viewer headers", () => {
  const source = readFileSync(new URL("../apps/api/src/routes/sharing.ts", import.meta.url), "utf8");
  assert.equal([...source.matchAll(/\.\.\.VIEWER_HEADERS/g)].length, 2, "the markdown and HTML share 200s");
  assert.equal([...source.matchAll(/sceneHeaders\(origin\)/g)].length, 1, "the scene share 200 gets its own list");
  assert.equal(source.includes("WRAPPER_CSP"), false, "the share viewer never serves the narrow policy");
  assert.equal(
    sceneCsp("https://canvas.test"),
    VIEWER_CSP.replace("img-src 'self'", "img-src https://canvas.test"),
    "the scene list is the viewer list with one explicit image source",
  );
  assert.equal(
    [...source.matchAll(/"x-robots-tag": "noindex"/g)].length,
    5,
    "every served page stays unindexable, as do the ?meta=1 projection and the link comments",
  );
  assert.equal([...source.matchAll(/markdownViewerPage\(/g)].length, 1, "the markdown share page is one of them");
  assert.equal([...source.matchAll(/wrapperPage\(/g)].length, 2, "the HTML and scene share pages are the others");
});

const MARKDOWN_REFRESH: ViewerRefresh = {
  plan: { kind: "reload", metaUrl: OWNER_META },
  revisionNumber: 1,
  sha256: "bbb",
};
const markdownPage = (): string =>
  markdownViewerPage(renderMarkdownFragment("# x"), "/", { title: "T", version: 1 }, false, MARKDOWN_REFRESH);

test("the Markdown viewer defers the reload while a comment draft holds text", async () => {
  const environment = makeEnvironment({
    selectors: ["#docshell", ".vbar-version"],
    respond: () => json({ revisionNumber: 2, sha256: "changed" }),
  });
  environment.element("#docshell").setAttribute("data-comment-draft", "typed");
  environment.run(refreshScriptOf(markdownPage()));
  await environment.tick();

  assert.deepEqual(environment.fetches, [OWNER_META]);
  assert.equal(environment.reloads(), 0, "a typed draft is never discarded by a reload");
});

test("the Markdown viewer still reloads when nothing is being typed", async () => {
  const environment = makeEnvironment({ selectors: [], respond: () => json({ revisionNumber: 2, sha256: "changed" }) });
  environment.run(refreshScriptOf(markdownPage()));
  await environment.tick();

  assert.equal(environment.reloads(), 1, "the reload path still runs for a server-rendered document");
});

const SHARE_LINK = "a".repeat(43);
const SHARE_ROW = {
  artifactId: "artifact-one",
  storageKey: newRevisionStorageKey(),
  revisionNumber: 2,
  sizeBytes: 12,
};

type ShareTable = Promise<unknown> & {
  from: () => ShareTable;
  leftJoin: () => ShareTable;
  innerJoin: () => ShareTable;
  where: () => ShareTable;
  orderBy: () => ShareTable;
  limit: () => ShareTable;
  $dynamic: () => ShareTable;
};

const shareRows = (results: readonly unknown[]) => {
  let next = 0;
  const chain = (): ShareTable => {
    const query: ShareTable = Object.assign(
      Promise.resolve().then(() => results[next++]),
      {
        from: () => query,
        leftJoin: () => query,
        innerJoin: () => query,
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        $dynamic: () => query,
      },
    );
    return query;
  };
  return { select: chain };
};

const shareStorage = (bytes: Uint8Array): Storage =>
  ({
    client: {
      send: async (command: { constructor: { name: string } }): Promise<unknown> => {
        if (command.constructor.name === "HeadObjectCommand") return { ContentLength: bytes.length };
        if (command.constructor.name === "GetObjectCommand")
          return {
            Body: (async function* (): AsyncIterable<Uint8Array> {
              yield bytes;
            })(),
          };
        throw new Error(`unexpected command ${command.constructor.name}`);
      },
    },
    bucket: "test-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  }) as unknown as Storage;

const SHARE_MARKDOWN = new TextEncoder().encode("# Notas\n\nUn párrafo\n");
const SHARE_HTML = new TextEncoder().encode("<!doctype html><p>body</p>");

const shareProbe = async (input: {
  bytes: Uint8Array;
  kind: string;
  showComments: boolean;
  query?: string;
}): Promise<{ status: number; body: string; json: Record<string, unknown> | null; headers: Headers }> => {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const database = {
    db: shareRows([[{ ...SHARE_ROW, showComments: input.showComments, kind: input.kind, sha256 }], []]),
  } as unknown as Database;
  const app = new Hono();
  app.route("/", createShareViewerApp({ database, storage: shareStorage(input.bytes) }));
  const response = await app.request(`/share/${SHARE_LINK}${input.query ?? ""}`);
  const text = await response.text();
  return {
    status: response.status,
    body: text,
    json: (response.headers.get("content-type") ?? "").startsWith("application/json")
      ? (JSON.parse(text) as Record<string, unknown>)
      : null,
    headers: response.headers,
  };
};

test("the public meta publishes the comment flag the served page can honour", async () => {
  for (const showComments of [false, true]) {
    for (const kind of ["markdown", "html"]) {
      const reply = await shareProbe({ bytes: SHARE_MARKDOWN, kind, showComments, query: "?meta=1" });
      assert.equal(reply.status, 200);
      assert.deepEqual(
        Object.keys(reply.json ?? {}).sort(),
        ["comments", "kind", "revisionNumber", "sha256", "sizeBytes"],
        "the projection carries the flag and nothing else",
      );
      assert.equal(reply.json?.comments, showComments, `${kind} mounts a margin, so the flag is the option`);
      assert.equal(reply.headers.get("x-robots-tag"), "noindex", "the projection stays unindexable");
      assert.equal(reply.headers.get("cache-control"), "no-store");
    }
  }
  for (const kind of ["canvas", "deck"]) {
    const reply = await shareProbe({ bytes: SHARE_MARKDOWN, kind, showComments: true, query: "?meta=1" });
    assert.equal(reply.status, 200);
    assert.equal(
      reply.json?.comments,
      false,
      `${kind} draws its threads inside the frame and mounts no margin, so the flag cannot be on`,
    );
  }
});

test("a link that hides comments serves no comments host, config or bundle", async () => {
  for (const [kind, bytes] of [
    ["markdown", SHARE_MARKDOWN],
    ["html", SHARE_HTML],
  ] as const) {
    const off = await shareProbe({ bytes, kind, showComments: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.includes('id="viewer-comments"'), false, `${kind} ships no comments host`);
    assert.equal(off.body.includes("viewer-comments-data"), false, `${kind} ships no comments config`);
    assert.equal(/<script type="module"/.test(off.body), false, `${kind} ships no comments bundle`);
    assert.equal(off.body.includes("comments-available"), false, "and the shell claims no comments");
    assert.equal(off.headers.get("x-robots-tag"), "noindex", `${kind} stays unindexable`);

    const on = await shareProbe({ bytes, kind, showComments: true });
    assert.equal(on.status, 200);
    assert.ok(on.body.includes('id="viewer-comments"'), `${kind} keeps its host when the link shows comments`);
    assert.ok(on.body.includes("viewer-comments-data"), `${kind} keeps its config when the link shows comments`);
    assert.equal(on.headers.get("x-robots-tag"), "noindex");
  }
});

test("the public page records the served comments flag for its poller", async () => {
  for (const showComments of [false, true]) {
    const reply = await shareProbe({ bytes: SHARE_HTML, kind: "html", showComments });
    assert.ok(reply.body.includes("const refresh = {metaUrl:"), "the poller config keeps its shape");
    assert.ok(
      reply.body.includes(`,comments:${showComments}}`),
      `the served flag is what the poller compares against: ${showComments}`,
    );
  }
});

const sharePageWith = (comments: boolean): string =>
  wrapperPage(escapeAttribute(BYTES), undefined, undefined, false, {
    plan: { kind: "reload", metaUrl: SHARE_META },
    revisionNumber: 2,
    sha256: "bbb",
    comments,
  });

test("the public poller reloads once when the link stops showing comments", async () => {
  const environment = makeEnvironment({
    selectors: ["iframe", "#docshell"],
    respond: () => json({ revisionNumber: 2, sha256: "bbb", sizeBytes: 42, kind: "html", comments: false }),
  });
  environment.run(refreshScriptOf(sharePageWith(true)));
  await environment.tick();

  assert.deepEqual(environment.fetches, [SHARE_META]);
  assert.equal(environment.reloads(), 1, "the reader's page is reloaded without its comments");
  await environment.tick();
  assert.equal(environment.reloads(), 1, "one reload for one flag change");
});

test("a public page served without comments never reacts to the flag it was served", async () => {
  const environment = makeEnvironment({
    selectors: ["iframe", "#docshell"],
    respond: () => json({ revisionNumber: 2, sha256: "bbb", sizeBytes: 42, kind: "html", comments: false }),
  });
  environment.run(refreshScriptOf(sharePageWith(false)));
  await environment.tick();

  assert.deepEqual(environment.fetches, [SHARE_META]);
  assert.equal(environment.reloads(), 0, "a page with nothing to hide reloads for nothing");
  assert.equal(environment.intervals(), 1, "and keeps polling for revisions");
});

test("the comments flag never reloads a page on a metadata body that does not carry it", async () => {
  const environment = makeEnvironment({
    selectors: ["iframe", "#docshell"],
    respond: () => json({ revisionNumber: 2, sha256: "bbb", sizeBytes: 42, kind: "html" }),
  });
  environment.run(refreshScriptOf(sharePageWith(true)));
  await environment.tick();

  assert.equal(environment.reloads(), 0, "an unchanged revision without the flag is not a change");
  assert.equal(environment.intervals(), 1);
});

test("a served-off public page never reloads when the link turns comments on", async () => {
  const environment = makeEnvironment({
    selectors: ["iframe", "#docshell"],
    respond: () => json({ revisionNumber: 2, sha256: "bbb", sizeBytes: 42, kind: "html", comments: true }),
  });
  environment.run(refreshScriptOf(sharePageWith(false)));
  await environment.tick();
  environment.fireWindow("pageshow");
  await settle();

  assert.deepEqual(environment.fetches.length > 1, true, "the page kept polling across the resumed read");
  assert.equal(environment.reloads(), 0, "a page with no margin to reveal reloads for nothing");
  assert.equal(environment.intervals(), 1, "and keeps polling for revisions");
});
