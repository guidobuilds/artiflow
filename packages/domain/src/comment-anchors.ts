import MarkdownIt from "markdown-it";

import { KIND_CAPABILITIES, anchorKindsFor, type ArtifactKind } from "./kinds.ts";
import type { Scene } from "./scene.ts";

const quoteMarkdown = new MarkdownIt({ html: true });

export type CommentAnchor = { startLine: number; startCol: number; endLine: number; endCol: number };
export type TextRangeAnchor = { kind: "text-range"; quotedText: string } & CommentAnchor;
export type ElementAnchor = {
  kind: "element";
  selector: string;
  point: { x: number; y: number };
  textHint: string;
  viewportWidth: number;
};
export type PagePointAnchor = { kind: "page-point"; x: number; y: number; viewportWidth: number };
export type BoardPointAnchor = { kind: "board-point"; boardId: string; nodeId: string; x: number; y: number };
export type SlidePointAnchor = { kind: "slide-point"; slideId: string; nodeId: string; x: number; y: number };
export type ArtboardPointAnchor = {
  kind: "artboard-point";
  boardId: string;
  revisionId: string;
  selector: string;
  textHint: string;
  x: number;
  y: number;
  viewportWidth: number;
};
export type AnyCommentAnchor =
  TextRangeAnchor | ElementAnchor | PagePointAnchor | BoardPointAnchor | SlidePointAnchor | ArtboardPointAnchor;
export type CommentAnchorKind = AnyCommentAnchor["kind"];
export type SceneAnchor = BoardPointAnchor | SlidePointAnchor;

const anchorsOf = (kind: ArtifactKind): readonly CommentAnchorKind[] => KIND_CAPABILITIES[kind]?.anchors ?? [];

export const ANCHOR_KINDS_BY_DOCUMENT: Record<ArtifactKind, readonly CommentAnchorKind[]> = {
  markdown: anchorsOf("markdown"),
  html: anchorsOf("html"),
  canvas: anchorsOf("canvas"),
  deck: anchorsOf("deck"),
};
export const anchorKindsForDocument = (documentKind: string): readonly CommentAnchorKind[] =>
  anchorKindsFor(documentKind);
export const anchorKindAllowed = (documentKind: string, kind: CommentAnchorKind): boolean =>
  anchorKindsForDocument(documentKind).includes(kind);
export const SCENE_ANCHOR_KINDS: readonly CommentAnchorKind[] = ["board-point", "slide-point"];
export const ARTBOARD_ANCHOR_KINDS: readonly CommentAnchorKind[] = ["artboard-point"];
export const isSceneAnchor = (anchor: unknown): anchor is SceneAnchor =>
  typeof anchor === "object" &&
  anchor !== null &&
  SCENE_ANCHOR_KINDS.includes((anchor as { kind: CommentAnchorKind }).kind);
export const isArtboardAnchor = (anchor: unknown): anchor is ArtboardPointAnchor =>
  typeof anchor === "object" && anchor !== null && (anchor as { kind?: unknown }).kind === "artboard-point";
export type ArtboardAnchorRefusalReason = "unknown_frame" | "unknown_source" | "revision_mismatch";
export function artboardAnchorRefusal(scene: Scene, anchor: ArtboardPointAnchor): ArtboardAnchorRefusalReason | null {
  const frame = scene.frames.find((candidate) => candidate.id === anchor.boardId);
  if (frame === undefined) return "unknown_frame";
  if (frame.source === undefined) return "unknown_source";
  return frame.source.revisionId === anchor.revisionId ? null : "revision_mismatch";
}
export const HIDDEN_ARTBOARD_LOCATOR = "(hidden)";

export function artboardAnchorSource(scene: Scene, anchor: ArtboardPointAnchor): string | null {
  const frame = scene.frames.find((candidate) => candidate.id === anchor.boardId);
  if (frame === undefined || frame.source === undefined) return null;
  return frame.source.revisionId === anchor.revisionId ? frame.source.artifactId : null;
}

