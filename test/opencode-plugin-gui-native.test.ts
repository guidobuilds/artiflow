import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import test, { before } from "node:test";

const run = promisify(execFile);
const pluginDir = fileURLToPath(new URL("../plugins/opencode", import.meta.url));
const guiBundle = fileURLToPath(new URL("../plugins/opencode/dist/gui-experimental.cjs", import.meta.url));

before(async () => {
  if (!existsSync(guiBundle)) await run("npm", ["run", "build"], { cwd: pluginDir });
});

function host() {
  const definitions = new Map<string, unknown>();
  const opens: unknown[] = [];
  const viewerOpens: unknown[] = [];
  const disposed: unknown[] = [];
  const persisted = {
    value: { mode: "grid" },
    set(value: { mode: string }) {
      this.value = value;
    },
  };
  const session = { key: "server:session", id: "s", server: { builtin: true, connected: true } };
  let written: (event: unknown) => void = () => {};
  const entries = [{ artifactId: "a", title: "Alpha", kind: "html", at: new Date().toISOString(), action: "created" }];
  const bridge = {
    config: async () => ({ base: "https://a.example", error: null }),
    open: async (input: unknown) => {
      viewerOpens.push(input);
      return "embed";
    },
    dispose: async (input: unknown) => {
      disposed.push(input);
    },
    state: () => ({ views: [] }),
    show: async () => {},
  };
  const context = {
    id: "artiflow",
    signal: new AbortController().signal,
    main: () => bridge,
    storage: {
      store: (key: string) => {
        assert.equal(key, "index-layout");
        return persisted;
      },
    },
    client: {
      rpc: () => ({
        "associated.list": async () => entries,
        "viewer.token": async () => "access",
        events: {
          on: (_name: string, callback: typeof written) => {
            written = callback;
            return () => {};
          },
        },
      }),
    },
    sessions: { list: () => [session] },
    layout: {
      open: (...args: unknown[]) => {
        opens.push(args);
      },
    },
    toast: { show: () => {} },
    system: { openExternal: async () => {} },
    ui: { Icon: () => {} },
    embeds: { View: () => {} },
    add: (kind: string, definition: unknown) => {
      definitions.set(kind, definition);
    },
  };
  const solid = {
    createSignal: (initial: unknown) => {
      let value = initial;
      return [
        () => value,
        (next: unknown) => {
          value = typeof next === "function" ? next(value) : next;
        },
      ];
    },
    createResource: (load: () => Promise<unknown>) => {
      let value: unknown;
      void load().then((result) => {
        value = result;
      });
      return [() => value];
    },
    createEffect: (effect: () => void) => effect(),
    createMemo: <T>(memo: () => T) => memo,
    onCleanup: () => {},
    untrack: <T>(fn: () => T) => fn(),
    Show: "Show",
    For: "For",
  };
  const schema = new Proxy(
    {},
    {
      get:
        () =>
        (..._args: unknown[]) => ({}),
    },
  );
  const exports = {} as { default: { setup: (context: unknown) => void } };
  runInNewContext(readFileSync(new URL("../plugins/opencode/dist/gui-experimental.cjs", import.meta.url), "utf8"), {
    exports,
    URL,
    console,
    require(name: string) {
      if (name === "solid-js/web")
        return {
          template: () => () => ({}),
          delegateEvents: () => {},
          createComponent: (component: unknown, props: unknown) => ({ component, props }),
        };
      if (name === "solid-js") return solid;
      if (name === "effect") return { Schema: schema };
      if (name === "@opencode/plugin/gui")
        return {
          Plugin: { define: (definition: unknown) => definition },
          Ipc: { define: (definition: unknown) => definition },
          Command: "Command",
          Panel: "Panel",
          SettingsPage: "SettingsPage",
          usePlugin: () => context,
          usePanel: () => ({ visible: () => true }),
        };
      if (["electron", "node:crypto", "node:path"].includes(name)) return {};
      throw new Error(`Unexpected module ${name}`);
    },
  });
  (exports.default as { setup: (context: unknown) => void }).setup(context);
  const panel = definitions.get("Panel") as {
    list: (input: unknown) => unknown[];
    focus: (input: unknown) => unknown;
    restore: (input: unknown) => unknown;
    closed: (input: unknown) => unknown;
    render: (input: unknown) => unknown;
  };
  const input = (id: string) => ({ session: { ...session }, tab: { id, title: "Alpha" }, screen: {} });
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return {
    panel,
    input,
    session,
    opens,
    viewerOpens,
    disposed,
    persisted,
    flush,
    write: (artifactId: string) =>
      written({ data: { sessionID: "s", artifactId, title: artifactId, action: "updated" } }),
  };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("built GUI calls host select once for new writes, but reloads existing tabs without any layout call", async () => {
  const h = host();
  h.panel.list({ session: h.session, screen: {}, open: ["artifact:a"] });
  h.write("a");
  await h.flush();
  assert.equal(h.opens.length, 0);
  assert.deepEqual(plain(h.viewerOpens), [
    { key: '["server:session","artifact:a"]', artifactId: "a", token: "access", reload: true },
  ]);
  h.write("new");
  await h.flush();
  assert.equal(h.opens.length, 1);
  assert.deepEqual(plain(h.opens[0]), ["artiflow:artifact:new", h.session, { tab: "select", background: true }]);
  assert.equal(h.viewerOpens.length, 1);
});

test("built panel reconstructs stable native tabs from keys and closes/restores through the host", async () => {
  const h = host();
  h.panel.focus(h.input("index"));
  await h.flush();
  const tabs = h.panel.list({ session: { ...h.session }, screen: {}, open: ["artifact:a"] });
  assert.deepEqual(
    plain(
      tabs.map((raw: unknown) => {
        const tab = raw as { id: string; title: string; pinned: boolean; closable: boolean; group: string };
        return {
          id: tab.id,
          title: tab.title,
          pinned: tab.pinned,
          closable: tab.closable,
          group: tab.group,
        };
      }),
    ),
    [
      { id: "index", title: "Artifacts", pinned: true, closable: false, group: "artifacts" },
      { id: "artifact:a", title: "Alpha", closable: "hover", group: "artifacts" },
    ],
  );
  assert.equal(typeof (tabs[1] as { label?: unknown }).label, "function");
  assert.equal(h.panel.list({ session: { ...h.session }, screen: {}, open: ["artifact:a"] })[1], tabs[1]);
  assert.deepEqual(plain(h.panel.closed(h.input("artifact:a"))), { title: "Alpha", icon: "globe", data: "a" });
  assert.deepEqual(plain(h.disposed), [{ key: '["server:session","artifact:a"]' }]);
  h.panel.restore({ ...h.input("artifact:a"), id: "artifact:a", data: "a" });
  assert.deepEqual(plain(h.opens), [["artiflow:artifact:a", h.session, { tab: "select" }]]);
  assert.equal(h.panel.closed(h.input("index")), false);
});

test("index persists layout, opens cards via host select, and never requests an embed", async () => {
  const h = host();
  const render = h.panel.render(h.input("index")) as {
    props: { fallback: { props: { mode: string; onMode: (m: string) => void; onOpen: (id: unknown) => void } } };
  };
  const index = render.props.fallback;
  assert.equal(index.props.mode, "grid");
  index.props.onMode("list");
  assert.deepEqual(plain(h.persisted.value), { mode: "list" });
  assert.equal(index.props.mode, "list");
  index.props.onOpen({ artifactId: "a" });
  index.props.onOpen({ artifactId: "a" });
  assert.deepEqual(plain(h.opens), [
    ["artiflow:artifact:a", h.session, { tab: "select" }],
    ["artiflow:artifact:a", h.session, { tab: "select" }],
  ]);
  await h.flush();
  assert.equal(h.viewerOpens.length, 0);
});
