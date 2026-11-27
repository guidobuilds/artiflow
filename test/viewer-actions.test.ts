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
import { renameMessage, renameNotice, renameState } from "../apps/dashboard/src/artifact-api.ts";

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
const TITLE = config.title;
const bundle = { script: "/assets/viewer-actions.js", styles: [], dev: false };
const noBundle = { script: "", styles: [], dev: false };
const actions = { share: true, delete: true, rename: true };

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
  assert.match(
    islandSource,
    /import \{ Dialog, DialogContent, DialogFoot, DialogHead, DialogSection, DialogTitle \} from "@\/components\/ui\/dialog\.tsx";/,
    "the rename dialog is the dashboard's own dialog",
  );
  assert.match(
    islandSource,
    /import \{ Field, Input \} from "@\/components\/ui\/input\.tsx";/,
    "and its field is the dashboard's own field, which already announces its error",
  );
  assert.match(islandSource, /import \{ Button, ButtonGroup \} from "@\/components\/ui\/button\.tsx";/);
  assert.equal(/createPortal/.test(islandSource), false, "the menu owns its own surface");
  assert.match(islandSource, /<MenuItem\s+icon="link"\s+onClick=\{open\("share"\)\}>\s*Share\s*<\/MenuItem>/);
  assert.match(
    islandSource,
    /<MenuItem\s+icon="pencil"\s+onClick=\{open\("rename"\)\}>\s*Rename\s*<\/MenuItem>/,
    "the menu offers rename between share and delete",
  );
  assert.match(
    islandSource,
    /<MenuItem\s+icon="trash"\s+danger\s+onClick=\{open\("delete"\)\}>\s*Delete\s*<\/MenuItem>/,
  );
  assert.ok(
    islandSource.indexOf('open("share")') < islandSource.indexOf('open("rename")') &&
      islandSource.indexOf('open("rename")') < islandSource.indexOf('open("delete")'),
    "and reads share, rename, delete in that order",
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
  assert.equal((islandSource.match(/onClose=\{close\}/g) ?? []).length, 3, "all three dialogs hand their close back");
});

test("the rename dialog fills itself with the title it has and refuses to save nothing or the same thing", () => {
  const state = renameState;
  assert.equal(state(TITLE, TITLE), "unchanged", "the prefilled title is not a change");
  assert.equal(state(TITLE, `  ${TITLE}  `), "unchanged", "nor is the same title with whitespace around it");
  assert.equal(state(TITLE, "Pricing artifact v2"), "ready", "a different title can be saved");
  assert.equal(state(null, "First title"), "ready", "an untitled artifact can be given a title");
  for (const blank of ["", "   ", "\n\t "]) assert.equal(state(TITLE, blank), "empty", `" ${blank}" is no title`);
  assert.equal(state(null, ""), "empty", "and an untitled artifact cannot be saved empty");
  assert.equal(state(TITLE, "x".repeat(200)), "ready", "200 characters is inside the cap");
  assert.equal(state(TITLE, "x".repeat(201)), "too_long", "201 is outside it");
  assert.equal(state(TITLE, `  ${"x".repeat(201)}  `), "too_long", "and the cap counts the trimmed value");
  assert.equal(state(TITLE, "\u200b"), "ready", "a zero-width space is a title, not a blank one");

  const notice = renameNotice;
  assert.equal(notice("unchanged"), null, "nothing to say about an unchanged title");
  assert.equal(notice("ready"), null);
  assert.equal(notice("empty"), "Enter a title to save.", "an empty title is explained");
  assert.match(String(notice("too_long")), /200 characters/, "and so is the cap");
});

test("the island keeps no copy of the title rules: one number, one notion of blank, one import", () => {
  assert.equal(/200/.test(islandSource), false, "the cap is not written in the island");
  assert.equal(
    /export type RenameState|export function renameState|export function renameNotice/.test(islandSource),
    false,
    "the rules are not restated in the island",
  );
  assert.equal(
    /trim\(\)\.length === 0|\.trim\(\) === \(/.test(islandSource),
    false,
    "and the island owns no blank or unchanged rule of its own",
  );
  assert.match(
    islandSource,
    /import \{ renameArtifact, renameNotice, renameState \} from "@\/artifact-api\.ts";/,
    "the island imports the one copy",
  );
  const artifactApi = read("../apps/dashboard/src/artifact-api.ts");
  assert.match(
    artifactApi,
    /import \{[^}]*ARTIFACT_TITLE_LIMIT[^}]*titleProblem[^}]*\} from "@artiflow\/contracts\/artifacts";/s,
    "and that copy is the shared contract, not a second number",
  );
  assert.equal(/200/.test(artifactApi), false, "the client module holds no number of its own");
});