export const redactArtboardAnchor = (anchor: ArtboardPointAnchor): ArtboardPointAnchor => ({
  ...anchor,
  selector: "",
  textHint: HIDDEN_ARTBOARD_LOCATOR,
});

export const artboardAnchorIsOrphaned = (scene: Scene, anchor: unknown): boolean =>
  isArtboardAnchor(anchor) && artboardAnchorRefusal(scene, anchor) !== null;
export const acceptsSceneAnchors = (documentKind: string): boolean =>
  anchorKindsForDocument(documentKind).some((kind) => SCENE_ANCHOR_KINDS.includes(kind));
export type SceneAnchorRefusalReason = "unknown_node";
export function sceneAnchorRefusal(scene: Scene, anchor: SceneAnchor): SceneAnchorRefusalReason | null {
  const frameId = anchor.kind === "board-point" ? anchor.boardId : anchor.slideId;
  const frame = scene.frames.find((candidate) => candidate.id === frameId);
  if (frame === undefined) return "unknown_node";
  return frame.nodes.some((node) => node.id === anchor.nodeId) ? null : "unknown_node";
}
export const sceneAnchorIsOrphaned = (scene: Scene, anchor: unknown): boolean =>
  isSceneAnchor(anchor) && sceneAnchorRefusal(scene, anchor) !== null;
export function anchorText(source: string, anchor: CommentAnchor): string | null {
  if (
    !anchor ||
    ![anchor.startLine, anchor.startCol, anchor.endLine, anchor.endCol].every((n) => Number.isSafeInteger(n) && n >= 1)
  )
    return null;
  const lines = source.split("\n");
  const start = lines[anchor.startLine - 1],
    end = lines[anchor.endLine - 1];
  if (
    start === undefined ||
    end === undefined ||
    anchor.endLine < anchor.startLine ||
    anchor.startCol > start.length + 1 ||
    anchor.endCol > end.length + 1
  )
    return null;
  if (anchor.startLine === anchor.endLine && anchor.endCol <= anchor.startCol) return null;
  const offset = (line: number, col: number) =>
    lines.slice(0, line - 1).reduce((n, text) => n + text.length + 1, 0) + col - 1;
  return source.slice(offset(anchor.startLine, anchor.startCol), offset(anchor.endLine, anchor.endCol));
}
export const anchorIsStale = (source: string, anchor: CommentAnchor, quote: string): boolean =>
  anchorText(source, anchor) !== quote;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const ratio = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;
const nonNegative = (value: unknown): value is number => finite(value) && value >= 0;
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length >= 1;

export function anchorShapeIsValid(anchor: unknown): boolean {
  if (!anchor || typeof anchor !== "object") return false;
  const candidate = anchor as AnyCommentAnchor;
  if (candidate.kind === "text-range")
    return (
      [candidate.startLine, candidate.startCol, candidate.endLine, candidate.endCol].every(positiveInteger) &&
      candidate.endLine >= candidate.startLine &&
      nonEmptyString(candidate.quotedText)
    );
  if (candidate.kind === "element")
    return (
      typeof candidate.selector === "string" &&
      (candidate.selector !== "" || candidate.textHint !== "") &&
      ratio(candidate.point?.x) &&
      ratio(candidate.point?.y) &&
      typeof candidate.textHint === "string" &&
      positiveInteger(candidate.viewportWidth)
    );
  if (candidate.kind === "page-point")
    return ratio(candidate.x) && nonNegative(candidate.y) && positiveInteger(candidate.viewportWidth);
  if (candidate.kind === "board-point")
    return (
      nonEmptyString(candidate.boardId) && nonEmptyString(candidate.nodeId) && ratio(candidate.x) && ratio(candidate.y)
    );
  if (candidate.kind === "slide-point")
    return (
      nonEmptyString(candidate.slideId) && nonEmptyString(candidate.nodeId) && ratio(candidate.x) && ratio(candidate.y)
    );
  if (candidate.kind === "artboard-point")
    return (
      nonEmptyString(candidate.boardId) &&
      nonEmptyString(candidate.revisionId) &&
      typeof candidate.selector === "string" &&
      typeof candidate.textHint === "string" &&
      (candidate.selector !== "" || candidate.textHint !== "") &&
      ratio(candidate.x) &&
      ratio(candidate.y) &&
      positiveInteger(candidate.viewportWidth)
    );
  return false;
}

