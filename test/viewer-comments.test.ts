import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  resetViewerCommentsAssetCache,
  viewerCommentsAsset,
  viewerCommentsAssets,
} from "../apps/api/src/viewer/assets.ts";
import { viewerCommentsConfig } from "../apps/api/src/viewer/comments-data.ts";
import {
  createSequenceGuard,
  parseThreadsResponse,
  reconcileActive,
  viewportAnchor,
} from "../apps/dashboard/src/viewer-thread-sync.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the viewer sends the JSON content type its own delete route demands", () => {
  const island = read("../apps/dashboard/src/viewer-comments.tsx");
  const request = /const deleteRequest[^]*?\n\};/.exec(island)?.[0] ?? "";
  assert.match(request, /method: "DELETE"/);
  assert.match(request, /"content-type": "application\/json"/, "a cookie delete without JSON is refused with 415");
  assert.match(request, /credentials: "same-origin"/);
});

const source = "# Pricing\n\nThe second paragraph target text.\n\nAnother target text later.\n";

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "c1",
  authorId: "u1",
  authorName: "Ann",
  authorImage: null,
  anchor: { kind: "text-range", startLine: 3, startCol: 22, endLine: 3, endCol: 33, quotedText: "target text" },
  body: "hi",
  parentId: null,
  resolvedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const endpoints = { comments: "/c", resolve: "/c", deleteComment: "/c" };

test("the viewer asset prefers an explicit override and otherwise finds the manifest entry", () => {
  resetViewerCommentsAssetCache();
  assert.equal(viewerCommentsAsset({ ARTIFLOW_VIEWER_COMMENTS_ASSET: "/x.js" }), "/x.js");
  resetViewerCommentsAssetCache();
  const dir = mkdtempSync(join(tmpdir(), "viewer-asset-"));
  try {
    mkdirSync(join(dir, ".vite"), { recursive: true });
    writeFileSync(
      join(dir, ".vite", "manifest.json"),
      JSON.stringify({ "src/viewer-comments.tsx": { file: "assets/viewer-comments-abc.js" } }),
    );
    assert.equal(viewerCommentsAsset({ ARTIFLOW_DASHBOARD_DIST: dir }), "/assets/viewer-comments-abc.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetViewerCommentsAssetCache();
  }
});

test("production without a manifest serves no bundle and says so", () => {
  resetViewerCommentsAssetCache();
  const dir = mkdtempSync(join(tmpdir(), "viewer-asset-prod-"));
  const logged: string[] = [];
  try {
    const assets = viewerCommentsAssets({ ARTIFLOW_DASHBOARD_DIST: dir, NODE_ENV: "production" }, (message) =>
      logged.push(message),
    );
    assert.deepEqual(assets, { script: "", styles: [], dev: false }, "no dev preamble ever reaches production");
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /no comment bundle/);
    assert.equal(logged[0]!.includes(dir), true, "the log names the manifest it looked for");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetViewerCommentsAssetCache();
  }
});

