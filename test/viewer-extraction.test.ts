import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SCENE_FORMAT_VERSION, type Scene } from "@artiflow/domain/scene";

import * as artifact from "../apps/api/src/viewer/artifact.ts";
import * as bar from "../apps/api/src/viewer/chrome/bar.ts";
import * as panel from "../apps/api/src/viewer/chrome/panel.ts";
import * as theme from "../apps/api/src/viewer/chrome/theme.ts";
import * as htmlPath from "../apps/api/src/viewer/html.ts";
import * as markdownPath from "../apps/api/src/viewer/markdown.ts";
import * as model from "../apps/api/src/viewer/model.ts";
import { prepareViewer } from "../apps/api/src/viewer/prepare.ts";
import * as scenePath from "../apps/api/src/viewer/scene.ts";
import * as htmlView from "../apps/api/src/viewer/views/html.ts";
import * as markdownView from "../apps/api/src/viewer/views/markdown.ts";
import * as sceneView from "../apps/api/src/viewer/views/scene.ts";

const sourceOf = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

const OLD_PATHS = [
  ["html", "../apps/api/src/viewer/html.ts"],
  ["markdown", "../apps/api/src/viewer/markdown.ts"],
  ["scene", "../apps/api/src/viewer/scene.ts"],
] as const;

const VIEWS = [
  ["html", "../apps/api/src/viewer/views/html.ts"],
  ["markdown", "../apps/api/src/viewer/views/markdown.ts"],
  ["scene", "../apps/api/src/viewer/views/scene.ts"],
] as const;

const RE_EXPORT = /export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|[\w$]+)\s+from\s+"[^"]*";?/g;

