import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileFunction } from "node:vm";

import { assetsScripts, resetViewerCommentsAssetCache, viewerActionsAssets } from "../apps/api/src/viewer/assets.ts";
import { artifactView } from "../apps/api/src/viewer/artifact.ts";
import { markdownView, renderMarkdownFragment } from "../apps/api/src/viewer/markdown.ts";
import { managementMenu, type ViewerModel } from "../apps/api/src/viewer/model.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const islandSource = read("../apps/dashboard/src/viewer-actions.tsx");
const menuSource = read("../apps/dashboard/src/components/ui/menu.tsx");
const deleteModalSource = read("../apps/dashboard/src/DeleteModal.tsx");
const librarySource = read("../apps/dashboard/src/LibraryPage.tsx");
const artifactSource = read("../apps/api/src/viewer/artifact.ts");

const exportedPolicy = (source: string, name: string, args: readonly string[]): ((...values: unknown[]) => unknown) => {
  const start = source.indexOf(`export function ${name}(`);
  assert.notEqual(start, -1, `${name} is exported from the actions island`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const at = source[index];
    if (at === "{") depth++;
    else if (at === "}") depth--;
    if (depth !== 0) continue;
    const run = compileFunction(source.slice(open + 1, index), [...args]);
    return (...values: unknown[]) => run(...values);
  }
  throw new Error(`${name} has no body`);
};

const config = { id: "artifact-one", title: "Pricing artifact", kind: "html" };
const bundle = { script: "/assets/viewer-actions.js", styles: [], dev: false };
const noBundle = { script: "", styles: [], dev: false };
const actions = { share: true, delete: true };

const modelOf = (management: ViewerModel["management"]): ViewerModel => ({
  id: "artifact-one",
  kind: "html",
  title: "Pricing artifact",
  revision: { id: "revision-one", number: 3, sha256: "a".repeat(64) },
  audience: { kind: "session", viewerId: "user-owner", access: "owner" },
  chrome: "full",
  backHref: "/",
  meta: { title: "Pricing artifact", version: 3 },
  embed: false,
  actions: { comment: true, resolve: true, deleteOwn: true, deleteAny: true },
  management,
  comments: { kind: "none" },
  refresh: { plan: { kind: "none" }, revisionNumber: 3, sha256: "a".repeat(64) },
});

const pageOf = (management: ViewerModel["management"]): string =>
  artifactView(modelOf(management), { srcdoc: "<p>x</p>" }).html;

const FOCUS = '<button type="button" title="Focus mode (F)" data-control="focus">Focus</button>';

test("the model hands the page a menu only while its bundle resolves", () => {
  assert.deepEqual(managementMenu({ kind: "menu", actions, config, assets: bundle }), { config, assets: bundle });
  assert.equal(
    managementMenu({ kind: "menu", actions, config, assets: noBundle }),
    undefined,
    "a build without the entry is not a menu",
  );
  assert.equal(managementMenu({ kind: "none" }), undefined, "no entitlement, no menu");
});

test("the page mounts the actions island exactly when the model has actions and the bundle exists", () => {
  const page = pageOf({ kind: "menu", actions, config, assets: bundle });
  assert.match(
    page,
    /<span data-island="actions"><button type="button" data-control="menu" aria-haspopup="menu" aria-expanded="false">Actions<\/button><\/span>/,
    "the slot renders a real trigger",
  );
  assert.match(page, /<script type="module" src="\/assets\/viewer-actions.js"><\/script>/, "and mounts its island");
  const payload = /<script type="application\/json" id="viewer-management-data">([\s\S]*?)<\/script>/.exec(page)?.[1];
  assert.deepEqual(JSON.parse(payload ?? "null"), config, "the island is handed the artifact it manages");

  for (const [reason, management] of [
    ["a seat with no actions", { kind: "none" as const }],
    ["a missing bundle", { kind: "menu" as const, actions, config, assets: noBundle }],
  ] as const) {
    const empty = pageOf(management);
    for (const term of ['data-island="actions"', 'data-control="menu"', "viewer-management-data", "viewer-actions.js"])
      assert.equal(empty.includes(term), false, `${reason} ships no ${term}`);
    assert.equal(empty.includes(FOCUS), true, `${reason} still draws the bar's own control`);
    assert.match(
      empty,
      /<div class="vbar-cell vbar-actions" data-control="actions">/,
      `${reason} leaves the slot empty rather than signalling a menu that cannot work`,
    );
  }
});

