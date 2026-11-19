import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

import {
  escapeAttribute,
  NOT_FOUND_HEADERS,
  NOT_FOUND_PAGE,
  SANDBOX,
  THEME_BOOTSTRAP,
  VIEWER_CSP,
  VIEWER_HEADERS,
  WRAPPER_CSP,
  wrapperPage,
} from "../apps/api/src/viewer/html.ts";
import { markdownViewerPage, renderMarkdownFragment } from "../apps/api/src/viewer/markdown.ts";

const TODAYS_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'";
const VIEWER_POLICY =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'; connect-src 'self'";

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

const OWNER_REFRESH = { metaUrl: "/api/artifacts/1111", srcdocUrl: "/artifact/1111", revisionNumber: 3, sha256: "aaa" };
const SHARE_REFRESH = { metaUrl: "/share/token42?meta=1", revisionNumber: 2, sha256: "bbb" };
const BYTES = `<!doctype html><p onclick="steal()">quotes "a" 'b' & more</p><script>document.title = "pwn"</script>`;
const FRESH_BYTES = `<!doctype html><p>revision four</p>`;

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
    "style-src 'unsafe-inline'",
    "frame-src 'self'",
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
  assert.equal(VIEWER_CSP.split("; ").length, TODAYS_POLICY.split("; ").length + 1, "exactly one directive added");
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
    metaUrl: "/api/artifacts/1111",
    revisionNumber: 1,
    sha256: "bbb",
  });
  assert.equal(/<iframe/.test(page), false, "the document renders in the page, so there is no second frame");
  assert.equal(/allow-scripts/.test(page), false, "and no script sandbox is granted anywhere");
  assert.equal(page.includes(THEME_BOOTSTRAP), false, "the markdown viewer ships no theme bootstrap");
  assert.equal(scriptBodies(page).length, 1, "exactly the one refresh script");
  assert.equal(
    /content-security-policy" content="([^"]*)"/.exec(page)?.[1],
    `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'; connect-src 'self'`,
  );
});

test("the additional gate: the artifact inherits the wrapper list and stays opaque-origin", () => {
  const html = wrapperPage(escapeAttribute("<p>x</p>"), "/", { title: "T", version: 1 }, false, OWNER_REFRESH);
  const markdown = markdownViewerPage(renderMarkdownFragment("# x"), "/", { title: "T", version: 1 }, false, {
    metaUrl: "/api/artifacts/1111",
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
  assert.equal(
    /<script[ >]/i.test(markdown.replace(/<script>[^]*?<\/script>/g, "")),
    false,
    "the fragment adds no script",
  );
});

test("the served refresh script never takes bytes from the frame or rebuilds the document", () => {
  const script = refreshScriptOf(wrapperPage(escapeAttribute(BYTES), "/", undefined, false, OWNER_REFRESH));
  for (const forbidden of [
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
    "contentDocument",
  ]) {
    assert.equal(script.includes(forbidden), false, `the poller never uses ${forbidden}`);
  }
  assert.ok(script.includes('getAttribute("srcdoc")'), "bytes come from the gated page's srcdoc attribute");
  assert.ok(script.includes('setAttribute("srcdoc"'), "and are applied through the DOM, which escapes them");
  assert.ok(script.includes("new DOMParser()"), "the fetched page is parsed inertly");
  assert.equal(script.includes("refresh.revisionNumber ="), false, "polled metadata never lands in the document");
});

type StubResponse = { ok: boolean; json?: () => Promise<unknown>; text?: () => Promise<string> };

class StubElement {
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<() => void>>();
  textContent: string | null = null;
  focused = false;
  contentWindow: { scrollY: number; scrollTo: (x: number, y: number) => void } | null = null;
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
  focus(): void {
    this.focused = true;
  }
}

type Environment = {
  run: (script: string) => void;
  tick: () => void;
  intervals: () => number;
  fetches: string[];
  reloads: () => number;
  history: { scrollRestoration: string };
  element: (selector: string) => StubElement;
  fireDocument: (type: string, event?: { key?: string }) => void;
  setHidden: (hidden: boolean) => void;
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
  const documentListeners = new Map<string, Array<(event?: { key?: string }) => void>>();
  const classes = new Set<string>();
  const timers = new Map<number, () => void>();
  const fetches: string[] = [];
  let nextTimer = 1;
  let reloads = 0;
  const history = { scrollRestoration: "manual" };
  class StubDomParser {
    parseFromString(text: string): {
      querySelector: (selector: string) => { getAttribute: (name: string) => string | null } | null;
    } {
      const attribute = /srcdoc="([^"]*)"/.exec(text)?.[1];
      const value = attribute === undefined ? null : unescapeAttribute(attribute);
      return {
        querySelector: (selector: string) =>
          selector === "iframe" && value !== null
            ? { getAttribute: (name: string) => (name === "srcdoc" ? value : null) }
            : null,
      };
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
    addEventListener: (type: string, handler: (event?: { key?: string }) => void): void => {
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
        location: locationStub,
        history,
        fetch: fetchStub,
        setInterval: setIntervalStub,
        clearInterval: clearIntervalStub,
        DOMParser: StubDomParser,
      });
    },
    tick: (): void => {
      for (const handler of Array.from(timers.values())) handler();
    },
    intervals: (): number => timers.size,
    fetches,
    reloads: (): number => reloads,
    history,
    element: elementOf,
    fireDocument: (type: string, event?: { key?: string }): void => {
      for (const handler of Array.from(documentListeners.get(type) ?? [])) handler(event);
    },
    setHidden: (hidden: boolean): void => {
      documentStub.hidden = hidden;
    },
  };
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const json = (body: unknown): StubResponse => ({ ok: true, json: async () => body });
const html = (body: string): StubResponse => ({ ok: true, text: async () => body });
const refused: StubResponse = { ok: false };

