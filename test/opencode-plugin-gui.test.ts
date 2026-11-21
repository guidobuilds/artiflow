import assert from "node:assert/strict";
import test from "node:test";
import { guiConfig, libraryUrl, guiViewUrl, relativeTime, matchingSession } from "../plugins/opencode/src/gui-core.ts";
import { viewerUrl } from "@artiflow/plugin-core/core";
import { DisplayedArtifacts } from "../plugins/opencode/src/gui-display.ts";
import type { Association } from "@artiflow/plugin-core/associations";
import { readFileSync } from "node:fs";
import { artifactIcon, recentWrite } from "../plugins/opencode/src/gui-tab-model.ts";

const entry = (artifactId: string, title?: string): Association => ({
  artifactId,
  ...(title ? { title } : {}),
  at: "2026-11-08T12:00:00Z",
  action: "created",
});
const source = (name: string) => readFileSync(new URL(`../plugins/opencode/src/${name}`, import.meta.url), "utf8");

test("kind icons and recent activity retain old association fallbacks", () => {
  assert.equal(artifactIcon("html"), "globe");
  assert.equal(artifactIcon("markdown"), "file-document");
  for (const kind of [undefined, "pptx", "constructor"]) assert.equal(artifactIcon(kind), "stop");
  const row = entry("a");
  const now = Date.parse(row.at);
  assert.equal(recentWrite(row, undefined, now), true);
  assert.equal(recentWrite(row, row.at, now), false);
  assert.equal(recentWrite(row, undefined, now + 180_000), false);
  assert.equal(recentWrite(row, undefined, now - 1), false);
});

test("native tab cache always lists pinned index and reconstructs open tabs, including missing ids", async () => {
  const displayed = new DisplayedArtifacts(
    async () => [entry("a", "First")],
    () => {},
  );
  await displayed.refresh("s", "id");
  const tabs = displayed.tabs("s", ["artifact:a", "artifact:missing", "unrelated"]);
  assert.deepEqual(
    tabs.map(({ id, title, pinned, closable, group, missing }) => ({ id, title, pinned, closable, group, missing })),
    [
      { id: "index", title: "Artifacts", pinned: true, closable: false, group: "artifacts", missing: undefined },
      { id: "artifact:a", title: "First", pinned: undefined, closable: "hover", group: "artifacts", missing: false },
      {
        id: "artifact:missing",
        title: "missing",
        pinned: undefined,
        closable: "hover",
        group: "artifacts",
        missing: true,
      },
    ],
  );
  assert.equal(displayed.tabs("s", ["artifact:a"])[1], tabs[1]);
  await displayed.refresh("s", "id");
  assert.equal(displayed.tabs("s", ["artifact:a"])[1], tabs[1]);
  assert.deepEqual(
    displayed.tabs("other", []).map((tab) => tab.id),
    ["index"],
  );
  assert.equal(displayed.isOpen("s", "a"), true);
  displayed.tabs("s", []);
  assert.equal(displayed.isOpen("s", "a"), false);
});

test("writes merge association metadata per session and report open status without deciding selection", async () => {
  const displayed = new DisplayedArtifacts(
    async () => [{ ...entry("a", "First"), kind: "html" }, entry("b")],
    () => {},
  );
  await displayed.refresh("s", "id");
  displayed.tabs("s", ["artifact:a", "artifact:b"]);
  assert.equal(displayed.written("s", { sessionID: "id", artifactId: "a", action: "updated" }), true);
  assert.equal(displayed.entries("s")[0]?.title, "First");
  assert.equal(displayed.entries("s")[0]?.kind, "html");
  assert.equal(displayed.entries("s")[1]?.artifactId, "b");
  assert.equal(displayed.written("s", { sessionID: "id", artifactId: "new", action: "created" }), false);
  assert.deepEqual(displayed.entries("other"), []);
  displayed.close("s", "artifact:a");
  assert.equal(displayed.isOpen("s", "a"), false);
  assert.equal(displayed.entries("s").length, 3);
});

test("stale refreshes cannot replace a live write or newer snapshot", async () => {
  const pending: ((entries: Association[]) => void)[] = [];
  const displayed = new DisplayedArtifacts(
    () => new Promise((resolve) => pending.push(resolve)),
    () => {},
  );
  const first = displayed.refresh("s", "id");
  displayed.written("s", { sessionID: "id", artifactId: "written", action: "updated" });
  pending[0]?.([entry("stale")]);
  await first;
  assert.equal(displayed.entries("s")[0]?.artifactId, "written");
  const second = displayed.refresh("s", "id");
  const third = displayed.refresh("s", "id");
  pending[2]?.([entry("latest")]);
  await third;
  pending[1]?.([entry("stale")]);
  await second;
  assert.equal(displayed.entries("s")[0]?.artifactId, "latest");
});

