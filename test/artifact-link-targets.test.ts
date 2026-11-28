import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseArtifactLink, artifactLinkHref, isCanonicalArtifactId } from "../packages/domain/src/artifact-link.ts";
import { parseSceneLink, sceneLinkGap, sceneViewHref } from "../packages/domain/src/scene-link.ts";
import { readScene } from "../packages/domain/src/scene.ts";
import { missingTargetPage } from "../apps/api/src/viewer/chrome/theme.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const ARTIFACT = "b6a0d5f0-3c0f-4b1c-9a3e-0e6a5c8d3f21";
const REVISION = "0d6f9a2c-1b7e-4a55-8f2d-2f1c9b6d4e70";

const scene = (extra: Record<string, unknown> = {}) =>
  readScene(
    JSON.stringify({
      formatVersion: 1,
      frames: [
        {
          id: "board-a",
          name: "A",
          x: 0,
          y: 0,
          w: 390,
          h: 844,
          nodes: [],
          source: { artifactId: ARTIFACT, revisionId: REVISION, mode: "fluid" },
        },
      ],
      ...extra,
    }),
  );

const sceneOf = () => {
  const parsed = scene({ pages: [{ id: "review", name: "Review" }] });
  assert.equal(parsed.ok, true);
  return parsed.ok ? parsed.value : (undefined as never);
};

test("a viewer link names the artifact, the version, the artboard and the view it points at", () => {
  const parsed = parseArtifactLink(
    `https://artiflow.example/artifact/${ARTIFACT}?revision=${REVISION}&view=focus&frame=board-a&width=390&page=review`,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.link, {
    artifactId: ARTIFACT,
    revisionId: REVISION,
    scene: { view: "focus", frameId: "board-a", width: 390, page: "review" },
  });
  assert.equal(isCanonicalArtifactId(ARTIFACT), true);
});

test("a path-only link works and defaults to the whole canvas without a pinned version", () => {
  const parsed = parseArtifactLink(`  /artifact/${ARTIFACT}  `);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.link.revisionId, null);
  assert.deepEqual(parsed.link.scene, { view: "canvas", frameId: null, width: null, page: null });
});

test("a link this build cannot use is refused with the reason, never guessed into another artifact", () => {
  const seats: Array<[string, string]> = [
    ["", "blank"],
    ["   ", "blank"],
    ["nope", "not_an_artifact_link"],
    [`/s/${"a".repeat(32)}`, "not_an_artifact_link"],
    [`/artifact/${ARTIFACT.toUpperCase()}`, "invalid_artifact_id"],
    ["/artifact/not-a-uuid", "invalid_artifact_id"],
    [`/artifact/${ARTIFACT}?revision=nope`, "invalid_revision_id"],
    [`ftp://example.com/artifact/${ARTIFACT}`, "not_a_link"],
    [`https://user:pass@example.com/artifact/${ARTIFACT}`, "not_a_link"],
    [`/artifact/${ARTIFACT}?revision=${"x".repeat(2000)}`, "too_long"],
  ];
  for (const [value, reason] of seats) {
    const parsed = parseArtifactLink(value);
    assert.equal(parsed.ok, false, value.slice(0, 40));
    if (parsed.ok) continue;
    assert.equal(parsed.reason, reason, value.slice(0, 40));
  }
});

test("every parsed link rebuilds the same link, so a reference survives a round trip", () => {
  const href = artifactLinkHref({
    artifactId: ARTIFACT,
    revisionId: REVISION,
    scene: { view: "play", frameId: "board-a", width: 1280, page: null },
  });
  assert.equal(href, `/artifact/${ARTIFACT}?revision=${REVISION}&frame=board-a&view=play&width=1280`);
  const again = parseArtifactLink(href);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.deepEqual(again.link, {
    artifactId: ARTIFACT,
    revisionId: REVISION,
    scene: { view: "play", frameId: "board-a", width: 1280, page: null },
  });
  assert.equal(artifactLinkHref(again.link), href);
  assert.equal(sceneViewHref(`/artifact/${ARTIFACT}`, parseSceneLink(new URLSearchParams())), `/artifact/${ARTIFACT}`);
});

test("a named artboard or page that the artifact no longer holds is reported, not replaced", () => {
  const value = sceneOf();
  assert.equal(sceneLinkGap(value, { view: "canvas", frameId: "board-a", width: null, page: null }), null);
  assert.equal(sceneLinkGap(value, { view: "canvas", frameId: "board-gone", width: null, page: null }), "artboard");
  assert.equal(sceneLinkGap(value, { view: "focus", frameId: "board-gone", width: 390, page: null }), "artboard");
  assert.equal(sceneLinkGap(value, { view: "canvas", frameId: null, width: null, page: "review" }), null);
  assert.equal(sceneLinkGap(value, { view: "canvas", frameId: null, width: null, page: "epsilon" }), "page");
  const pageless = scene();
  assert.equal(pageless.ok, true);
  if (!pageless.ok) return;
  assert.equal(sceneLinkGap(pageless.value, { view: "canvas", frameId: null, width: null, page: "review" }), "page");
});

test("the answer for a missing target names what is gone and points at the artifact itself", () => {
  const artboard = missingTargetPage("artboard", `/artifact/${ARTIFACT}`);
  assert.match(artboard, /This artboard isn&#39;t here\./);
  assert.match(artboard, /<\/main>/);
  assert.match(artboard, new RegExp(`<a href="/artifact/${ARTIFACT}">Back to the Design</a>`));
  assert.doesNotMatch(artboard, /<iframe/);
  const revision = missingTargetPage("revision", `/artifact/${ARTIFACT}`);
  assert.match(revision, /404 · Version not found/);
  assert.match(revision, /Open the artifact/);
  const escaped = missingTargetPage("page", `/artifact/"><script>alert(1)</script>`);
  assert.doesNotMatch(escaped, /<script>alert\(1\)<\/script>/);
  assert.match(escaped, /&quot;&gt;&lt;script&gt;/);
});

test("both viewer routes ask which target is missing before they plan a view", () => {
  for (const path of ["../apps/api/src/routes/library.ts", "../apps/api/src/routes/sharing.ts"]) {
    const page = source(path);
    const gap = page.indexOf("sceneLinkGap(");
    const plan = page.indexOf("planSceneView(");
    assert.notEqual(gap, -1, `${path} checks the link target`);
    assert.notEqual(plan, -1, `${path} still plans the view`);
    assert.ok(gap < plan, `${path} refuses a missing target before planning another view`);
    assert.match(
      page,
      /const gap = sceneLinkGap\([\s\S]{0,200}?return c\.html\(missingTargetPage\(gap, [\s\S]{0,160}?const plan = planSceneView\(/,
    );
  }
  assert.match(
    source("../apps/api/src/routes/library.ts"),
    /if \(requestedRevisionId !== undefined && pinnedRow === undefined\)[\s\S]{0,80}?missingTargetPage\("revision", artifactHref\)/,
  );
});