export const textRangeAnchorIsCurrent = (source: string, anchor: TextRangeAnchor): boolean =>
  anchorText(source, anchor) === anchor.quotedText;
export const elementAnchorIsCurrent = (anchor: ElementAnchor): boolean => anchorShapeIsValid(anchor);
export const pagePointAnchorIsCurrent = (anchor: PagePointAnchor): boolean => anchorShapeIsValid(anchor);

export function anchorIsCurrent(documentKind: string, source: string, anchor: unknown): boolean {
  if (!anchorShapeIsValid(anchor)) return false;
  const candidate = anchor as AnyCommentAnchor;
  if (!anchorKindAllowed(documentKind, candidate.kind)) return false;
  if (candidate.kind === "text-range") return textRangeAnchorIsCurrent(source, candidate);
  return true;
}
export function anchorFromOffsets(source: string, start: number, end: number): CommentAnchor | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > source.length || start >= end)
    return null;
  const coordinate = (offset: number) => {
    const prefix = source.slice(0, offset).split("\n");
    return { line: prefix.length, col: prefix.at(-1)!.length + 1 };
  };
  const a = coordinate(start),
    b = coordinate(end);
  return { startLine: a.line, startCol: a.col, endLine: b.line, endCol: b.col };
}
export const selectionMenuVisible = (editable: boolean, from: number, to: number, dismissed: boolean): boolean =>
  editable && from < to && !dismissed;
export type SourceSpan = { start: number; end: number };
export type RenderedCandidate = { anchor: CommentAnchor; snippet: string };
export type RenderedSelection = {
  kind: "anchor" | "candidates";
  anchor: CommentAnchor | null;
  quotedText: string;
  candidates: RenderedCandidate[];
};

export function sourceBlockSpan(source: string, startBlock: number, endBlock: number): SourceSpan {
  const blocks = quoteMarkdown.parse(source, {}).filter((token) => token.level === 0 && token.map);
  const offsets = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") offsets.push(i + 1);
  const first = blocks[startBlock]?.map,
    last = blocks[endBlock]?.map;
  const start = first ? (offsets[first[0]] ?? 0) : 0;
  let end = last ? (offsets[last[1]] ?? source.length) : source.length;
  if (end > start && source[end - 1] === "\n") end--;
  return { start, end };
}

