import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { guiConfig } from "../plugins/opencode/src/gui-core.ts";
import { ViewerAuth, viewerHeaders } from "../plugins/opencode/src/gui-auth.ts";
import { createArtifactWatcher } from "../plugins/opencode/src/freshness.ts";

const md = (artifactId: string, revisionNumber: number, sha256: string) => ({
  artifactId,
  revisionId: `rev-${revisionNumber}`,
  revisionNumber,
  kind: "markdown",
  sha256,
  sizeBytes: 12,
});

const settle = async () => {
  for (let turn = 0; turn < 6; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function host(
  onCreate?: () => void,
  loadError?: Error,
  metadata?: (artifactId: string, options: { base: string; token: string }) => Promise<unknown>,
) {
  const instances: FakeView[] = [];
  class FakeView {
    bounds?: object;
    embed?: { id: string; visible: boolean; disposed: boolean; show(visible: boolean): void; dispose(): void };
    webContents = Object.assign(new EventEmitter(), {
      loads: [] as { url: string; options?: object }[],
      closed: false,
      stops: 0,
      loadURL(url: string, options?: object) {
        this.loads.push({ url, options });
        return loadError ? Promise.reject(loadError) : Promise.resolve();
      },
      isDestroyed() {
        return this.closed;
      },
      close() {
        this.closed = true;
      },
      stop() {
        this.stops++;
      },
      setWindowOpenHandler(_handler: unknown) {},
    });
    constructor(_options: unknown) {
      instances.push(this);
    }
    setBounds(bounds: object) {
      this.bounds = bounds;
    }
  }
  const source = readFileSync(new URL("../plugins/opencode/src/gui-main.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace("export const main", "const main");
  const setup = compileFunction(`${stripTypeScriptTypes(source)}\nreturn main;`, [
    "WebContentsView",
    "guiConfig",
    "viewerHeaders",
    "ViewerAuth",
    "Views",
    "createArtifactApi",
    "createArtifactWatcher",
  ]);
  type Api = { [key: string]: (...args: unknown[]) => unknown } & {
    open: (input: unknown, caller: unknown) => unknown;
    show: (input: unknown, caller: unknown) => unknown;
    state: (id: number) => { views: { authRequired: boolean; tokenUnavailable: boolean }[] };
  };
  let api: Api = undefined as unknown as Api;
  const windows = new EventEmitter() as EventEmitter & { get(id: number): { id: number } };
  windows.get = (id) => ({ id });
  const changes: number[] = [];
  const logs: unknown[] = [];
  const calls: { artifactId: string; token: string }[] = [];
  const readMetadata =
    metadata ??
    (async (artifactId: string) => md(artifactId, 1, "bytes-A"));
  const artifactApi = (options: { base: string; token: string; signal?: AbortSignal }) => ({
    async metadata(input: { artifactId: string }) {
      calls.push({ artifactId: input.artifactId, token: options.token });
      return readMetadata(input.artifactId, options);
    },
  });
  const cleanup = setup(
    FakeView,
    guiConfig,
    viewerHeaders,
    ViewerAuth,
    {},
    artifactApi,
    createArtifactWatcher,
  )({
    options: { url: "https://a.example" },
    windows,
    embeds: {
      create(view: FakeView) {
        const notify = onCreate;
        onCreate = undefined;
        notify?.();
        const embed = {
          id: `e${instances.length}`,
          visible: false,
          disposed: false,
          show(visible: boolean) {
            this.visible = visible;
          },
          dispose() {
            this.disposed = true;
          },
        };
        view.embed = embed;
        return embed;
      },
    },
    log: {
      write(...args: unknown[]) {
        logs.push(args);
      },
    },
    provide(_definition: unknown, methods: Api) {
      api = methods;
      return {
        changed(window: number) {
          changes.push(window);
        },
      };
    },
  });
  const caller = { window: 1, signal: new AbortController().signal };
  const open = (key: string, artifactId = "a", reload = false, token: string | null = "access") =>
    api.open({ key, artifactId, reload, token }, caller);
  return { api, open, instances, caller, cleanup, windows, changes, logs, calls };
}

test("main keeps one embed per session/tab/window; update reloads only that view in place", async () => {
  const h = host();
  try {
    const a = await h.open("s:artifact:a");
    const b = await h.open("s:artifact:b", "b");
    assert.equal(await h.open("s:artifact:a"), a);
    assert.equal(h.instances.length, 2);
    assert.equal(h.instances[0]!.webContents.loads.length, 1);
    assert.equal(await h.open("s:artifact:a", "a", true, "fresh"), a);
    assert.equal(h.instances[0]!.webContents.loads.length, 2);
    assert.equal(h.instances[1]!.webContents.loads.length, 1);
    assert.deepEqual(h.instances[0]!.webContents.loads[1], {
      url: "https://a.example/artifact/a?embed=1",
      options: { extraHeaders: "Authorization: Bearer fresh" },
    });
    assert.notEqual(await h.open("other:artifact:a"), a);
    assert.notEqual(
      await h.api.open(
        { key: "s:artifact:a", artifactId: "a", reload: false, token: "access" },
        { ...h.caller, window: 2 },
      ),
      a,
    );
    assert.equal(h.api.state(1).views.length, 3);
    assert.equal(h.api.state(2).views.length, 1);
    assert.notEqual(a, b);
  } finally {
    h.cleanup();
  }
});

test("native visibility requires both renderer visibility and successful HTTP status, independently per embed", async () => {
  const h = host();
  try {
    const a = await h.open("s:a");
    const b = await h.open("s:b", "b");
    const first = h.instances[0]!;
    const second = h.instances[1]!;
    assert.equal(first.embed!.visible, false);
    h.api.show({ id: a, visible: true }, h.caller);
    assert.equal(first.embed!.visible, false);
    first.webContents.emit("did-navigate", {}, "https://a.example/artifact/a?embed=1", 200);
    assert.equal(first.embed!.visible, true);
    second.webContents.emit("did-navigate", {}, "https://a.example/artifact/b?embed=1", 200);
    assert.equal(second.embed!.visible, false);
    h.api.show({ id: a, visible: false }, h.caller);
    h.api.show({ id: b, visible: true }, h.caller);
    assert.equal(first.embed!.visible, false);
    assert.equal(second.embed!.visible, true);
    second.webContents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://a.example/artifact/b",
    });
    assert.equal(second.embed!.visible, false);
    second.webContents.emit("did-navigate", {}, "https://a.example/artifact/b", 401);
    assert.equal(second.embed!.visible, false);
    assert.equal(h.api.state(1).views[1]!.authRequired, true);
    assert.ok(h.logs.length >= 3);
  } finally {
    h.cleanup();
  }
});

test("closing disposes only the matching tab and restore creates a fresh embed; window close cleans up", async () => {
  const h = host();
  try {
    const old = await h.open("s:a");
    await h.open("s:b", "b");
    h.api.dispose!({ key: "s:a" }, { ...h.caller, window: 2 });
    assert.equal(h.instances[0]!.webContents.closed, false);
    h.api.dispose!({ key: "s:a" }, h.caller);
    assert.equal(h.instances[0]!.embed!.disposed, true);
    assert.equal(h.instances[0]!.webContents.closed, true);
    assert.equal(h.instances[1]!.webContents.closed, false);
    assert.equal(h.api.state(1).views.length, 1);
    assert.notEqual(await h.open("s:a"), old);
    h.windows.emit("close", { id: 1 });
    assert.equal(h.api.state(1).views.length, 0);
    assert.ok(h.instances.every((view) => view.webContents.closed));
  } finally {
    h.cleanup();
  }
});

test("off-origin navigation is blocked except during explicit OAuth fallback", async () => {
  const h = host();
  try {
    const id = await h.open("s:a");
    const wc = h.instances[0]!.webContents;
    let prevented = 0;
    const event = {
      preventDefault() {
        prevented++;
      },
    };
    wc.emit("will-navigate", event, "https://a.example/artifact/a");
    assert.equal(prevented, 0);
    wc.emit("will-navigate", event, "https://other.example/");
    wc.emit("will-redirect", event, "https://other.example/");
    assert.equal(prevented, 2);
    wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "https://other.example/" });
    assert.equal(wc.stops, 1);
    h.api.signIn!({ id }, h.caller);
    wc.emit("will-navigate", event, "https://provider.example/");
    assert.equal(prevented, 2);
    assert.equal(wc.loads.at(-1)?.url, "https://a.example/login?return=%2Fartifact%2Fa%3Fembed%3D1");
  } finally {
    h.cleanup();
  }
});