test("a missing manifest outside production falls back to the dev entry", () => {
  resetViewerCommentsAssetCache();
  const dir = mkdtempSync(join(tmpdir(), "viewer-asset-empty-"));
  try {
    assert.equal(
      viewerCommentsAsset({ ARTIFLOW_DASHBOARD_DIST: dir, NODE_ENV: "development" }),
      "/src/viewer-comments.tsx",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetViewerCommentsAssetCache();
  }
});

test("the config reports staleness, occurrence and the viewer's own permissions", () => {
  const config = viewerCommentsConfig({
    artifactId: "a1",
    source,
    rows: [row(), row({ id: "c2", authorId: "u2", anchor: { ...row().anchor, quotedText: "gone text" } })],
    viewerId: "u1",
    canComment: false,
    canDeleteOwn: true,
    deleteAny: false,
    endpoints,
  });
  assert.equal(config.canComment, false);
  assert.equal(config.canResolve, false);
  assert.equal(config.threads[0]?.stale, false);
  assert.equal(config.threads[0]?.canDelete, true, "the viewer may delete their own comment");
  assert.equal(config.threads[1]?.stale, true, "a changed quote is flagged stale");
  assert.equal(config.threads[1]?.canDelete, false, "and not somebody else's");
  assert.deepEqual(config.threads[0]?.author, { id: "u1", name: "Ann", image: null });
});

test("the owner may delete a thread somebody else wrote", () => {
  const config = viewerCommentsConfig({
    artifactId: "a1",
    source,
    rows: [row({ id: "c2", authorId: "u2" })],
    viewerId: "u1",
    canComment: true,
    canDeleteOwn: true,
    deleteAny: true,
    endpoints,
  });
  assert.equal(config.threads[0]?.canDelete, true, "owning the artifact outranks authorship of the comment");
});

test("the second identical quote keeps its own occurrence index", () => {
  const config = viewerCommentsConfig({
    artifactId: "a1",
    source,
    rows: [row({ anchor: { ...row().anchor, startLine: 5, startCol: 9, endLine: 5, endCol: 20 } })],
    viewerId: null,
    canComment: false,
    canDeleteOwn: false,
    deleteAny: false,
    endpoints,
  });
  assert.equal(config.threads[0]?.occurrence, 1, "the later quote is the second occurrence");
});

test("a public link builds a read-only config whose endpoints cannot mutate", () => {
  const config = viewerCommentsConfig({
    artifactId: "a1",
    source,
    rows: [row()],
    viewerId: null,
    canComment: false,
    canDeleteOwn: false,
    deleteAny: false,
    endpoints: { comments: "/share/t/comments", resolve: "", deleteComment: "" },
  });
  assert.equal(config.canComment, false);
  assert.equal(config.canResolve, false);
  assert.equal(config.threads[0]?.canDelete, false);
  assert.equal(config.threads[0]?.canResolve, false);
});

test("the shared viewer loads comments for a reader but refuses writes", () => {
  const library = read("../apps/api/src/routes/library.ts");
  assert.match(library, /document: \(\) => commentDocument\(db, ownerId, artifactId, "shared"\)/);
  assert.match(library, /list: \(\) => listComments\(db, artifactId, true\)/);
  assert.match(library, /canComment: degraded\.canComment/);
  assert.match(
    library,
    /import \{ loadViewerComments \} from "\.\.\/viewer\/comments-degrade\.ts"/,
    "a comment-store failure degrades instead of failing the document",
  );
});

test("the owner config advertises the list endpoint and the public config does not", () => {
  const library = read("../apps/api/src/routes/library.ts");
  assert.match(library, /list: `\/artifact\/\$\{artifactId\}\/comments`/);
  const sharing = read("../apps/api/src/routes/sharing.ts");
  assert.equal(/list:/.test(sharing), false);
  const config = viewerCommentsConfig({
    artifactId: "a1",
    source,
    rows: [row()],
    viewerId: null,
    canComment: false,
    canDeleteOwn: false,
    deleteAny: false,
    endpoints: { comments: "/share/t/comments", resolve: "", deleteComment: "" },
  });
  assert.equal("list" in config.endpoints, false);
  const owner = viewerCommentsConfig({
    artifactId: "a1",
    source,
    rows: [row()],
    viewerId: "u1",
    canComment: true,
    canDeleteOwn: true,
    deleteAny: false,
    endpoints: { ...endpoints, list: "/artifact/a1/comments" },
  });
  assert.equal(owner.endpoints.list, "/artifact/a1/comments");
});

test("the comments list route is registered before the artifact catch-all and gates through one function", () => {
  const library = read("../apps/api/src/routes/library.ts");
  const route = library.indexOf('app.get("/artifact/:id/comments"');
  assert.notEqual(route, -1);
  assert.ok(route < library.indexOf('app.all("/artifact/*", methodNotAllowed)'), "the route precedes the catch-all");
  const body = library.slice(route, library.indexOf("if (options.deletion)"));
  assert.match(body, /commentsListGate\(\{ bearerPresent, sessionUserId: ownerId, artifact: row \}\)/);
  assert.match(body, /if \(gate\.kind === "unauthorized"\) return c\.json\(\{ error: "unauthorized" \}, 401\)/);
  assert.match(body, /if \(gate\.kind === "not_found"\) return c\.json\(\{ error: "not_found" \}, 404\)/);
  assert.match(body, /c\.header\("cache-control", "no-store"\)/);
  assert.match(body, /return c\.json\(\{ canComment: config\.canComment, threads: config\.threads \}\)/);
  assert.equal(
    body.includes('headers.has("authorization")) return'),
    false,
    "the header is captured and the 401 rule lives in commentsListGate, pinned by test/library-comments-gate.test.ts",
  );
});

test("the public viewer only reads comments while the link option is on", () => {
  const sharing = read("../apps/api/src/routes/sharing.ts");
  assert.match(sharing, /row\.showComments \? await listComments\(db, row\.artifactId, true\) : \[\]/);
  assert.match(sharing, /canComment: false/);
  assert.match(sharing, /comments: `\/share\/\$\{token\}\/comments`/);
});

test("the share dialog offers the show-comments option and persists it with the link patch", () => {
  const modal = read("../apps/dashboard/src/ShareModal.tsx");
  const client = read("../apps/dashboard/src/auth-client.ts");
  assert.match(modal, /Show comments/);
  assert.match(modal, /checked=\{activeLink\.showComments\}/);
  assert.match(modal, /setLinkShowComments\(artifactId, activeLink\.id, showComments\)/);
  assert.match(client, /export const setLinkShowComments/);
  assert.match(client, /"PATCH"/);
  assert.match(client, /showComments: value\.showComments === true/, "the row defaults to off");
});

test("parseThreadsResponse accepts a well-formed list and rejects anything else", () => {
  const ok = parseThreadsResponse({ canComment: true, threads: [{ id: "a" }, { id: "b" }] });
  assert.deepEqual(ok, { canComment: true, threads: [{ id: "a" }, { id: "b" }] });
  assert.deepEqual(parseThreadsResponse({ canComment: false, threads: [] }), { canComment: false, threads: [] });
  for (const bad of [null, "x", 1, {}, { canComment: "yes", threads: [] }, { canComment: true, threads: {} }]) {
    assert.equal(parseThreadsResponse(bad), null);
  }
  assert.equal(parseThreadsResponse({ canComment: true, threads: [null] }), null);
  assert.equal(parseThreadsResponse({ canComment: true, threads: [{ id: 3 }] }), null);
});

test("reconcileActive keeps a thread that still exists and clears the rest", () => {
  const threads = [{ id: "a" }, { id: "b" }];
  assert.equal(reconcileActive("a", threads), "a");
  assert.equal(reconcileActive("gone", threads), null);
  assert.equal(reconcileActive(null, threads), null);
  assert.equal(reconcileActive("a", []), null);
});

test("the viewers share one coordinate system, refetch in place and reveal the opened thread", () => {
  const viewer = read("../apps/dashboard/src/viewer-comments.tsx");
  assert.equal(viewer.includes("shell.scrollTop"), false, "the markdown viewer never adds the scroll offset");
  assert.match(viewer, /anchorOffsets\(entries, origin\)/);
  assert.equal(viewer.includes("Math.max(0, Math.round(y"), false, "anchors above the margin are not clamped");
  assert.match(viewer, /frame\.getBoundingClientRect\(\)\.top - \(shelf\?\.getBoundingClientRect\(\)\.top \?\? 0\)/);
  assert.match(viewer, /message\.type === "scroll"/);
  assert.match(viewer, /message\.viewportY \+ state\.scrollY/);
  assert.equal((viewer.match(/window\.location\.reload\(\)/g) ?? []).length, 2, "reload only backs up onRetry");
  assert.equal((viewer.match(/void refetch\(\);\s*return;/g) ?? []).length >= 2, true);
  assert.match(viewer, /config\.threads = next\.threads;/);
  assert.match(viewer, /state\.activeId = reconcileActive\(state\.activeId, next\.threads\);/);
  assert.match(viewer, /send\(\{ type: "pins", pins: pins\(\) \}\);/);
  assert.match(viewer, /\(\) => \{\s*state\.draft = null;/, "the draft is cleared only after a successful create");
  assert.match(viewer, /block: "center", behavior: reducedMotion\(\) \? "instant" : "smooth"/);
  assert.match(viewer, /classList\.add\(`\$\{MARK\}-flash`\)/);
});

test("viewportAnchor places a pin relative to the visible frame, negative above the viewport", () => {
  assert.equal(viewportAnchor(300, 0, 48, 48), 300);
  assert.equal(viewportAnchor(300, 0, 60, 12), 348);
  assert.equal(viewportAnchor(1500, 1400, 48, 48), 100);
  assert.equal(viewportAnchor(200, 1400, 48, 48), -1200);
  assert.equal(viewportAnchor(1400.4, 1400, 48.2, 48), 1);
});

test("the sequence guard only accepts the latest token", () => {
  const guard = createSequenceGuard();
  const first = guard.next();
  assert.equal(guard.isCurrent(first), true);
  const second = guard.next();
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
});
