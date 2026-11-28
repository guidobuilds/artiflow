import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";

import { artifactKindSchema } from "@artiflow/contracts/artifacts";
import { COMMENT_ANCHOR_KINDS } from "@artiflow/contracts/comments";
import { ANCHOR_KINDS_BY_DOCUMENT } from "@artiflow/domain/comment-anchors";
import { mcpAppsViewerHtml } from "@artiflow/mcp-apps/viewer";
import { displayName } from "@artiflow/plugin-core/associations";
import { fileKind } from "@artiflow/plugin-core/write-kind";
import {
  ARTIFACT_KINDS,
  KIND_CAPABILITIES,
  KIND_ICONS,
  UNKNOWN_KIND,
  acceptsComments,
  acceptsTextOperations,
  agentWriteFor,
  anchorKindsFor,
  auditKindMatrix,
  canEditInApp,
  capabilitiesFor,
  editsDocumentInApp,
  editsSceneInApp,
  extensionsFor,
  iconFor,
  isArtifactKind,
  kindForExtension,
  labelFor,
  pluralFor,
  rendersInlineMarkdown,
  rendersSandboxedHtml,
  rendersScene,
  titleSourceFor,
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
  { capability: "plural", resolve: pluralFor },
  { capability: "icon", resolve: iconFor },
  { capability: "viewer", resolve: viewerFor },
  { capability: "anchors", resolve: anchorKindsFor },
  { capability: "comments", resolve: acceptsComments },
  { capability: "agentWrite", resolve: agentWriteFor },
  { capability: "titleSource", resolve: titleSourceFor },
  { capability: "appEdit", resolve: canEditInApp },
  { capability: "extensions", resolve: extensionsFor },
];

const EXPECTED: Record<ArtifactKind, KindCapabilities> = {
  html: {
    label: "Page",
    plural: "Pages",
    icon: "page",
    viewer: "sandboxed-html",
    anchors: ["element", "page-point"],
    comments: true,
    agentWrite: "replace-document",
    titleSource: "html-title",
    appEdit: false,
    extensions: [".html", ".htm"],
  },
  markdown: {
    label: "Doc",
    plural: "Docs",
    icon: "document",
    viewer: "inline-markdown",
    anchors: ["text-range"],
    comments: true,
    agentWrite: "text-operations",
    titleSource: "first-heading",
    appEdit: true,
    extensions: [".md", ".markdown"],
  },
  canvas: {
    label: "Design",
    plural: "Designs",
    icon: "canvas",
    viewer: "scene",
    anchors: ["board-point"],
    comments: true,
    agentWrite: "replace-document",
    titleSource: "frame-name",
    appEdit: true,
    extensions: [".canvas", ".scene.json"],
  },
  deck: {
    label: "Deck",
    plural: "Decks",
    icon: "slides",
    viewer: "scene",
    anchors: ["slide-point"],
    comments: true,
    agentWrite: "replace-document",
    titleSource: "frame-name",
    appEdit: false,
    extensions: [".deck"],
  },
};

const unresolved = (value: unknown): boolean =>
  value === undefined || value === "" || value === null || (Array.isArray(value) && value.length === 0);

const silent = (capability: keyof KindCapabilities, row: KindCapabilities | undefined): boolean =>
  capability === "anchors" && row?.comments === false;

const missing = (capability: keyof KindCapabilities, row: KindCapabilities | undefined, resolved: unknown): boolean =>
  silent(capability, row) ? resolved === undefined : unresolved(resolved);

const withoutRow = (kind: ArtifactKind): Record<string, KindCapabilities> => {
  const registry = { ...KIND_CAPABILITIES } as Record<string, KindCapabilities>;
  delete registry[kind];
  return registry;
};

const withoutCapability = (
  kind: ArtifactKind,
  capability: keyof KindCapabilities,
): Record<string, KindCapabilities> => {
  const row = { ...KIND_CAPABILITIES[kind] } as Record<string, unknown>;
  delete row[capability];
  return { ...KIND_CAPABILITIES, [kind]: row as unknown as KindCapabilities };
};

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
      if (missing(surface.capability, declared, resolved))
        gaps.push(`${kind}: the ${surface.capability} surface resolves to nothing`);
      else if (JSON.stringify(resolved) !== JSON.stringify(declared[surface.capability]))
        gaps.push(`${kind}: the ${surface.capability} surface disagrees with the registry row`);
    }
    const wire = wireNameFor(kind);
    if (wire !== kind) gaps.push(`${kind}: the wire name is ${wire} instead of the kind itself`);
  }
  return gaps;
}

