import type { CommentAnchorKind } from "./comment-anchors.ts";

export type KindViewer = "sandboxed-html" | "inline-markdown";
export type AgentWriteMode = "replace-document" | "text-operations";
export type TitleSource = "html-title" | "first-heading";

export const KIND_VIEWERS: readonly KindViewer[] = ["sandboxed-html", "inline-markdown"];
export const AGENT_WRITE_MODES: readonly AgentWriteMode[] = ["replace-document", "text-operations"];
export const TITLE_SOURCES: readonly TitleSource[] = ["html-title", "first-heading"];
export const KIND_ICONS = ["page", "document", "unknown"] as const;
export type KindIcon = (typeof KIND_ICONS)[number];

export type KindCapabilities = {
  label: string;
  icon: KindIcon;
  viewer: KindViewer;
  anchors: readonly CommentAnchorKind[];
  agentWrite: AgentWriteMode;
  titleSource: TitleSource;
  appEdit: boolean;
  extensions: readonly string[];
};

export const ARTIFACT_KINDS = ["html", "markdown"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const UNKNOWN_KIND = "unknown";
export type WireKind = ArtifactKind | typeof UNKNOWN_KIND;
export const DEFAULT_ARTIFACT_KIND: ArtifactKind = "html";

export const KIND_CAPABILITIES: Record<ArtifactKind, KindCapabilities> = {
  html: {
    label: "Page",
    icon: "page",
    viewer: "sandboxed-html",
    anchors: ["element", "page-point"],
    agentWrite: "replace-document",
    titleSource: "html-title",
    appEdit: false,
    extensions: [".html", ".htm"],
  },
  markdown: {
    label: "Doc",
    icon: "document",
    viewer: "inline-markdown",
    anchors: ["text-range"],
    agentWrite: "text-operations",
    titleSource: "first-heading",
    appEdit: true,
    extensions: [".md", ".markdown"],
  },
};

const UNKNOWN_LABEL = "Unknown";
const UNKNOWN_ICON: KindIcon = "unknown";
const EXTENSION_SHAPE = /^\.[a-z0-9]+$/;

export const isArtifactKind = (value: string): value is ArtifactKind =>
  (ARTIFACT_KINDS as readonly string[]).includes(value);

export const capabilitiesFor = (kind: string): KindCapabilities | null =>
  isArtifactKind(kind) ? KIND_CAPABILITIES[kind] : null;

export const wireNameFor = (kind: string): WireKind => (isArtifactKind(kind) ? kind : UNKNOWN_KIND);

export const anchorKindsFor = (kind: string): readonly CommentAnchorKind[] => capabilitiesFor(kind)?.anchors ?? [];

export const labelFor = (kind: string): string => capabilitiesFor(kind)?.label ?? UNKNOWN_LABEL;

export const iconFor = (kind: string): KindIcon => capabilitiesFor(kind)?.icon ?? UNKNOWN_ICON;

export const canEditInApp = (kind: string): boolean => capabilitiesFor(kind)?.appEdit === true;

export const agentWriteFor = (kind: string): AgentWriteMode | null => capabilitiesFor(kind)?.agentWrite ?? null;

export const viewerFor = (kind: string): KindViewer | null => capabilitiesFor(kind)?.viewer ?? null;

export const titleSourceFor = (kind: string): TitleSource | null => capabilitiesFor(kind)?.titleSource ?? null;

export const extensionsFor = (kind: string): readonly string[] => capabilitiesFor(kind)?.extensions ?? [];

export const rendersSandboxedHtml = (kind: string): boolean => viewerFor(kind) === "sandboxed-html";

export const rendersInlineMarkdown = (kind: string): boolean => viewerFor(kind) === "inline-markdown";

export const acceptsTextOperations = (kind: string): boolean => agentWriteFor(kind) === "text-operations";

export const editsDocumentInApp = (kind: string): boolean => canEditInApp(kind) && acceptsTextOperations(kind);

export const kindForExtension = (
  extension: string,
  registry: Record<string, KindCapabilities> = KIND_CAPABILITIES,
): ArtifactKind | null => {
  const normalized = extension.toLowerCase();
  return ARTIFACT_KINDS.find((kind) => registry[kind]?.extensions?.includes(normalized) === true) ?? null;
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
    if (capabilities === undefined) continue;
    if (blank(capabilities.label)) gaps.push(`${kind}: label is blank`);
    if (!KIND_ICONS.includes(capabilities.icon))
      gaps.push(`${kind}: icon ${String(capabilities.icon)} is not in the registry icon vocabulary`);
    if (!KIND_VIEWERS.includes(capabilities.viewer))
      gaps.push(`${kind}: viewer ${String(capabilities.viewer)} is not a known render strategy`);
    if (!AGENT_WRITE_MODES.includes(capabilities.agentWrite))
      gaps.push(`${kind}: agent write ${String(capabilities.agentWrite)} is not a known write mode`);
    if (!TITLE_SOURCES.includes(capabilities.titleSource))
      gaps.push(`${kind}: title source ${String(capabilities.titleSource)} is not a known title source`);
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
  }
  return gaps;
}