const ownerPage = (): string =>
  wrapperPage(escapeAttribute(BYTES), "/", { title: "T", version: 3 }, false, OWNER_REFRESH);
const sharePage = (): string => wrapperPage(escapeAttribute(BYTES), undefined, undefined, false, SHARE_REFRESH);

test("a changed revision re-reads the gated page and swaps the frame document without a reload", async () => {
  const freshPage = wrapperPage(escapeAttribute(FRESH_BYTES), "/", { title: "T", version: 4 }, false, OWNER_REFRESH);
  const environment = makeEnvironment({
    selectors: [".vbar-focus", ".vbar-exit", ".vbar-version", "iframe"],
    respond: (url) =>
      url === OWNER_REFRESH.metaUrl
        ? json({ revision: { revisionNumber: 4, sha256: "def" } })
        : url === OWNER_REFRESH.srcdocUrl
          ? html(freshPage)
          : refused,
  });
  const frame = environment.element("iframe");
  frame.setAttribute("srcdoc", BYTES);
  const scroller = {
    scrollY: 240,
    calls: [] as number[][],
    scrollTo(x: number, y: number) {
      this.calls.push([x, y]);
    },
  };
  frame.contentWindow = scroller;

  environment.run(refreshScriptOf(ownerPage()));
  environment.tick();
  await settle();

  assert.deepEqual(environment.fetches, [OWNER_REFRESH.metaUrl, OWNER_REFRESH.srcdocUrl], "metadata first, then bytes");
  assert.equal(environment.reloads(), 0, "the owner HTML viewer never reloads the page");
  assert.equal(frame.getAttribute("srcdoc"), FRESH_BYTES, "the frame receives the fresh bytes byte-for-byte");
  assert.equal(environment.element(".vbar-version").textContent, "v4", "the badge moves through textContent");
  frame.dispatch("load");
  assert.deepEqual(scroller.calls, [[0, 240]], "the frame offset is restored best-effort");
});

test("an unchanged revision touches neither the document nor the page", async () => {
  const environment = makeEnvironment({
    selectors: [".vbar-focus", ".vbar-exit", ".vbar-version", "iframe"],
    respond: (url) =>
      url === OWNER_REFRESH.metaUrl ? json({ revision: { revisionNumber: 3, sha256: "aaa" } }) : refused,
  });
  const frame = environment.element("iframe");
  frame.setAttribute("srcdoc", BYTES);
  environment.run(refreshScriptOf(ownerPage()));
  environment.tick();
  await settle();

  assert.deepEqual(environment.fetches, [OWNER_REFRESH.metaUrl], "no document read on an unchanged revision");
  assert.equal(frame.getAttribute("srcdoc"), BYTES);
  assert.equal(environment.element(".vbar-version").textContent, null);
  assert.equal(environment.reloads(), 0);
});

test("a failed or refused metadata read changes nothing and keeps polling", async () => {
  const environment = makeEnvironment({
    selectors: ["iframe"],
    respond: () => refused,
  });
  environment.run(refreshScriptOf(ownerPage()));
  environment.tick();
  await settle();
  assert.deepEqual(environment.fetches, [OWNER_REFRESH.metaUrl]);
  assert.equal(environment.element("iframe").getAttribute("srcdoc"), null);
  assert.equal(environment.intervals(), 1, "the timer survives a refusal");
});