function declarationGaps(registry: Record<string, KindCapabilities>): string[] {
  const gaps: string[] = [];
  for (const kind of ARTIFACT_KINDS) {
    const row = registry[kind];
    if (row === undefined) {
      gaps.push(`${kind}: no registry row to declare`);
      continue;
    }
    if (JSON.stringify(row) !== JSON.stringify(EXPECTED[kind]))
      gaps.push(`${kind}: declared capabilities differ from the promised matrix`);
    if (JSON.stringify(ANCHOR_KINDS_BY_DOCUMENT[kind]) !== JSON.stringify(row.anchors))
      gaps.push(`${kind}: the legacy anchor map disagrees with the row`);
  }
  return gaps;
}

test("every kind in the single kind list resolves through every surface", () => {
  assert.deepEqual(Object.keys(KIND_CAPABILITIES).sort(), [...ARTIFACT_KINDS].sort());
  assert.deepEqual(auditKindMatrix(KIND_CAPABILITIES), []);
  assert.deepEqual(matrixGaps(KIND_CAPABILITIES), []);
  assert.deepEqual(declarationGaps(KIND_CAPABILITIES), []);
});

test("the surface table covers every declared capability key", () => {
  const declared = [...new Set(Object.values(KIND_CAPABILITIES).flatMap((row) => Object.keys(row)))].sort();
  assert.deepEqual(
    SURFACES.map((surface) => surface.capability).sort(),
    declared,
    "a new capability needs its own deliberate row here",
  );
  for (const kind of ARTIFACT_KINDS) {
    const row = KIND_CAPABILITIES[kind];
    if (row === undefined) continue;
    assert.deepEqual(Object.keys(row).sort(), declared, `${kind} declares the same keys`);
  }
});

test("each surface names a known kind rather than the unknown fallback", () => {
  for (const kind of ARTIFACT_KINDS) {
    assert.equal(isArtifactKind(kind), true);
    for (const surface of SURFACES)
      assert.equal(
        missing(surface.capability, KIND_CAPABILITIES[kind], surface.resolve(kind)),
        false,
        surface.capability,
      );
    assert.equal(wireNameFor(kind), kind);
    assert.notEqual(wireNameFor(kind), UNKNOWN_KIND);
  }
  assert.equal(wireNameFor(""), UNKNOWN_KIND);
  assert.equal(wireNameFor("pptx"), UNKNOWN_KIND);
  assert.equal(capabilitiesFor(UNKNOWN_KIND), null);
  assert.equal(capabilitiesFor("pptx"), null);
});

test("every shipped kind declares exactly the capabilities the product promises", () => {
  for (const kind of ARTIFACT_KINDS) {
    const row = KIND_CAPABILITIES[kind];
    if (row === undefined) {
      assert.fail(`${kind}: the registry has no row, so its capabilities cannot be checked`);
      continue;
    }
    assert.deepEqual(row, EXPECTED[kind], `${kind} declares the promised matrix`);
  }
  for (const kind of ARTIFACT_KINDS) {
    const row = KIND_CAPABILITIES[kind];
    if (row === undefined) continue;
    assert.ok((KIND_ICONS as readonly string[]).includes(row.icon), `${kind} names a registry icon`);
  }
});

test("an icon outside the registry vocabulary is a gap, not a wrong picture", () => {
  const bogus = { ...KIND_CAPABILITIES, markdown: { ...KIND_CAPABILITIES.markdown, icon: "sparkle" as never } };
  const gaps = auditKindMatrix(bogus);
  assert.notEqual(gaps.length, 0);
  assert.ok(
    gaps.some((gap) => gap.includes("icon") && gap.includes("sparkle")),
    "the gap names the icon that has no vocabulary entry",
  );
  for (const capability of ["icon", "titleSource"] as const) {
    const registry = withoutCapability("markdown", capability);
    const found = matrixGaps(registry);
    assert.notEqual(found.length, 0, `markdown without ${capability} must be a gap`);
    assert.ok(
      found.some((gap) => gap.includes(capability)),
      `the gap names ${capability}`,
    );
  }
});