const barOf = (html: string): string => /<header class="vbar">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";

test("the document view draws the same slot and island, and only the controls it supplies", () => {
  const document = { ...modelOf({ kind: "menu", actions, config, assets: bundle }), kind: "markdown" };
  const page = markdownView(document, renderMarkdownFragment("# Pricing\n")).html;
  assert.match(
    page,
    /<div class="vbar-cell vbar-actions" data-control="actions"><span data-island="actions"><button type="button" data-control="menu"/,
    "the document bar holds the same slot and the same trigger",
  );
  assert.equal(/data-control="focus"/.test(page), false, "the document bar supplies no focus control");
  assert.match(page, /<script type="module" src="\/assets\/viewer-actions.js"><\/script>/, "and mounts the island");
  const payload = /id="viewer-management-data">([\s\S]*?)<\/script>/.exec(page)?.[1];
  assert.deepEqual(JSON.parse(payload ?? "null"), config, "the island is handed the artifact it manages");

  const without = { ...modelOf({ kind: "none" }), kind: "markdown" };
  const bare = markdownView(without, renderMarkdownFragment("# Pricing\n")).html;
  assert.equal(/data-control=/.test(bare), false, "with no actions the document bar ships no slot at all");
  assert.equal(bare.includes("viewer-management-data"), false);
  assert.equal(
    barOf(bare),
    barOf(artifactView(modelOf({ kind: "none" }), { srcdoc: "" }).html).replace(
      /<div class="vbar-cell vbar-actions"[\s\S]*?<\/div>\n/,
      "",
    ),
    "one bar: the document view is the framed bar up to the controls it does not supply",
  );

  const commentsIsland = read("../apps/dashboard/src/viewer-comments.tsx");
  const documentMount = commentsIsland.slice(
    commentsIsland.indexOf("export function mountViewerComments("),
    commentsIsland.indexOf("export function mountViewerCommentsInFrame("),
  );
  assert.notEqual(documentMount, "", "the document mount is where it was");
  assert.equal(
    /data-control="actions"/.test(documentMount),
    false,
    "the document mount never puts a comment control in the slot: comments on markdown are inline",
  );
});

