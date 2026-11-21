import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";

import { artifactKindSchema } from "@artiflow/contracts/artifacts";
import { COMMENT_ANCHOR_KINDS } from "@artiflow/contracts/comments";
import { ANCHOR_KINDS_BY_DOCUMENT } from "@artiflow/domain/comment-anchors";
import { mcpAppsViewerHtml } from "@artiflow/mcp-apps/viewer";
import {
  ARTIFACT_KINDS,
  KIND_CAPABILITIES,
  UNKNOWN_KIND,
  agentWriteFor,
  anchorKindsFor,
  auditKindMatrix,
  canCreateInApp,
  canEditInApp,
  editsDocumentInApp,
  capabilitiesFor,
  exportFormatFor,
  extensionsFor,
  glyphFor,
  isArtifactKind,
  kindForExtension,
  labelFor,
  viewerFor,
  wireNameFor,
  type ArtifactKind,
  type KindCapabilities,
} from "@artiflow/domain/kinds";

type Surface = {
  capability: keyof KindCapabilities;
  resolve: (kind: ArtifactKind) => unknown;
};

const SURFACES: readonly Surface[] = [
  { capability: "label", resolve: labelFor },
  { capability: "glyph", resolve: glyphFor },
  { capability: "viewer", resolve: viewerFor },
  { capability: "anchors", resolve: anchorKindsFor },
  { capability: "agentWrite", resolve: agentWriteFor },
  { capability: "appCreate", resolve: canCreateInApp },
  { capability: "appEdit", resolve: canEditInApp },
  { capability: "images", resolve: (kind) => capabilitiesFor(kind)?.images ?? null },
  { capability: "exportFormat", resolve: exportFormatFor },
  { capability: "extensions", resolve: extensionsFor },
];

const unresolved = (capability: keyof KindCapabilities, value: unknown): boolean =>
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (value === null && capability !== "exportFormat");

function matrixGaps(registry: Record<string, KindCapabilities>): string[] {
  const gaps = auditKindMatrix(registry);
  for (const kind of ARTIFACT_KINDS) {
    if (!isArtifactKind(kind)) {
      gaps.push(`${kind}: the single kind list holds a value isArtifactKind refuses`);
      continue;
    }
    const declared = registry[kind];
    if (declared === undefined) {
      gaps.push(`${kind}: no registry row, so no surface can resolve it`);
      continue;
    }
    for (const surface of SURFACES) {
      const resolved = surface.resolve(kind);
      if (unresolved(surface.capability, resolved))
        gaps.push(`${kind}: the ${surface.capability} surface resolves to nothing`);
      else if (JSON.stringify(resolved) !== JSON.stringify(declared[surface.capability]))
        gaps.push(`${kind}: the ${surface.capability} surface disagrees with the registry row`);
    }
    const wire = wireNameFor(kind);
    if (wire !== kind) gaps.push(`${kind}: the wire name is ${wire} instead of the kind itself`);
  }
  return gaps;
}

const withoutCapability = (
  kind: ArtifactKind,
  capability: keyof KindCapabilities,
): Record<string, KindCapabilities> => {
  const row = { ...KIND_CAPABILITIES[kind] } as Record<string, unknown>;
  delete row[capability];
  return { ...KIND_CAPABILITIES, [kind]: row as unknown as KindCapabilities };
};

test("every kind in the single kind list resolves through every surface", () => {
  assert.deepEqual(Object.keys(KIND_CAPABILITIES).sort(), [...ARTIFACT_KINDS].sort());
  assert.deepEqual(auditKindMatrix(KIND_CAPABILITIES), []);
  assert.deepEqual(matrixGaps(KIND_CAPABILITIES), []);
});

test("the surface table covers every declared capability key", () => {
  const declared = Object.keys(KIND_CAPABILITIES.html).sort();
  assert.deepEqual(
    SURFACES.map((surface) => surface.capability).sort(),
    declared,
    "a new capability needs its own deliberate row here",
  );
  for (const kind of ARTIFACT_KINDS)
    assert.deepEqual(Object.keys(KIND_CAPABILITIES[kind]).sort(), declared, `${kind} declares the same keys`);
});

test("each surface names a known kind rather than the unknown fallback", () => {
  for (const kind of ARTIFACT_KINDS) {
    assert.equal(isArtifactKind(kind), true);
    for (const surface of SURFACES)
      assert.equal(unresolved(surface.capability, surface.resolve(kind)), false, surface.capability);
    assert.equal(wireNameFor(kind), kind);
    assert.notEqual(wireNameFor(kind), UNKNOWN_KIND);
  }
  assert.equal(wireNameFor(""), UNKNOWN_KIND);
  assert.equal(wireNameFor("deck"), UNKNOWN_KIND);
  assert.equal(capabilitiesFor(UNKNOWN_KIND), null);
  assert.equal(capabilitiesFor("deck"), null);
});