test("the rename dialog is a shared-dialog form with a prefilled field, cancel, save and the server's answer", () => {
  const dialog = islandSource.slice(
    islandSource.indexOf("function RenameDialog("),
    islandSource.indexOf("function ViewerActions("),
  );
  assert.notEqual(dialog, "", "the dialog is where the island can read it");
  assert.match(dialog, /<Dialog\s+open\s+onOpenChange=/, "it is the shared dialog primitive");
  assert.match(dialog, /<DialogContent size="sm"/, "at the size the delete dialog uses");
  assert.match(dialog, /<DialogHead \/>/);
  assert.match(dialog, /<DialogTitle>Rename artifact<\/DialogTitle>/);
  assert.match(dialog, /const \[value, setValue\] = useState\(title\)/, "the current title is prefilled, not empty");
  assert.match(
    dialog,
    /<Field label="Title" htmlFor="artifact-rename-title" error=\{error \?\? notice \?\? undefined\}>/,
  );
  assert.match(dialog, /<Input\s+id="artifact-rename-title"\s+value=\{value\}/, "one labelled input holds the title");
  assert.match(dialog, /autoFocus/, "and takes the focus when the dialog opens");
  assert.match(dialog, /<Button variant="ghost" onClick=\{onClose\}>\s*Cancel\s*<\/Button>/, "cancel closes");
  assert.match(
    dialog,
    /<Button type="submit" variant="primary" disabled=\{state !== "ready" \|\| busy\}>\s*\{busy \? "Saving…" : "Save"\}\s*<\/Button>/,
    "save is disabled for an empty, unchanged or over-long title, and while saving",
  );
  assert.match(dialog, /renameArtifact\(id, value\.trim\(\)\)/, "the island sends the trimmed value");
  assert.match(dialog, /setError\(result\.error\)/, "a server refusal becomes the reader's error message");
  assert.match(dialog, /onSaved\(result\.value\.title\)/, "and the saved title is the one the server answered");
  assert.equal(/role="alert"/.test(islandSource), false, "the field owns the alert, so the island declares none");
});

test("the island shows the persisted title in the bar the server drew, and never the typed one", () => {
  const showTitle = exportedPolicy(islandSource, "applyTitle", ["root", "title"]) as (
    root: { title: string; querySelector: (selector: string) => { textContent: string | null } | null } | undefined,
    title: string,
  ) => void;
  const node = { textContent: TITLE };
  const root = { title: "Artifact", querySelector: (selector: string) => (selector === ".vbar-title b" ? node : null) };
  showTitle(root, "Renamed artifact");
  assert.deepEqual(
    [node.textContent, root.title],
    ["Renamed artifact", "Renamed artifact"],
    "the bar's title cell and the document title both say the new name",
  );
  const bare = { title: "Artifact", querySelector: () => null };
  showTitle(bare, "Renamed artifact");
  assert.equal(bare.title, "Renamed artifact", "a page without a title cell still retitles itself");
  assert.doesNotThrow(() => showTitle(undefined, "Renamed artifact"), "and a page with no document is not a crash");
  assert.match(
    islandSource,
    /const \[current, setCurrent\] = useState\(config\.title\)/,
    "the island keeps the saved title in state, so a second rename and the share dialog read it",
  );
  assert.match(
    islandSource,
    /applyTitle\(document, (next|saved)\)/,
    "the bar is rewritten from the server's answer, not from the input",
  );
  assert.equal(/window\.location\.reload/.test(islandSource), false, "a rename does not throw the page away");
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

test("the island's rename is the metadata patch, and its refusals are words the reader can act on", () => {
  const artifactApi = read("../apps/dashboard/src/artifact-api.ts");
  assert.match(
    artifactApi,
    /manageRequest\(\s*`\/api\/artifacts\/\$\{encodeURIComponent\(artifactId\)\}\/metadata`,\s*"PATCH"/,
    "one PATCH to the metadata endpoint, and no other route",
  );
  assert.equal((artifactApi.match(/"PATCH"/g) ?? []).length, 1, "the dashboard renames through that one call");
  assert.equal(renameMessage("title_required"), "Enter a title to save.", "an empty title says what to do");
  assert.match(String(renameMessage("title_too_long")), /too long/, "an over-long title says what to do");
  const notFound = String(renameMessage("not_found"));
  assert.match(notFound, /not yours/, "a refusal covers an artifact that is not the reader's");
  assert.match(notFound, /no longer available/, "and one that was deleted, in the same words");
  assert.equal(
    /deleted|removed|does not exist|never existed/i.test(notFound),
    false,
    "and it never tells the caller which of the two it hit",
  );
  assert.equal(renameMessage("network"), undefined, "a transport failure keeps the client's own message");
});