test("a dev page with both islands loads the refresh preamble once", () => {
  const devComments = { script: "/src/viewer-comments.tsx", styles: [], dev: true };
  const devActions = { script: "/src/viewer-actions.tsx", styles: [], dev: true };
  const scripts = assetsScripts(devComments, devActions);
  assert.equal(
    (scripts.match(/@react-refresh/g) ?? []).length,
    1,
    "the preamble belongs to the page, not to an island",
  );
  assert.equal(
    (scripts.match(/<script type="module" src="\/src\//g) ?? []).length,
    2,
    "and each island is mounted once",
  );
  assert.match(artifactSource, /assetsScripts\(\.\.\./, "the page builder mounts every island through one call");
  assert.match(artifactSource, /assetsHead\(\.\.\./, "and links every stylesheet through one call");
});

test("each island resolves its own manifest entry and never the other's", () => {
  resetViewerCommentsAssetCache();
  const dir = mkdtempSync(join(tmpdir(), "viewer-actions-assets-"));
  try {
    mkdirSync(join(dir, ".vite"), { recursive: true });
    const manifest = (entries: Record<string, { file: string }>): void =>
      writeFileSync(join(dir, ".vite", "manifest.json"), JSON.stringify(entries));
    manifest({
      "src/viewer-comments.tsx": { file: "assets/comments.js" },
      "src/viewer-actions.tsx": { file: "assets/actions.js" },
    });
    const env = { ARTIFLOW_DASHBOARD_DIST: dir };
    assert.equal(viewerActionsAssets(env).script, "/assets/actions.js", "the actions entry is its own chunk");
    resetViewerCommentsAssetCache();
    manifest({ "src/viewer-comments.tsx": { file: "assets/comments.js" } });
    assert.equal(
      viewerActionsAssets(env).script,
      "/src/viewer-actions.tsx",
      "a build without the entry falls back to its own dev entry, never to the comment bundle",
    );
    assert.equal(viewerActionsAssets({ ...env, ARTIFLOW_VIEWER_ACTIONS_ASSET: "/x.js" }).script, "/x.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetViewerCommentsAssetCache();
  }
});

test("production without an actions bundle says so and serves no script", () => {
  resetViewerCommentsAssetCache();
  const dir = mkdtempSync(join(tmpdir(), "viewer-actions-prod-"));
  const logged: string[] = [];
  try {
    mkdirSync(join(dir, ".vite"), { recursive: true });
    writeFileSync(
      join(dir, ".vite", "manifest.json"),
      JSON.stringify({ "src/viewer-comments.tsx": { file: "assets/comments.js" } }),
    );
    const assets = viewerActionsAssets({ ARTIFLOW_DASHBOARD_DIST: dir, NODE_ENV: "production" }, (message) =>
      logged.push(message),
    );
    assert.deepEqual(assets, { script: "", styles: [], dev: false }, "no dev preamble ever reaches production");
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? "", /no actions bundle/, "the degradation is named for the entry it looked for");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetViewerCommentsAssetCache();
  }
});

test("the trigger opens on ArrowDown and leaves every other key to the browser", () => {
  const intent = exportedPolicy(islandSource, "triggerIntent", ["key", "modified"]);
  assert.equal(intent("ArrowDown", false), "open", "a down arrow opens the menu");
  for (const key of ["Enter", " ", "ArrowUp", "Escape", "Tab", "a", ""])
    assert.equal(intent(key, false), "ignore", `${JSON.stringify(key)} is the button's own activation`);
  assert.equal(intent("ArrowDown", true), "ignore", "a modified arrow scrolls the page instead");
  assert.match(
    islandSource,
    /<button\s+ref=\{trigger\}\s+type="button"\s+data-control="menu"/,
    "the trigger is a real button, so Enter and Space activate it natively",
  );
});

test("the menu is the shared menu and the dialogs are the existing ones", () => {
  assert.match(islandSource, /import \{ Menu, MenuItem \} from "@\/components\/ui\/menu\.tsx";/);
  assert.match(islandSource, /import ShareModal from "@\/ShareModal\.tsx";/);
  assert.match(islandSource, /import DeleteModal from "@\/DeleteModal\.tsx";/);
  assert.match(islandSource, /<Menu\s+trigger=\{/, "the island reuses the menu component");
  assert.equal(/role="(menu|menuitem|dialog)"/.test(islandSource), false, "and declares no role of its own");
  assert.equal(/<Dialog/.test(islandSource), false, "no second dialog is written");
  assert.equal(/createPortal/.test(islandSource), false, "the menu owns its own surface");
  assert.match(islandSource, /<MenuItem\s+icon="link"\s+onClick=\{open\("share"\)\}>\s*Share\s*<\/MenuItem>/);
  assert.match(
    islandSource,
    /<MenuItem\s+icon="trash"\s+danger\s+onClick=\{open\("delete"\)\}>\s*Delete\s*<\/MenuItem>/,
  );

  assert.match(menuSource, /"aria-haspopup": "menu"/, "the trigger announces a menu");
  assert.match(menuSource, /"aria-expanded": open/, "and whether it is open");
  assert.match(menuSource, /if \(event\.key === "Escape" && open\)/, "Escape closes it");
  assert.match(menuSource, /returnFocusToTrigger\(\)/, "and returns focus to the trigger it came from");
  assert.match(menuSource, /cycleFocus\(1\)/, "a down arrow walks the items");
  assert.match(menuSource, /cycleFocus\(-1\)/, "an up arrow walks them back");
  assert.match(menuSource, /role="menuitem"/, "every item is a menu item");
  const triggerAt = menuSource.indexOf("{triggerElement}");
  const surfaceAt = menuSource.indexOf('role="menu"');
  assert.ok(
    triggerAt !== -1 && surfaceAt !== -1 && triggerAt < surfaceAt,
    "the surface follows the trigger in document order, so Tab reaches the items",
  );
});

test("focus goes back to the trigger after a dialog closes, never to a detached node", () => {
  const refocus = exportedPolicy(islandSource, "refocusAfterClose", ["trigger", "schedule"]);
  const focused: string[] = [];
  const scheduled: (() => void)[] = [];
  const trigger = { isConnected: true, focus: () => focused.push("trigger") };
  refocus(
    () => trigger,
    (task: () => void) => scheduled.push(task),
  );
  assert.deepEqual([...focused], [], "the restore waits for the dialog to unmount");
  for (const task of scheduled) task();
  assert.deepEqual([...focused], ["trigger"], "then the trigger takes focus back");

  const gone = { isConnected: false, focus: () => focused.push("detached") };
  const detached: (() => void)[] = [];
  refocus(
    () => gone,
    (task: () => void) => detached.push(task),
  );
  for (const task of detached) task();
  assert.deepEqual([...focused], ["trigger"], "a trigger that left the page is never focused");

  const missing: (() => void)[] = [];
  refocus(
    () => null,
    (task: () => void) => missing.push(task),
  );
  for (const task of missing) task();
  assert.deepEqual([...focused], ["trigger"], "and neither is a missing one");
  assert.equal((islandSource.match(/onClose=\{close\}/g) ?? []).length, 2, "both dialogs hand their close back");
});

test("the island mounts into the slot the bar draws and supplies the dialog providers", () => {
  assert.match(islandSource, /querySelector<HTMLElement>\('\[data-island="actions"\]'\)/);
  assert.match(islandSource, /getElementById\("viewer-management-data"\)/);
  assert.match(islandSource, /createRoot\(host\)\.render\(/, "one island, one root, into the slot");
  assert.match(islandSource, /<QueryProvider>/);
  assert.match(islandSource, /<ToastProvider>/);
  assert.ok(
    islandSource.indexOf("<QueryProvider>") < islandSource.indexOf("<ViewerActions"),
    "the providers wrap the menu, so the dialogs read them locally",
  );
  assert.equal(/className = "vbar-/.test(islandSource), false, "the island borrows no control class");
  assert.equal(/vbar-actions/.test(islandSource), false, "and names no slot class");
});

test("the delete dialog takes the three fields it shows", () => {
  assert.match(deleteModalSource, /artifact: \{ id: string; title: string; kind: string \}/);
  assert.equal(/sizeLabel|versionsLabel/.test(deleteModalSource), false, "nothing else is read");
  assert.match(deleteModalSource, /labelFor\(artifact\.kind\)/, "the kind it is handed is the kind it shows");
  assert.match(
    librarySource,
    /<DeleteModal\s+artifact=\{\{\s*id: active\.artifact\.id,\s*title: active\.artifact\.title,\s*kind: active\.artifact\.kind,?\s*\}\}/,
    "the library hands it exactly the three fields",
  );
  assert.match(
    islandSource,
    /<DeleteModal\s+artifact=\{\{\s*id: config\.id,\s*title,\s*kind: config\.kind,?\s*\}\}/,
    "so does the island",
  );
});