test("every kind carries its own icon and its own plural, not the html ones", () => {
  assert.deepEqual(
    ARTIFACT_KINDS.map(iconFor),
    ["page", "document", "canvas", "slides"],
    "a new kind gets its own icon",
  );
  assert.deepEqual(ARTIFACT_KINDS.map(pluralFor), ["Pages", "Docs", "Designs", "Decks"]);
  for (const kind of ARTIFACT_KINDS)
    assert.ok((KIND_ICONS as readonly string[]).includes(iconFor(kind)), `${kind} names a registry icon`);
  assert.equal(pluralFor("canvas"), KIND_CAPABILITIES.canvas.plural, "a kind answers with the plural it declares");
  assert.notEqual(pluralFor("canvas"), pluralFor("html"), "the two creation outputs name themselves differently");
  assert.notEqual(labelFor("canvas"), labelFor("html"), "a person reads Design, never Page, on a canvas kind");
  assert.equal(pluralFor(UNKNOWN_KIND), "Unknown");
  assert.equal(pluralFor("pptx"), "Unknown");
});

test("a canvas write derives its title from the first frame name", () => {
  const scene = JSON.stringify({
    formatVersion: 1,
    frames: [
      { id: "f1", name: "  Onboarding\n flow ", x: 0, y: 0, w: 100, h: 100, nodes: [] },
      { id: "f2", name: "Second", x: 200, y: 0, w: 100, h: 100, nodes: [] },
    ],
  });
  assert.equal(titleSourceFor("canvas"), "frame-name");
  assert.equal(displayName({ kind: "canvas", text: scene }), "Onboarding flow");
  assert.equal(displayName({ title: "Chosen", kind: "canvas", text: scene }), "Chosen", "an explicit title wins");
  assert.equal(
    displayName({ kind: "canvas", text: JSON.stringify({ formatVersion: 2, frames: [] }) }),
    undefined,
    "a newer scene is not half read for a title",
  );
  assert.equal(displayName({ kind: "canvas", text: "not json" }), undefined);
});

test("deleting a registry row breaks the matrix instead of passing silently", () => {
  const registry = withoutRow("html");
  const gaps = matrixGaps(registry);
  assert.notEqual(gaps.length, 0, "a missing row must produce a gap");
  assert.ok(
    gaps.some((gap) => gap.startsWith("html:")),
    "the gap names the kind that lost its row",
  );
  let audited: string[] = [];
  assert.doesNotThrow(() => {
    audited = auditKindMatrix(registry);
  }, "a missing row is a reported gap, never a throw");
  assert.notEqual(audited.length, 0);
  assert.ok(
    audited.some((gap) => gap.startsWith("html:")),
    "the audit itself names the kind that lost its row",
  );
});

test("a row that is present but undefined is a named gap, not a crash", () => {
  const registry = { ...KIND_CAPABILITIES, html: undefined } as unknown as Record<string, KindCapabilities>;
  let gaps: string[] = [];
  assert.doesNotThrow(() => {
    gaps = auditKindMatrix(registry);
  }, "a present-but-undefined row is a reported gap, never a dereference");
  assert.ok(
    gaps.some((gap) => gap.startsWith("html:")),
    "the gap names the kind whose row is undefined",
  );
  assert.doesNotThrow(() => {
    gaps = [...matrixGaps(registry), ...declarationGaps(registry)];
  }, "the whole matrix survives a present-but-undefined row");
  assert.ok(
    gaps.some((gap) => gap.startsWith("html:")),
    "the matrix still names the kind whose row is undefined",
  );
});

test("the whole matrix reports gaps instead of throwing when a row is missing", () => {
  const registry = withoutRow("html");
  let gaps: string[] = [];
  assert.doesNotThrow(() => {
    gaps = [...matrixGaps(registry), ...declarationGaps(registry)];
  }, "a missing row must not trip a TypeError anywhere in the matrix");
  assert.ok(
    gaps.some((gap) => gap.startsWith("html:")),
    "at least one gap names the kind that lost its row",
  );
  assert.equal(
    gaps.some((gap) => gap.includes("TypeError")),
    false,
    "gaps are diagnostics, never captured crash text",
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
      canEditInApp(kind) && acceptsTextOperations(kind),
      `a kind may edit its document in the app only when both capabilities allow it: ${kind}`,
    );
  assert.equal(editsDocumentInApp("html"), false);
  assert.equal(editsDocumentInApp("markdown"), true);
  assert.equal(editsDocumentInApp("deck"), false);
  assert.equal(
    editsDocumentInApp("canvas"),
    false,
    "a canvas is editable in the app without being a document the text gate admits",
  );
});