test("concurrent main opens coalesce by key and window and honor a waiting reload", async () => {
  const h = host();
  try {
    const first = h.open("s:a");
    const second = h.open("s:a");
    const reload = h.open("s:a", "a", true, "fresh");
    const [a, b, c] = await Promise.all([first, second, reload]);
    assert.equal(a, b);
    assert.equal(a, c);
    assert.equal(h.instances.length, 1);
    assert.equal(h.instances[0]!.webContents.loads.length, 2);
    assert.deepEqual(h.instances[0]!.webContents.loads[1], {
      url: "https://a.example/artifact/a?embed=1",
      options: { extraHeaders: "Authorization: Bearer fresh" },
    });
    assert.equal(h.api.state(1).views.length, 1);
  } finally {
    h.cleanup();
  }
});

test("main reserves an in-flight key before host embed creation can reenter open", async () => {
  let nested: Promise<string> | undefined;
  const h = host(() => {
    nested = h.open("s:a") as Promise<string>;
  });
  try {
    const id = await h.open("s:a");
    assert.equal(await nested, id);
    assert.equal(h.instances.length, 1);
    assert.equal(h.instances[0]!.webContents.loads.length, 1);
  } finally {
    h.cleanup();
  }
});

test("superseded main-frame ERR_ABORTED is informational and does not change viewer state", async () => {
  const h = host();
  try {
    const id = await h.open("s:a");
    const wc = h.instances[0]!.webContents;
    h.api.show({ id, visible: true }, h.caller);
    wc.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://a.example/artifact/a?embed=1",
    });
    const loading = h.api.state(1);
    wc.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://a.example/", true);
    assert.deepEqual(h.api.state(1), loading);
    wc.emit("did-navigate", {}, "https://a.example/artifact/a?embed=1", 200);
    const ready = h.api.state(1);
    wc.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://a.example/", true);
    assert.deepEqual(h.api.state(1), ready);
    assert.deepEqual(ready.views[0], {
      id,
      authRequired: false,
      notFound: false,
      ready: true,
      viewing: true,
      tokenUnavailable: false,
    });
    assert.equal(h.instances[0]!.embed!.visible, true);
    assert.ok(h.logs.some((log) => Array.isArray(log) && log[0] === "info" && String(log[1]).includes("superseded")));
    assert.ok(!h.logs.some((log) => Array.isArray(log) && log[0] === "warn"));
  } finally {
    h.cleanup();
  }
});

