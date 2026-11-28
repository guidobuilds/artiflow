import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ARTIFACT_KINDS, editsDocumentInApp, editsSceneInApp, labelFor } from "../packages/domain/src/kinds.ts";
import { LIBRARY_KINDS, librarySearch, parseLibrarySearch } from "../apps/dashboard/src/route-search.ts";
import { libraryRowAccess, ownArtifactOpenHref } from "../apps/dashboard/src/library-access.ts";
import { openArtifact } from "../apps/dashboard/src/editor-api.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const SRC = "../apps/dashboard/src";
const DESIGN = "5f1d6f4b-1b2e-4d7a-9d3f-6a2b8c0e1f22";
const PAGE = "c2f7a1b9-8e3d-4a6f-b4c1-7d0e2f9a3b58";

test("the type filter is part of the library route, so a filtered view survives a reload", () => {
  assert.deepEqual(parseLibrarySearch({}), { filter: "all", kind: "all" });
  for (const kind of ARTIFACT_KINDS) {
    assert.equal(parseLibrarySearch({ kind }).kind, kind);
    assert.deepEqual(parseLibrarySearch({ filter: "mine", kind }), { filter: "mine", kind });
  }
  for (const bogus of ["everything", "", "PAGE", 3, null, true, ["html"]])
    assert.equal(parseLibrarySearch({ kind: bogus }).kind, "all", JSON.stringify(bogus));
  assert.deepEqual(LIBRARY_KINDS, ["all", ...ARTIFACT_KINDS]);
  assert.deepEqual(librarySearch("all"), {});
  assert.deepEqual(librarySearch("all", "canvas"), { kind: "canvas" });
  assert.deepEqual(librarySearch("shared", "canvas"), { filter: "shared", kind: "canvas" });
  assert.deepEqual(parseLibrarySearch(librarySearch("shared", "html")), { filter: "shared", kind: "html" });
});

test("the library reads its type from the route and keeps each type's registry label", () => {
  const page = source(`${SRC}/LibraryPage.tsx`);
  assert.match(page, /kind = "all",/);
  assert.match(page, /type LibraryKindFilter/);
  assert.match(page, /LIBRARY_KINDS\.map\(/);
  assert.match(page, /pluralFor\(kind\)/);
  assert.match(page, /onClick=\{\(\) => selectKind\(option\.value\)\}/);
  assert.match(page, /navigate\(\{ to: "\/", search: librarySearch\(filter, next\) \}\)/);
  assert.doesNotMatch(page, /useState<Kind>/);
  assert.match(page, /labelFor\(artifact\.kind\)/);
  const router = source(`${SRC}/router.tsx`);
  assert.match(router, /const \{ filter, kind \} = indexRoute\.useSearch\(\);/);
  assert.match(router, /<LibraryPage filter=\{filter\} kind=\{kind\} \/>/);
});

test("a Design opens its canvas and a Page opens its viewer", async () => {
  assert.equal(labelFor("canvas"), "Design");
  assert.equal(labelFor("html"), "Page");
  assert.equal(editsSceneInApp("canvas"), true);
  const visited: string[] = [];
  const target = { assign: (href: string) => void visited.push(href) };
  await openArtifact({ id: DESIGN, viewerHref: `/artifact/${DESIGN}`, kind: "canvas" }, target);
  assert.deepEqual(visited, [`/canvas/${DESIGN}`]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "not_found" }), { status: 404 })) as typeof fetch;
  try {
    await openArtifact({ id: PAGE, viewerHref: `/artifact/${PAGE}`, kind: "html" }, target);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(visited, [`/canvas/${DESIGN}`, `/artifact/${PAGE}`]);
});

test("a row shared with the reader offers no owner action and no editor", () => {
  const shared = libraryRowAccess({ kind: "canvas", owner: "ada@example.com" });
  assert.deepEqual(shared, { canShare: false, canDelete: false, canEdit: false, ownerLabel: "ada@example.com" });
  const sharedPage = libraryRowAccess({ kind: "html", owner: "ada@example.com" });
  assert.equal(sharedPage.canEdit, false);
  assert.equal(sharedPage.canDelete, false);
  const ownDesign = libraryRowAccess({ kind: "canvas" });
  assert.deepEqual(ownDesign, { canShare: true, canDelete: true, canEdit: true, ownerLabel: "You" });
  const ownPage = libraryRowAccess({ kind: "html" });
  assert.equal(ownPage.canEdit, false, "a Page has no in-app editor, so the library offers none");
  assert.equal(ownPage.canShare, true);
  assert.equal(libraryRowAccess({ kind: "unknown" }).canEdit, false);
  assert.equal(editsDocumentInApp("canvas"), false);
});

test("the library menu decides share, delete and the owner note from that access, not from a raw owner check", () => {
  const page = source(`${SRC}/LibraryPage.tsx`);
  assert.match(page, /const access = libraryRowAccess\(\{ kind: artifact\.kind, owner \}\);/);
  assert.match(page, /!access\.canShare \|\| !access\.canDelete \?/);
  assert.match(page, /Shared by \{access\.ownerLabel\}/);
  assert.match(page, /onClick=\{\(\) => setActive\(\{ artifact, panel: "share" \}\)\}/);
  assert.doesNotMatch(page, /\{owner !== undefined \? \(\n\s*<MenuItem icon="users" disabled>/);
});

test("the library lists the caller's own rows and only shared rows someone granted, never another account's", () => {
  const route = readFileSync(new URL("../apps/api/src/routes/library.ts", import.meta.url), "utf8");
  assert.match(
    route,
    /const ownedPredicate = \(ownerId: string\) => and\(eq\(artifacts\.ownerId, ownerId\), isNull\(artifacts\.deletedAt\)\);/,
  );
  assert.match(
    route,
    /\.from\(artifacts\)\s*\.innerJoin\(artifactShares, eq\(artifactShares\.artifactId, artifacts\.id\)\)/,
  );
  assert.match(route, /eq\(artifactShares\.sharedWithUserId, userId\)/);
  assert.match(route, /and\(eq\(artifacts\.id, artifactId\), readableArtifactPredicate\(userId\)\)/);
});

test("creating from an example opens the canvas for a Design and the viewer for a Page", () => {
  assert.equal(ownArtifactOpenHref("canvas", DESIGN), `/canvas/${DESIGN}`);
  assert.equal(ownArtifactOpenHref("html", PAGE), `/artifact/${PAGE}`);
  assert.equal(ownArtifactOpenHref("markdown", PAGE), `/artifact/${PAGE}`);
  const dialog = source(`${SRC}/ExampleDialog.tsx`);
  assert.match(dialog, /exampleCatalog\(\)/);
  assert.match(dialog, /createExampleArtifact\(chosen\)/);
  assert.match(dialog, /ownArtifactOpenHref\(result\.value\.kind, result\.value\.id\)/);
  assert.match(dialog, /role="radio"/);
  assert.match(dialog, /labelFor\(entry\.kind\)/);
  assert.match(source(`${SRC}/LibraryPage.tsx`), /<ExampleDialog onClose=\{\(\) => setExampleOpen\(false\)\} \/>/);
});