test("the two shipped kinds declare exactly the capabilities the product promises", () => {
  assert.deepEqual(KIND_CAPABILITIES.html, {
    label: "Page",
    glyph: "html",
    viewer: "sandboxed-html",
    anchors: ["element", "page-point"],
    agentWrite: "replace-document",
    appCreate: false,
    appEdit: false,
    images: false,
    exportFormat: null,
    extensions: [".html", ".htm"],
  });
  assert.deepEqual(KIND_CAPABILITIES.markdown, {
    label: "Doc",
    glyph: "markdown",
    viewer: "inline-markdown",
    anchors: ["text-range"],
    agentWrite: "text-operations",
    appCreate: true,
    appEdit: true,
    images: true,
    exportFormat: ".md",
    extensions: [".md", ".markdown"],
  });
});

test("deleting a registry row breaks the matrix instead of passing silently", () => {
  const { html: removed, ...withoutHtml } = KIND_CAPABILITIES;
  assert.notEqual(removed, undefined);
  const gaps = matrixGaps(withoutHtml);
  assert.notEqual(gaps.length, 0, "a missing row must produce a gap");
  assert.ok(
    gaps.some((gap) => gap.startsWith("html:")),
    "the gap names the kind that lost its row",
  );
  let audited: string[] = [];
  assert.doesNotThrow(() => {
    audited = auditKindMatrix(withoutHtml);
  }, "a missing row is a reported gap, never a throw");
  assert.notEqual(audited.length, 0);
  assert.ok(
    audited.some((gap) => gap.startsWith("html:")),
    "the audit itself names the kind that lost its row",
  );
});

test("a row missing one capability is a gap, not a silently degraded kind", () => {
  for (const capability of ["viewer", "anchors", "agentWrite", "label"] as const) {
    const registry = withoutCapability("markdown", capability);
    const gaps = matrixGaps(registry);
    assert.notEqual(gaps.length, 0, `markdown without ${capability} must be a gap`);
    assert.ok(
      gaps.some((gap) => gap.includes(capability)),
      `the gap names ${capability}`,
    );
    assert.notEqual(auditKindMatrix(registry).length, 0);
  }
});

test("the document-editing gate is the registry conjunct, not a kind name", () => {
  for (const kind of ARTIFACT_KINDS)
    assert.equal(
      editsDocumentInApp(kind),
      canEditInApp(kind) && agentWriteFor(kind) === "text-operations",
      `a kind may edit its document in the app only when both capabilities allow it: ${kind}`,
    );
  assert.equal(editsDocumentInApp("html"), false);
  assert.equal(editsDocumentInApp("markdown"), true);
  assert.equal(editsDocumentInApp("deck"), false);
});

test("the contracts kind enum stays pinned to the registry plus unknown", () => {
  assert.deepEqual([...artifactKindSchema.options].sort(), [...ARTIFACT_KINDS, UNKNOWN_KIND].sort());
});

test("every anchor kind the registry accepts is declared by the comment contract", () => {
  for (const kind of ARTIFACT_KINDS)
    for (const anchor of anchorKindsFor(kind))
      assert.ok(
        (COMMENT_ANCHOR_KINDS as readonly string[]).includes(anchor),
        `${kind} accepts ${anchor}, which COMMENT_ANCHOR_KINDS must declare`,
      );
});

test("the legacy anchor map re-exports the registry rows unchanged", () => {
  for (const kind of ARTIFACT_KINDS) assert.deepEqual(ANCHOR_KINDS_BY_DOCUMENT[kind], KIND_CAPABILITIES[kind].anchors);
});

test("the registry survives a row that lost a capability without throwing", () => {
  let gaps: string[] = [];
  for (const capability of ["viewer", "anchors", "agentWrite", "label"] as const)
    assert.doesNotThrow(() => {
      gaps = auditKindMatrix(withoutCapability("markdown", capability));
    }, `a row without ${capability} must not throw`);
  assert.notEqual(gaps.length, 0);
});

test("the viewer generator emits one parseable script holding today's registry map", () => {
  const html = mcpAppsViewerHtml();
  assert.match(html, /^<!DOCTYPE html>/, "the viewer stays a complete HTML5 document");
  assert.equal([...html.matchAll(/<script\b/g)].length, 1, "the viewer ships exactly one inline script");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.ok(script.length > 0, "the inline script is extractable");
  assert.doesNotThrow(() => new Script(script), "the script stays syntactically parseable");
  const map = JSON.stringify(Object.fromEntries(ARTIFACT_KINDS.map((kind) => [kind, KIND_CAPABILITIES[kind].viewer])));
  assert.ok(script.includes(`var KIND_VIEWERS = ${map};`), "today's two kinds emit byte-identical map data");
  assert.equal(map.includes("<"), false, "the emitted map carries no character that could close the script tag");
});

test("file extensions map to a kind through the registry and fall back to the default kind", () => {
  for (const kind of ARTIFACT_KINDS)
    for (const extension of extensionsFor(kind)) assert.equal(kindForExtension(extension), kind);
  assert.equal(kindForExtension(".MD"), "markdown");
  assert.equal(kindForExtension(".txt"), null);
});