test("main clears rejected opens and separates concurrent windows and keys", async () => {
  const h = host();
  try {
    const aborted = { ...h.caller, signal: AbortSignal.abort() } as typeof h.caller;
    await assert.rejects(
      () => h.api.open({ key: "s:a", artifactId: "a", reload: false, token: "access" }, aborted) as Promise<unknown>,
      /Artiflow window unavailable/,
    );
    assert.equal(h.instances.length, 0);
    assert.deepEqual(h.api.state(1).views, []);
    const [first, otherKey, otherWindow] = await Promise.all([
      h.open("s:a"),
      h.open("s:b", "b"),
      h.api.open({ key: "s:a", artifactId: "a", reload: false, token: "access" }, { ...h.caller, window: 2 }),
    ]);
    assert.equal(new Set([first, otherKey, otherWindow]).size, 3);
    assert.equal(h.instances.length, 3);
    assert.equal(h.api.state(1).views.length, 2);
    assert.equal(h.api.state(2).views.length, 1);
  } finally {
    h.cleanup();
  }
});

test("ERR_ABORTED loadURL rejections remain informational and do not set viewer errors", async () => {
  const h = host(undefined, Object.assign(new Error("ERR_ABORTED"), { errno: -3, code: "ERR_ABORTED" }));
  try {
    const id = await h.open("s:a");
    const wc = h.instances[0]!.webContents;
    wc.emit("did-navigate", {}, "https://a.example/artifact/a?embed=1", 200);
    assert.deepEqual(h.api.state(1).views[0], {
      id,
      authRequired: false,
      notFound: false,
      ready: true,
      viewing: true,
      tokenUnavailable: false,
    });
    assert.ok(h.logs.some((log) => Array.isArray(log) && log[0] === "info" && String(log[1]).includes("superseded")));
    assert.ok(!h.logs.some((log) => Array.isArray(log) && log[0] === "warn"));
  } finally {
    h.cleanup();
  }
});

