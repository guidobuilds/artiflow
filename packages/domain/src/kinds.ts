import type { CommentAnchorKind } from "./comment-anchors.ts";

export type KindViewer = "sandboxed-html" | "inline-markdown";
export type AgentWriteMode = "replace-document" | "text-operations";

export type KindCapabilities = {
  label: string;
  glyph: string;
  viewer: KindViewer;
  anchors: readonly CommentAnchorKind[];
  agentWrite: AgentWriteMode;
  appCreate: boolean;
  appEdit: boolean;
  images: boolean;
  exportFormat: string | null;
  extensions: readonly string[];
};

export const ARTIFACT_KINDS = ["html", "markdown"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const UNKNOWN_KIND = "unknown";
export type WireKind = ArtifactKind | typeof UNKNOWN_KIND;
export const DEFAULT_ARTIFACT_KIND: ArtifactKind = "html";

export const KIND_VIEWERS: readonly KindViewer[] = ["sandboxed-html", "inline-markdown"];
export const AGENT_WRITE_MODES: readonly AgentWriteMode[] = ["replace-document", "text-operations"];

export const KIND_CAPABILITIES: Record<ArtifactKind, KindCapabilities> = {
  html: {
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
  },
  markdown: {
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
  },
};

const UNKNOWN_LABEL = "Unknown";
const UNKNOWN_GLYPH = "doc";
const EXTENSION_SHAPE = /^\.[a-z0-9]+$/;

export const isArtifactKind = (value: string): value is ArtifactKind =>
  (ARTIFACT_KINDS as readonly string[]).includes(value);

export const capabilitiesFor = (kind: string): KindCapabilities | null =>
  isArtifactKind(kind) ? KIND_CAPABILITIES[kind] : null;

export const wireNameFor = (kind: string): WireKind => (isArtifactKind(kind) ? kind : UNKNOWN_KIND);

export const anchorKindsFor = (kind: string): readonly CommentAnchorKind[] => capabilitiesFor(kind)?.anchors ?? [];

export const labelFor = (kind: string): string => capabilitiesFor(kind)?.label ?? UNKNOWN_LABEL;

export const glyphFor = (kind: string): string => capabilitiesFor(kind)?.glyph ?? UNKNOWN_GLYPH;

export const canCreateInApp = (kind: string): boolean => capabilitiesFor(kind)?.appCreate === true;

export const canEditInApp = (kind: string): boolean => capabilitiesFor(kind)?.appEdit === true;

export const exportFormatFor = (kind: string): string | null => capabilitiesFor(kind)?.exportFormat ?? null;

export const agentWriteFor = (kind: string): AgentWriteMode | null => capabilitiesFor(kind)?.agentWrite ?? null;

export const editsDocumentInApp = (kind: string): boolean =>
  canEditInApp(kind) && agentWriteFor(kind) === "text-operations";

export const extensionsFor = (kind: string): readonly string[] => capabilitiesFor(kind)?.extensions ?? [];

export const viewerFor = (kind: string): KindViewer | null => capabilitiesFor(kind)?.viewer ?? null;

export const kindForExtension = (extension: string): ArtifactKind | null => {
  const normalized = extension.toLowerCase();
  return ARTIFACT_KINDS.find((kind) => KIND_CAPABILITIES[kind].extensions.includes(normalized)) ?? null;
};

const blank = (value: unknown): boolean => typeof value !== "string" || value.trim() === "";

export function auditKindMatrix(registry: Record<string, KindCapabilities>): string[] {
  const gaps: string[] = [];
  const owners = new Map<string, string>();
  for (const kind of ARTIFACT_KINDS) {
    if (registry[kind] === undefined) gaps.push(`${kind}: ARTIFACT_KINDS declares a row this registry does not have`);
  }
  for (const [kind, capabilities] of Object.entries(registry)) {
    if (!isArtifactKind(kind)) gaps.push(`${kind}: not declared in ARTIFACT_KINDS, so no surface resolves it`);
    if (blank(capabilities.label)) gaps.push(`${kind}: label is blank`);
    if (blank(capabilities.glyph)) gaps.push(`${kind}: glyph is blank`);
    if (!KIND_VIEWERS.includes(capabilities.viewer))
      gaps.push(`${kind}: viewer ${String(capabilities.viewer)} is not a known render strategy`);
    if (!AGENT_WRITE_MODES.includes(capabilities.agentWrite))
      gaps.push(`${kind}: agent write ${String(capabilities.agentWrite)} is not a known write mode`);
    if (!Array.isArray(capabilities.anchors) || capabilities.anchors.length === 0)
      gaps.push(`${kind}: accepts no comment anchor kind`);
    else if (new Set(capabilities.anchors).size !== capabilities.anchors.length)
      gaps.push(`${kind}: repeats a comment anchor kind`);
    if (!Array.isArray(capabilities.extensions) || capabilities.extensions.length === 0)
      gaps.push(`${kind}: declares no file extension`);
    else
      for (const extension of capabilities.extensions) {
        if (!EXTENSION_SHAPE.test(extension))
          gaps.push(`${kind}: extension ${String(extension)} is not a lowercase dotted suffix`);
        const owner = owners.get(extension);
        if (owner !== undefined) gaps.push(`${kind}: extension ${extension} already belongs to ${owner}`);
        else owners.set(extension, kind);
      }
    if (capabilities.exportFormat !== null && !EXTENSION_SHAPE.test(String(capabilities.exportFormat)))
      gaps.push(`${kind}: export format ${String(capabilities.exportFormat)} is not a lowercase dotted suffix`);
  }
  return gaps;
}