test("the scene-editing gate is the registry conjunct too, and only a scene viewer qualifies", () => {
  for (const kind of ARTIFACT_KINDS)
    assert.equal(
      editsSceneInApp(kind),
      canEditInApp(kind) && viewerFor(kind) === "scene",
      `a kind may edit its scene in the app only when both capabilities allow it: ${kind}`,
    );
  assert.equal(canEditInApp("canvas"), true, "a canvas is edited in the app");
  assert.equal(editsSceneInApp("canvas"), true);
  assert.equal(editsSceneInApp("markdown"), false, "the document editor is not reached through the scene gate");
  assert.equal(editsSceneInApp("html"), false);
  assert.equal(editsSceneInApp("deck"), false);
  assert.equal(editsSceneInApp(UNKNOWN_KIND), false);
});

test("the composed predicates answer for every kind and fail closed for unknown ones", () => {
  assert.equal(rendersSandboxedHtml("html"), true);
  assert.equal(rendersSandboxedHtml("markdown"), false);
  assert.equal(rendersInlineMarkdown("markdown"), true);
  assert.equal(rendersInlineMarkdown("html"), false);
  assert.equal(acceptsTextOperations("markdown"), true);
  assert.equal(acceptsTextOperations("html"), false);
  for (const kind of ["", "deck", UNKNOWN_KIND])
    for (const predicate of [rendersSandboxedHtml, rendersInlineMarkdown, acceptsTextOperations])
      assert.equal(predicate(kind), false, `${predicate.name} is false for ${JSON.stringify(kind)}`);
});

test("the scene gate is the registry viewer, and a deck is a scene", () => {
  assert.deepEqual(
    ARTIFACT_KINDS.filter(rendersScene),
    ["canvas", "deck"],
    "the scene gate names every kind whose viewer is the scene renderer, and only those",
  );
  for (const kind of ARTIFACT_KINDS) assert.equal(rendersScene(kind), viewerFor(kind) === "scene", kind);
  for (const kind of ["", "pptx", UNKNOWN_KIND]) assert.equal(rendersScene(kind), false, JSON.stringify(kind));
  assert.equal(editsSceneInApp("deck"), false, "a deck is presented and edited by an agent, not in the app yet");
});

test("the contracts kind enum stays pinned to the registry plus unknown", () => {
  assert.deepEqual([...artifactKindSchema.options].sort(), [...ARTIFACT_KINDS, UNKNOWN_KIND].sort());
  assert.deepEqual(
    [...artifactKindSchema.options],
    ["html", "markdown", "canvas", "deck", "unknown"],
    "four kinds and the unknown fallback are pinned",
  );
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
  for (const kind of ARTIFACT_KINDS) {
    const row = KIND_CAPABILITIES[kind];
    if (row === undefined) {
      assert.fail(`${kind}: the registry has no row, so the anchor map cannot be compared`);
      continue;
    }
    assert.deepEqual(ANCHOR_KINDS_BY_DOCUMENT[kind], row.anchors);
  }
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
  const map = JSON.stringify(Object.fromEntries(ARTIFACT_KINDS.map((kind) => [kind, viewerFor(kind)])));
  assert.ok(script.includes(`var KIND_VIEWERS = ${map};`), "every kind's viewer strategy is the emitted map data");
  assert.equal(mcpAppsViewerHtml(KIND_CAPABILITIES), html, "the default capability map is the registry itself");
});

test("file extensions map to a kind through the registry and fall back to the default kind", () => {
  for (const kind of ARTIFACT_KINDS)
    for (const extension of extensionsFor(kind)) assert.equal(kindForExtension(extension), kind);
  assert.equal(kindForExtension(".MD"), "markdown");
  assert.equal(kindForExtension(".txt"), null);
  assert.equal(kindForExtension(".canvas"), "canvas");
  assert.equal(kindForExtension(".SCENE.JSON"), "canvas");
  assert.equal(kindForExtension(".scene"), null, "the compound suffix is one extension, not two guesses");
});

test("a written file resolves to its kind by the longest declared suffix", () => {
  for (const kind of ARTIFACT_KINDS)
    for (const extension of extensionsFor(kind)) assert.equal(fileKind(`design${extension}`), kind, extension);
  assert.deepEqual(
    ["page.html", "legacy.HTM", "notes.md", "notes.Markdown", "readme.txt", "noext", "a.b.html"].map(fileKind),
    ["html", "html", "markdown", "markdown", "html", "html", "html"],
    "the kinds that shipped before the scene keep their mapping",
  );
  assert.equal(fileKind("board.scene.json"), "canvas", "the compound suffix beats the plain .json reading");
  assert.equal(fileKind("board.CANVAS"), "canvas");
});

