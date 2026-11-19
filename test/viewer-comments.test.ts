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

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

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

test("the second identical quote keeps its own occurrence index", () => {
  const config = viewerCommentsConfig({
    artifactId: "a1",
    source,
    rows: [row({ anchor: { ...row().anchor, startLine: 5, startCol: 9, endLine: 5, endCol: 20 } })],
    viewerId: null,
    canComment: false,
    canDeleteOwn: false,
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
    endpoints: { comments: "/share/t/comments", resolve: "", deleteComment: "" },
  });
  assert.equal(config.canComment, false);
  assert.equal(config.canResolve, false);
  assert.equal(config.threads[0]?.canDelete, false);
  assert.equal(config.threads[0]?.canResolve, false);
});

test("the shared viewer loads comments for a reader but refuses writes", () => {
  const library = read("../apps/api/src/routes/library.ts");
  assert.match(library, /const shared = await commentDocument\(db, ownerId, row\.id, "shared"\)/);
  assert.match(library, /canComment: shared !== undefined && shared\.access !== "reader"/);
  assert.match(library, /rows = shared === undefined \? \[\] : await listComments\(db, row\.id, true\)/);
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