test("a reload without a credential stops freshness and publishes an actionable sign-in state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = host();
  try {
    const id = await h.open("s:a");
    h.api.show({ id, visible: true }, h.caller);
    await settle();
    const wc = h.instances[0]!.webContents;
    assert.equal(wc.loads.length, 1);
    const polls = h.calls.length;
    assert.equal(h.api.state(1).views[0]!.tokenUnavailable, false);

    assert.equal(await h.open("s:a", "a", true, null), id);
    assert.equal(wc.loads.length, 1);
    assert.equal(h.instances[0]!.embed!.visible, false);
    assert.equal(h.api.state(1).views[0]!.tokenUnavailable, true);
    assert.equal(h.api.state(1).views[0]!.authRequired, true);
    assert.ok(
      h.logs.some((log) => Array.isArray(log) && log[0] === "warn" && String(log[1]).includes("no credential")),
    );

    t.mock.timers.tick(8_000);
    await settle();
    assert.equal(h.calls.length, polls, "a credential-less viewer polls nothing");

    assert.equal(await h.open("s:a", "a", true, "fresh"), id);
    assert.equal(wc.loads.length, 2);
    assert.deepEqual(wc.loads[1]!.options, { extraHeaders: "Authorization: Bearer fresh" });
    assert.equal(h.api.state(1).views[0]!.tokenUnavailable, false);
    assert.equal(h.api.state(1).views[0]!.authRequired, false);
  } finally {
    h.cleanup();
  }
});

test("missing-token fallback does not load a raw unauthorized page; a later write can authenticate", async () => {
  const h = host();
  try {
    const id = await h.open("s:a", "a", false, null);
    assert.equal(h.instances[0]!.webContents.loads.length, 0);
    assert.equal(h.api.state(1).views[0]!.authRequired, true);
    assert.equal(h.api.state(1).views[0]!.tokenUnavailable, true);
    assert.equal(await h.open("s:a", "a", true, "fresh"), id);
    assert.equal(h.instances[0]!.webContents.loads.length, 1);
    assert.equal(h.api.state(1).views[0]!.authRequired, false);
  } finally {
    h.cleanup();
  }
});

test("host freshness reloads the viewer once per byte change and pauses while it is hidden", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed = [md("a", 1, "bytes-A"), md("a", 1, "bytes-A"), md("a", 2, "bytes-B"), md("a", 2, "bytes-B")];
  const h = host(undefined, undefined, async () => observed.shift() ?? md("a", 2, "bytes-B"));
  try {
    const id = await h.open("s:a");
    await settle();
    const wc = h.instances[0]!.webContents;
    assert.equal(wc.loads.length, 1);
    assert.deepEqual(h.calls, [{ artifactId: "a", token: "access" }]);

    h.api.show({ id, visible: true }, h.caller);
    await settle();
    assert.equal(wc.loads.length, 1);

    t.mock.timers.tick(8_000);
    await settle();
    assert.equal(wc.loads.length, 2);
    assert.equal(wc.loads[1]!.url, "https://a.example/artifact/a?embed=1");
    assert.deepEqual(wc.loads[1]!.options, { extraHeaders: "Authorization: Bearer access" });
    assert.ok(wc.loads.every((load) => !load.url.includes("access")));

    t.mock.timers.tick(8_000);
    await settle();
    assert.equal(wc.loads.length, 2);

    const polls = h.calls.length;
    h.api.show({ id, visible: false }, h.caller);
    t.mock.timers.tick(8_000);
    await settle();
    assert.equal(h.calls.length, polls);

    h.api.show({ id, visible: true }, h.caller);
    await settle();
    assert.equal(h.calls.length, polls + 1);
  } finally {
    h.cleanup();
  }
});

test("an unauthenticated viewer and a disposed tab poll nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = host();
  try {
    const id = await h.open("s:a", "a", false, null);
    h.api.show({ id, visible: true }, h.caller);
    await settle();
    t.mock.timers.tick(8_000);
    await settle();
    assert.deepEqual(h.calls, []);

    const authed = await h.open("s:b", "b", false, "access");
    h.api.show({ id: authed, visible: true }, h.caller);
    await settle();
    assert.deepEqual(h.calls, [{ artifactId: "b", token: "access" }]);
    h.api.dispose!({ key: "s:b" }, h.caller);
    t.mock.timers.tick(8_000);
    await settle();
    assert.equal(h.calls.length, 1);
  } finally {
    h.cleanup();
  }
});

test("a renderer reload rebases the freshness base instead of reloading the page twice", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let current = md("a", 1, "bytes-A");
  const h = host(undefined, undefined, async () => current);
  try {
    const id = await h.open("s:a");
    await settle();
    h.api.show({ id, visible: true }, h.caller);
    await settle();
    const wc = h.instances[0]!.webContents;
    assert.equal(wc.loads.length, 1);

    current = md("a", 2, "bytes-B");
    assert.equal(await h.open("s:a", "a", true, "fresh"), id);
    await settle();
    assert.equal(wc.loads.length, 2);
    t.mock.timers.tick(8_000);
    await settle();
    assert.equal(wc.loads.length, 2);
  } finally {
    h.cleanup();
  }
});