test("a canvas row that disappears or loses its row breaks the matrix", () => {
  const removed = matrixGaps(withoutRow("canvas"));
  assert.notEqual(removed.length, 0, "a scene kind with no row must be a gap");
  assert.ok(
    removed.some((gap) => gap === "canvas: ARTIFACT_KINDS declares a row this registry does not have"),
    "the gap names canvas",
  );
  const audited = auditKindMatrix(withoutRow("canvas"));
  assert.ok(
    audited.some((gap) => gap.startsWith("canvas:")),
    "the audit itself names canvas",
  );
});

test("a kind that declares comments must accept an anchor, and losing the canvas one is a gap", () => {
  assert.deepEqual(auditKindMatrix(KIND_CAPABILITIES), [], "the shipped matrix is green with canvas commenting");
  assert.equal(acceptsComments("canvas"), true);
  assert.deepEqual(anchorKindsFor("canvas"), ["board-point"]);
  assert.deepEqual([...anchorKindsFor("canvas")].sort(), ["board-point"], "a canvas anchor names a node");

  const anchorless = {
    ...KIND_CAPABILITIES,
    canvas: { ...KIND_CAPABILITIES.canvas, anchors: [] as never },
  };
  const gaps = matrixGaps(anchorless);
  assert.notEqual(gaps.length, 0, "comments without anchors is a gap");
  assert.ok(
    gaps.some((gap) => gap.startsWith("canvas:") && gap.includes("anchor")),
    "the gap names the kind and its missing anchor kind",
  );
  assert.ok(
    auditKindMatrix(anchorless).some((gap) => gap.startsWith("canvas:") && gap.includes("anchor")),
    "the audit keeps the same rule",
  );

  const silent = {
    ...KIND_CAPABILITIES,
    canvas: { ...KIND_CAPABILITIES.canvas, anchors: [] as never, comments: false },
  };
  assert.deepEqual(auditKindMatrix(silent), [], "a kind that declares no comments may accept no anchor kinds");

  const undeclared = { ...KIND_CAPABILITIES, canvas: { ...KIND_CAPABILITIES.canvas, comments: undefined as never } };
  assert.ok(
    auditKindMatrix(undeclared).some((gap) => gap.startsWith("canvas:") && gap.includes("comments")),
    "a kind that never says whether it has comments is a gap",
  );
});

test("the shipped matrix is green with four kinds and refuses a deck without its row or its anchor", () => {
  assert.deepEqual(auditKindMatrix(KIND_CAPABILITIES), [], "the shipped matrix is green");
  assert.equal(ARTIFACT_KINDS.length, 4, "four kinds ship");
  assert.equal(acceptsComments("deck"), true);
  assert.deepEqual(anchorKindsFor("deck"), ["slide-point"]);
  assert.equal(anchorKindsFor("deck").includes("slide-point"), true, "slide-point is reachable now");

  const removed = matrixGaps(withoutRow("deck"));
  assert.notEqual(removed.length, 0, "a deck with no row must be a gap");
  assert.ok(
    removed.some((gap) => gap === "deck: ARTIFACT_KINDS declares a row this registry does not have"),
    "the gap names deck",
  );
  assert.ok(
    auditKindMatrix(withoutRow("deck")).some((gap) => gap.startsWith("deck:")),
    "the audit itself names deck",
  );

  const anchorless = { ...KIND_CAPABILITIES, deck: { ...KIND_CAPABILITIES.deck, anchors: [] as never } };
  assert.ok(
    matrixGaps(anchorless).some((gap) => gap.startsWith("deck:") && gap.includes("anchor")),
    "a deck that keeps comments but loses slide-point is a gap",
  );
});

test("a compound extension is a declared suffix, not a shape violation", () => {
  assert.deepEqual(
    extensionsFor("canvas").filter((extension) => extension.includes(".", 1)),
    [".scene.json"],
    "the scene extension is registered with both of its segments",
  );
  for (const extension of ["scene", ".Scene.json", "."] as const) {
    const broken = {
      ...KIND_CAPABILITIES,
      canvas: { ...KIND_CAPABILITIES.canvas, extensions: [extension as never] },
    };
    assert.ok(
      auditKindMatrix(broken).some((gap) => gap.includes("not a lowercase dotted suffix")),
      `${JSON.stringify(extension)} is refused as an extension shape`,
    );
  }
});

test("an extension lookup against a registry without the row resolves to null instead of throwing", () => {
  const registry = withoutRow("html");
  let mapped: ArtifactKind | null = "html";
  assert.doesNotThrow(() => {
    mapped = kindForExtension(".html", registry);
  }, "a missing row is no extension match, never a throw");
  assert.equal(mapped, null);
  assert.equal(kindForExtension(".htm", registry), null);
  assert.equal(kindForExtension(".md", registry), "markdown");
});