test("the old module paths are re-export surfaces carrying no behaviour", () => {
  for (const [name, path] of OLD_PATHS) {
    const source = sourceOf(path);
    assert.equal(source.replace(RE_EXPORT, "").trim(), "", `${name} holds nothing but re-exports`);
    assert.equal(/`/.test(source), false, `${name} renders no document`);
    assert.equal(/<[a-z!/]/i.test(source), false, `${name} ships no markup`);
  }
});

const FROM_THEME = [
  "escapeAttribute",
  "NOT_FOUND_HEADERS",
  "NOT_FOUND_PAGE",
  "THEME_BOOTSTRAP",
  "VIEWER_CHROME_CSS",
  "VIEWER_TOKENS",
  "WRAPPER_CSP",
] as const;
const FROM_ARTIFACT = [
  "artifactView",
  "originOf",
  "SANDBOX",
  "sceneCsp",
  "sceneDocumentCsp",
  "sceneHeaders",
  "VIEWER_CSP",
  "VIEWER_HEADERS",
  "viewerRefreshScript",
  "wrapperPage",
] as const;

test("the old html path re-exports the values the new modules own", () => {
  for (const name of FROM_THEME) assert.equal(htmlPath[name], theme[name], `html re-exports theme's ${name}`);
  for (const name of FROM_ARTIFACT) assert.equal(htmlPath[name], artifact[name], `html re-exports artifact's ${name}`);
  assert.equal(htmlPath.refreshPlan, model.refreshPlan, "and the plan builder the model owns");
  for (const key of Object.keys(htmlPath))
    assert.ok(
      key in theme || key in artifact || key in model,
      `html exposes no binding of its own: ${key} is not owned by any module it re-exports`,
    );
});

test("the old markdown and scene paths re-export exactly what their view owns", () => {
  for (const [name, barrel, owner] of [
    ["markdown", markdownPath, markdownView],
    ["scene", scenePath, sceneView],
  ] as const) {
    const keys = Object.keys(barrel).sort();
    assert.deepEqual(keys, Object.keys(owner).sort(), `${name} exposes exactly the view's surface`);
    for (const key of keys)
      assert.equal(
        (barrel as Record<string, unknown>)[key],
        (owner as Record<string, unknown>)[key],
        `${name}.${key} is the view's own binding, not a copy`,
      );
  }
});

const ARTIFACT_ROW = {
  id: "artifact-one",
  ownerId: "user-owner",
  kind: "canvas",
  title: "A canvas",
  revisionId: "revision-one",
  revisionNumber: 2,
  sha256: "a".repeat(64),
};

const publicModel = () =>
  prepareViewer({
    db: {} as never,
    artifact: ARTIFACT_ROW,
    request: { kind: "public", token: "t".repeat(43), showComments: false },
    embed: false,
    source: null,
  });

test("the artifact composition reads no audience, action, identity or kind", async () => {
  const base = await publicModel();
  const page = artifact.artifactView(base, { srcdoc: "<p>x</p>" });
  const other = artifact.artifactView(
    {
      ...base,
      id: "somebody-elses-artifact",
      kind: "deck",
      title: null,
      audience: { kind: "bearer", viewerId: "user-other" },
      actions: { comment: true, resolve: true, deleteOwn: false, deleteAny: true },
    },
    { srcdoc: "<p>x</p>" },
  );
  assert.equal(other.html, page.html, "the same chrome and the same slots render the same document");
  assert.deepEqual(other.headers, page.headers, "and carry the same policy");
  const source = sourceOf("../apps/api/src/viewer/artifact.ts");
  for (const unread of ["audience", "actions", "viewerId", "ownerId", "permission", "kinds"])
    assert.equal(source.includes(unread), false, `the composition never reads ${unread}`);
});

test("the bar builds the header and mounts no dialog", () => {
  const header = bar.artifactBar({
    backHref: "/",
    meta: { title: "A canvas", version: 3 },
    embed: false,
    control: `<button class="vbar-focus" type="button" title="Focus mode (F)">Focus</button>`,
  });
  assert.equal(header.startsWith('<header class="vbar">'), true, "the bar is the header region");
  assert.equal(/dialog/i.test(header), false, "no dialog is mounted in the bar");
  assert.equal(header.includes('role="'), false, "the bar declares no interactive role of its own");
  const source = sourceOf("../apps/api/src/viewer/chrome/bar.ts");
  assert.equal(/dialog/i.test(source), false, "the bar mounts no dialog");
  assert.equal(source.includes("kinds.ts"), false, "the bar does not import the kind vocabulary");
  assert.equal(/canComment|deleteAny|deleteOwn|resolve/.test(source), false, "the bar decides no permission");
});

test("the theme and the panel import nothing, so nothing can change them from outside", () => {
  for (const [name, path] of [
    ["theme", "../apps/api/src/viewer/chrome/theme.ts"],
    ["panel", "../apps/api/src/viewer/chrome/panel.ts"],
  ] as const) {
    const source = sourceOf(path);
    assert.equal(/^\s*import\b/m.test(source), false, `${name} imports nothing`);
    assert.equal(/from\s+"/.test(source), false, `${name} re-exports nothing either`);
  }
});

test("no view imports another view, and none reaches back through an old path", () => {
  for (const [name, path] of VIEWS) {
    const source = sourceOf(path);
    for (const other of ["html", "markdown", "scene"] as const) {
      if (other === name) continue;
      assert.equal(source.includes(`"../views/${other}.ts"`), false, `${name} does not import views/${other}`);
      assert.equal(source.includes(`"./${other}.ts"`), false, `${name} does not import ./${other}`);
    }
    assert.equal(
      /from "\.\.\/(?:html|markdown|scene)\.ts"/.test(source),
      false,
      `${name} does not reach the old paths for a base to build on`,
    );
  }
});

const SCENE: Scene = {
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [{ id: "home", name: "Home", x: 0, y: 0, w: 400, h: 300, nodes: [] }],
};

const unescapeAttribute = (value: string): string =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

const srcdocOf = (page: string): string => {
  const attribute = /srcdoc="([^"]*)"/.exec(page);
  assert.ok(attribute !== null, "the served page carries a srcdoc frame");
  return unescapeAttribute(attribute[1] ?? "");
};

const metaPolicyOf = (document: string): string =>
  /content-security-policy" content="([^"]*)"/.exec(document)?.[1] ?? "";

const imageSourceOf = (policy: string): string => /img-src ([^;]+)/.exec(policy)?.[1] ?? "";

test("the scene header and the frame policy name the same image origin", async () => {
  const rendered = sceneView.sceneView(await publicModel(), {
    scene: SCENE,
    images: { origin: "https://canvas.test/", artifactId: ARTIFACT_ROW.id, digests: new Set() },
    kind: "canvas",
  });
  const header = imageSourceOf(rendered.headers["content-security-policy"] ?? "");
  const frame = imageSourceOf(metaPolicyOf(srcdocOf(rendered.html)));
  assert.equal(header, "https://canvas.test", "the header names the origin, not the spelling it arrived in");
  assert.equal(frame, "https://canvas.test", "and the frame names the same one");
  assert.equal(header, frame, "one origin, one policy");
});

test("the html view hands the artifact document the escaped bytes and nothing else", async () => {
  const rendered = htmlView.htmlView(await publicModel(), `<p class="x">a & b</p>`);
  assert.equal(rendered.html.includes(`srcdoc="&lt;p class=&quot;x&quot;&gt;a &amp; b&lt;/p&gt;"`), true);
  assert.deepEqual(rendered.headers, { ...artifact.VIEWER_HEADERS }, "and the viewer policy it carries");
  assert.equal(markdownView.markdownView(await publicModel(), "<h1>x</h1>").html.includes("<iframe"), false);
  assert.equal(panel.commentsHost(false), "");
});