test("refresh failures preserve associations and empty snapshots do not close host tabs", async () => {
  let fail = true;
  const displayed = new DisplayedArtifacts(
    async () => {
      if (fail) throw new Error("offline");
      return [];
    },
    () => {},
  );
  displayed.written("s", { sessionID: "id", artifactId: "a", action: "created" });
  displayed.tabs("s", ["artifact:a"]);
  await assert.rejects(displayed.refresh("s", "id"), /offline/);
  assert.equal(displayed.entries("s")[0]?.artifactId, "a");
  fail = false;
  await displayed.refresh("s", "id");
  assert.equal(displayed.tabs("s", ["artifact:a"])[1]?.missing, true);
});

test("native wiring uses host select/dedupe, restores closed tabs, and gates artifact-only embeds", () => {
  const gui = source("gui.tsx");
  assert.match(gui, /displayed.tabs\(input.session.key, input.open\)/);
  assert.match(gui, /tab: "select",\s*background: true/);
  assert.match(gui, /if \(alreadyOpen\)/);
  assert.match(gui, /openViewer\(session.key, artifactTabId\(event.data.artifactId\), true\)/);
  assert.match(gui, /closed\(input\)/);
  assert.match(gui, /bridge\.dispose\(/);
  assert.match(gui, /restore\(input\)/);
  assert.match(gui, /ctx.layout.open\(`\$\{ctx.id\}:\$\{input.id\}`, input.session, \{ tab: "select" \}\)/);
  assert.match(gui, /props.tab.id/);
  assert.match(gui, /frame.visible\(\) && \(viewState\(\)\?\.ready \?\? false\)/);
  assert.match(gui, /<ArtifactIndex/);
  assert.match(gui, /<ctx.ui.Icon name=\{artifactIcon/);
  assert.doesNotMatch(gui, /<ArtifactTabs|displayed.current|displayed.select|click to view|click to reopen/);
  const index = source("gui-tabs.tsx");
  assert.match(index, /No artifacts yet in this session/);
  assert.match(index, /grid-template-columns:repeat\(auto-fill,minmax\(160px,1fr\)\)/);
  assert.match(index, /-webkit-line-clamp:2/);
  assert.match(index, /relativeTime/);
  assert.match(index, /recentWrite/);
  assert.doesNotMatch(index, /role="tablist"|⌄ \+/);
  assert.match(gui, /storage.store\("index-layout",/);
  assert.match(gui, /layout.set\(\{ mode \}\)/);
  const main = source("gui-main.ts");
  assert.match(main, /entry.key === input.key/);
  assert.match(main, /existing.load\(input.token\)/);
  assert.match(main, /entry.embed.dispose\(\)/);
  assert.match(main, /will-navigate/);
  assert.match(main, /current.origin !== base/);
  assert.match(main, /guiConfigReader\(/);
});

test("GUI uses normalized options before environment for library and artifact URLs", () => {
  const config = guiConfig({ url: "https://a.example///" }, "https://b.example");
  assert.deepEqual(config, { base: "https://a.example", error: null });
  assert.equal(libraryUrl(config.base!), "https://a.example/library");
  assert.equal(guiViewUrl(config.base!, "id/?#"), "https://a.example/artifact/id%2F%3F%23");
  assert.equal(guiViewUrl(config.base!, "id/?#"), viewerUrl(config.base!, "id/?#"));
});
test("association events match only live sessions on the plugin's server", () => {
  const remote = { id: "s", server: { builtin: false } };
  const local = { id: "s", server: { builtin: true } };
  assert.equal(matchingSession([remote, local], "s"), local);
  assert.equal(matchingSession([remote, local], "other"), undefined);
  assert.equal(matchingSession([remote], "s"), undefined);
});
test("associated artifact times are relative", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(relativeTime("2026-11-08T12:00:00Z", now), "just now");
  assert.equal(relativeTime("2026-11-08T11:58:00Z", now), "2m ago");
  assert.equal(relativeTime("2026-11-08T10:00:00Z", now), "2h ago");
  assert.equal(relativeTime("2026-11-06T12:00:00Z", now), "2d ago");
});
test("GUI environment fallback preserves loopback support", () => {
  assert.deepEqual(guiConfig({}, "http://127.0.0.1:8787/"), { base: "http://127.0.0.1:8787", error: null });
});
test("GUI missing configuration has actionable guidance", () => {
  assert.deepEqual(guiConfig({}, undefined), {
    base: null,
    error:
      'Run /artiflow-setup <origin> in OpenCode, or configure "url" in the Artiflow plugin options or ARTIFLOW_URL in the Desktop environment.',
  });
});
test("GUI rejects invalid explicit options rather than falling back", () => {
  assert.deepEqual(guiConfig({ url: "https://a.example/path" }, "https://b.example"), {
    base: null,
    error:
      "Configure artiflow.url (options.url) or ARTIFLOW_URL with an absolute http(s) origin without credentials, path, query, or fragment.",
  });
});