export function renderedQuote(source: string): string {
  const literals: string[] = [];
  const prepared = source.replace(/\\([*_~`])/g, (_match, literal: string) => {
    literals.push(literal);
    return `\uE000${literals.length - 1}\uE001`;
  });
  const restore = (text: string, code = false) =>
    text.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => (code ? "\\" : "") + (literals[Number(index)] ?? ""));
  return quoteMarkdown
    .parse(prepared, {})
    .flatMap((token) => {
      if (token.type === "inline")
        return [
          (token.children ?? [])
            .map((child) => {
              if (child.type === "softbreak" || child.type === "hardbreak") return "\n";
              if (child.type === "code_inline") return restore(child.content, true);
              if (child.type === "image") return restore(child.content);
              if (child.type !== "text") return "";
              return restore(
                child.content.replace(/(^|[\s(])(?:\*+|_+|~~|`+)(?=\w)|(?<=\w)(?:\*+|_+|~~|`+)(?=$|[\s)])/g, "$1"),
              );
            })
            .join(""),
        ];
      if (token.type === "html_block") return [renderedQuote(restore(token.content).replace(/<[^>]*>/g, ""))];
      return token.type === "fence" || token.type === "code_block" ? [restore(token.content.trimEnd(), true)] : [];
    })
    .join("\n");
}

export function mapRenderedSelection(source: string, selectedText: string, span: SourceSpan): RenderedSelection {
  const fallback = (): RenderedSelection => ({
    kind: "anchor",
    anchor: anchorFromOffsets(source, span.start, span.end),
    quotedText: selectedText,
    candidates: [],
  });
  const raw = source.slice(span.start, span.end);
  const tokens = quoteMarkdown.parse(raw, {});
  if (tokens.some((token) => token.type === "table_open")) {
    const text = selectedText.trim();
    const matches: number[] = [];
    for (let at = text ? raw.indexOf(text) : -1; at >= 0; at = raw.indexOf(text, at + 1)) matches.push(at);
    const cells = matches.map((at) => {
      const anchor = anchorFromOffsets(source, span.start + at, span.start + at + text.length);
      return anchor ? { anchor, snippet: raw.slice(Math.max(0, at - 32), at + text.length + 32).trim() } : null;
    });
    const found = cells.filter((cell) => cell !== null);
    if (found.length === 1) return { kind: "anchor", anchor: found[0]!.anchor, quotedText: text, candidates: [] };
    if (found.length > 1) return { kind: "candidates", anchor: null, quotedText: text, candidates: found };
    return fallback();
  }
  let decoded = "";
  const starts: number[] = [],
    ends: number[] = [];
  for (let i = 0; i < raw.length;) {
    const escaped = /^\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.exec(raw.slice(i));
    const entity = /^&(?:#x[\da-f]+|#\d+|[a-z][\da-z]+);/i.exec(raw.slice(i));
    const part = escaped?.[0] ?? entity?.[0] ?? raw[i]!;
    const text = quoteMarkdown.utils.unescapeAll(part);
    for (let j = 0; j < text.length; j++) {
      starts.push(span.start + i);
      ends.push(span.start + i + part.length);
    }
    decoded += text;
    i += part.length;
  }
  let cursor = 0,
    visible = "";
  const mappedStarts: number[] = [],
    mappedEnds: number[] = [];
  const append = (text: string, start: number) => {
    for (let j = 0; j < text.length; j++) {
      const char = /\s/.test(text[j]!) ? " " : text[j]!;
      if (char === " " && visible.endsWith(" ")) continue;
      visible += char;
      mappedStarts.push(starts[start + j]!);
      mappedEnds.push(ends[start + j]!);
    }
  };
  for (const token of tokens) {
    const children =
      token.type === "inline"
        ? (token.children ?? [])
        : token.type === "fence" || token.type === "code_block"
          ? [{ type: "text", content: token.content.trimEnd() }]
          : [];
    for (const child of children) {
      if (child.type === "link_close") {
        const destination = /^\]\((?:\\.|[^)\\])*\)/.exec(decoded.slice(cursor));
        if (destination) cursor += destination[0].length;
      }
      if (child.type === "softbreak" || child.type === "hardbreak") {
        if (!visible.endsWith(" ")) {
          visible += " ";
          mappedStarts.push(starts[cursor] ?? span.start);
          mappedEnds.push(ends[cursor] ?? span.start);
        }
        continue;
      }
      if (child.type !== "text" && child.type !== "code_inline") continue;
      if (!child.content) continue;
      const start = decoded.indexOf(child.content, cursor);
      if (start < 0) return fallback();
      append(child.content, start);
      cursor = start + child.content.length;
    }
    if (children.length && !visible.endsWith(" ")) {
      visible += " ";
      mappedStarts.push(ends[cursor - 1]!);
      mappedEnds.push(ends[cursor - 1]!);
    }
  }
  const needle = selectedText.replace(/\s+/g, " ").trim();
  if (!needle) return fallback();
  const candidates: RenderedCandidate[] = [];
  for (let index = visible.indexOf(needle); index >= 0; index = visible.indexOf(needle, index + 1)) {
    const anchor = anchorFromOffsets(source, mappedStarts[index]!, mappedEnds[index + needle.length - 1]!);
    if (anchor)
      candidates.push({ anchor, snippet: visible.slice(Math.max(0, index - 32), index + needle.length + 32).trim() });
  }
  if (!candidates.length) return fallback();
  return candidates.length === 1
    ? { kind: "anchor", anchor: candidates[0]!.anchor, quotedText: selectedText, candidates: [] }
    : { kind: "candidates", anchor: null, quotedText: selectedText, candidates };
}

export const composerTransition = (
  _open: boolean,
  event: "open" | "cancel" | "sent" | "forbidden",
  allowed: boolean,
): boolean => event === "open" && allowed;

type OrderedThread = { id: string; anchor: CommentAnchor; createdAt: string };
export const compareCommentThreads = (a: OrderedThread, b: OrderedThread): number =>
  a.anchor.startLine - b.anchor.startLine ||
  a.anchor.startCol - b.anchor.startCol ||
  a.createdAt.localeCompare(b.createdAt);

export function commentThreadAtPosition(
  position: number,
  ranges: CommentRange[],
  threads: OrderedThread[],
): string | null {
  const ids = new Set(ranges.filter((range) => range.from <= position && position < range.to).map((range) => range.id));
  return threads.filter((thread) => ids.has(thread.id)).sort(compareCommentThreads)[0]?.id ?? null;
}

export type CommentRange = { id: string; from: number; to: number; stale: boolean; className: string };
export function commentDecorations(
  source: string,
  threads: { id: string; anchor: CommentAnchor; quotedText: string }[],
  runs: { text: string; from: number }[],
): CommentRange[] {
  const mask = (text: string) => text.replace(/[^\n]/g, "\0");
  const visible = source
    .replace(/!\[[^\]\n]*\]\((?:\\.|[^)\\])*\)/g, mask)
    .replace(/\]\((?:\\.|[^)\\])*\)/g, mask)
    .replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*/gm, mask)
    .replace(/^(\s*[-+*] )\[[ xX]\]/gm, (text, prefix: string) => prefix + mask(text.slice(prefix.length)));
  let cursor = 0;
  const mapped = runs.map((run) => {
    const start = visible.indexOf(run.text, cursor);
    if (start < 0) return null;
    cursor = start + run.text.length;
    return { ...run, start, end: cursor };
  });
  return threads.flatMap((thread) => {
    if (anchorText(source, thread.anchor) === null) return [];
    const lines = source.split("\n");
    const offset = (line: number, col: number) =>
      lines.slice(0, line - 1).reduce((n, text) => n + text.length + 1, 0) + col - 1;
    const start = offset(thread.anchor.startLine, thread.anchor.startCol),
      end = offset(thread.anchor.endLine, thread.anchor.endCol);
    const stale = anchorIsStale(source, thread.anchor, thread.quotedText);
    return mapped.flatMap((run) => {
      if (!run || run.end <= start || run.start >= end) return [];
      return [
        {
          id: thread.id,
          from: run.from + Math.max(start - run.start, 0),
          to: run.from + Math.min(end - run.start, run.text.length),
          stale,
          className: stale ? "comment-marker comment-marker-stale" : "comment-marker",
        },
      ];
    });
  });
}

export function uniqueSourceSelection(source: string, selectedText: string): { start: number; end: number } | null {
  if (!selectedText) return null;
  const start = source.indexOf(selectedText);
  return start >= 0 && source.indexOf(selectedText, start + 1) < 0 ? { start, end: start + selectedText.length } : null;
}