test("polling pauses while the page is hidden and resumes with an immediate read", async () => {
  const environment = makeEnvironment({
    selectors: ["iframe"],
    hidden: true,
    respond: (url) =>
      url === OWNER_REFRESH.metaUrl ? json({ revision: { revisionNumber: 3, sha256: "aaa" } }) : refused,
  });
  environment.run(refreshScriptOf(ownerPage()));
  assert.equal(environment.intervals(), 0, "a hidden page schedules no poll");
  assert.deepEqual(environment.fetches, []);

  environment.setHidden(false);
  environment.fireDocument("visibilitychange");
  assert.equal(environment.intervals(), 1);
  await settle();
  assert.deepEqual(environment.fetches, [OWNER_REFRESH.metaUrl], "resuming reads immediately");

  environment.setHidden(true);
  environment.fireDocument("visibilitychange");
  assert.equal(environment.intervals(), 0, "hiding the page clears the timer");
  environment.tick();
  assert.deepEqual(environment.fetches, [OWNER_REFRESH.metaUrl], "a paused page polls nothing");
});

test("the public share page reloads on a change in the four-field projection", async () => {
  const environment = makeEnvironment({
    selectors: ["iframe"],
    respond: () => json({ revisionNumber: 3, sha256: "ccc", sizeBytes: 42, kind: "html" }),
  });
  environment.run(refreshScriptOf(sharePage()));
  environment.tick();
  await settle();

  assert.deepEqual(environment.fetches, [SHARE_REFRESH.metaUrl], "the public surface has no byte endpoint to read");
  assert.equal(environment.reloads(), 1, "the page reload is the public fallback");
  assert.equal(environment.history.scrollRestoration, "auto", "best-effort scroll restoration is requested first");
});

test("an embed=1 page runs the same poller without a bar to attach to", async () => {
  const page = wrapperPage(escapeAttribute(BYTES), undefined, undefined, true, OWNER_REFRESH);
  assert.equal(page.includes("<header"), false, "embed mode renders no bar");
  const environment = makeEnvironment({
    selectors: ["iframe"],
    respond: (url) =>
      url === OWNER_REFRESH.metaUrl ? json({ revision: { revisionNumber: 3, sha256: "aaa" } }) : refused,
  });
  assert.doesNotThrow(() => environment.run(refreshScriptOf(page)), "no missing-element throw in embed mode");
  environment.tick();
  await settle();
  assert.deepEqual(environment.fetches, [OWNER_REFRESH.metaUrl], "the poller runs in embed mode");

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

test("the markdown page keeps its own policy and the fragment can only add text", () => {
  assert.equal(/img-src/.test(VIEWER_CSP), false, "the response policy grants no image source");
  assert.match(VIEWER_CSP, /^default-src 'none'/, "img-src therefore falls back to default-src 'none'");
  assert.equal(VIEWER_CSP.includes("data:"), false);
  assert.equal(VIEWER_CSP.includes("https:"), false);

  const markdown = markdownViewerPage(
    renderMarkdownFragment("![alt](https://example.com/a.png)"),
    "/",
    { title: "T", version: 1 },
    false,
    { metaUrl: "/api/artifacts/1111", revisionNumber: 1, sha256: "bbb" },
  );
  const meta = /content-security-policy" content="([^"]*)"/.exec(markdown)?.[1] ?? "";
  assert.equal(meta.includes("img-src data: https:"), true, "the page's own allowance stays on the page");
  assert.equal(
    meta.includes("frame-src"),
    false,
    "the page needs no frame source, so frames stay at default-src 'none'",
  );
  assert.match(markdown, /<img src="https:\/\/example\.com\/a\.png"/, "markdown images still render");
  assert.equal(/onerror=/i.test(markdown), false, "the escaped fragment cannot attach handlers");
  assert.equal(renderMarkdownFragment("<img src=x onerror=alert(1)>").includes("<img"), false);
});

test("the public share 200s both spread the widened viewer headers", () => {
  const source = readFileSync(new URL("../apps/api/src/routes/sharing.ts", import.meta.url), "utf8");
  assert.equal([...source.matchAll(/\.\.\.VIEWER_HEADERS/g)].length, 2, "exactly the two share 200 responses");
  assert.equal(source.includes("WRAPPER_CSP"), false, "the share viewer never serves the narrow policy");
  assert.equal(
    [...source.matchAll(/"x-robots-tag": "noindex"/g)].length,
    4,
    "both served pages stay unindexable, as do the ?meta=1 projection and the link comments",
  );
  assert.equal([...source.matchAll(/markdownViewerPage\(/g)].length, 1, "the markdown share page is one of them");
  assert.equal([...source.matchAll(/wrapperPage\(/g)].length, 1, "and the HTML share page is the other");
});
