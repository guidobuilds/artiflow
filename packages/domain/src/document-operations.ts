export const DOCUMENT_FORMAT_VERSION = 1;

export type MarkdownDocument = { formatVersion: number; text: string };
export type DocumentPosition = { line: number; column: number };

export type DocumentOperation =
  | { op: "replace_text"; find: string; replace: string; all?: boolean; expectedOccurrences?: number }
  | { op: "insert_text"; text: string; at?: DocumentPosition }
  | { op: "delete_range"; start: DocumentPosition; end: DocumentPosition }
  | { op: "append_blocks"; text: string; blockId?: string }
  | { op: "replace_document"; text: string };

export type BlockKind = "heading" | "paragraph" | "list-item" | "code-fence" | "table";
export const BLOCK_KINDS = ["heading", "paragraph", "list-item", "code-fence", "table"] as const;
export type BlockLocation = { line: number; column: number; kind: BlockKind };
export type BlockIndex = Record<string, BlockLocation>;
export type DocumentBlock = {
  id: string;
  kind: BlockKind;
  line: number;
  endLine: number;
  column: number;
  level?: number;
  content: string;
};
export type BlockChangeStatus = "added" | "removed" | "changed" | "moved";
export type BlockChange = {
  status: BlockChangeStatus;
  id: string;
  line: number;
  fromId?: string;
  fromLine?: number;
};

export type OperationRefusalReason =
  | "empty_operations"
  | "unknown_operation"
  | "invalid_arguments"
  | "text_not_found"
  | "occurrence_mismatch"
  | "position_out_of_bounds"
  | "empty_range"
  | "empty_document"
  | "unknown_block";

export type OperationDetail = {
  found?: number;
  expected?: number;
  line?: number;
  column?: number;
  blockId?: string;
};

export type OperationRefusal = {
  ok: false;
  reason: OperationRefusalReason;
  opIndex: number;
  detail: OperationDetail;
};

export type OperationOutcome = {
  formatVersion: number;
  text: string;
  applied: number;
  replaced: number;
  occurrences: number[];
};

export type OperationsResult = { ok: true; value: OperationOutcome } | OperationRefusal;

type BlockSpan = DocumentBlock;
type SingleOutcome = { ok: true; value: { text: string; occurrences: number } } | OperationRefusal;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(\s|$)/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const blank = (line: string): boolean => line.trim().length === 0;
const indentOf = (line: string): number => line.length - line.replace(/^\s+/, "").length;

const isPosition = (value: unknown): value is DocumentPosition => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { line?: unknown; column?: unknown };
  return Number.isSafeInteger(candidate.line) && Number.isSafeInteger(candidate.column);
};

const refusal = (reason: OperationRefusalReason, opIndex: number, detail: OperationDetail = {}): OperationRefusal => ({
  ok: false,
  reason,
  opIndex,
  detail,
});

const invalid = (opIndex: number): OperationRefusal => refusal("invalid_arguments", opIndex);

function fnv1a(text: string, basis: number): number {
  let hash = basis >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const contentHash = (text: string): string =>
  `${fnv1a(text, 0x811c9dc5).toString(16).padStart(8, "0")}${fnv1a(text, 0x9e3779b9).toString(16).padStart(8, "0")}`;

function fenceOf(line: string): { marker: string; length: number } | null {
  const match = FENCE.exec(line);
  if (!match) return null;
  const marker = match[1] as string;
  return { marker: marker[0] as string, length: marker.length };
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const delimiter = lines[index + 1];
  if (header === undefined || delimiter === undefined) return false;
  return header.includes("|") && delimiter.includes("|") && delimiter.includes("-") && TABLE_DELIMITER.test(delimiter);
}

function startsBlock(lines: string[], index: number, line: string): boolean {
  return fenceOf(line) !== null || HEADING.test(line) || LIST_ITEM.test(line) || isTableStart(lines, index);
}

const headingLevel = (line: string): number | undefined => HEADING.exec(line)?.[1]?.length;

function assignIds(spans: Omit<BlockSpan, "id">[]): BlockSpan[] {
  const ordinals = new Map<string, number>();
  return spans.map((span) => {
    const key = `${span.kind}\u0000${span.content}`;
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    return { ...span, id: `${span.kind}-${ordinal}-${contentHash(span.content)}` };
  });
}

function scanBlocks(text: string): BlockSpan[] {
  const lines = text.split("\n");
  const spans: Omit<BlockSpan, "id">[] = [];
  const span = (
    kind: BlockKind,
    start: number,
    end: number,
    column: number,
    level?: number,
  ): Omit<BlockSpan, "id"> => ({
    kind,
    line: start + 1,
    column,
    endLine: end + 1,
    ...(level === undefined ? {} : { level }),
    content: lines.slice(start, end + 1).join("\n"),
  });
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (blank(line)) {
      index += 1;
      continue;
    }
    const fence = fenceOf(line);
    if (fence) {
      let end = index;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor] ?? "";
        const closing = fenceOf(candidate);
        end = cursor;
        if (closing && closing.marker === fence.marker && closing.length >= fence.length) break;
      }
      spans.push(span("code-fence", index, end, indentOf(line) + 1));
      index = end + 1;
      continue;
    }
    if (isTableStart(lines, index)) {
      let end = index;
      for (let cursor = index; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor] ?? "";
        if (blank(candidate) || !candidate.includes("|")) break;
        end = cursor;
      }
      spans.push(span("table", index, end, indentOf(line) + 1));
      index = end + 1;
      continue;
    }
    if (HEADING.test(line)) {
      spans.push(span("heading", index, index, indentOf(line) + 1, headingLevel(line)));
      index += 1;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      let end = index;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor] ?? "";
        if (blank(candidate) || indentOf(candidate) === 0 || LIST_ITEM.test(candidate)) break;
        end = cursor;
      }
      spans.push(span("list-item", index, end, indentOf(line) + 1));
      index = end + 1;
      continue;
    }
    let end = index;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? "";
      if (blank(candidate) || startsBlock(lines, cursor, candidate)) break;
      end = cursor;
    }
    spans.push(span("paragraph", index, end, indentOf(line) + 1));
    index = end + 1;
  }
  return assignIds(spans);
}

export function documentBlocks(text: string): DocumentBlock[] {
  return scanBlocks(text);
}

export function indexBlocks(text: string): BlockIndex {
  const index: BlockIndex = {};
  for (const block of scanBlocks(text)) index[block.id] = { line: block.line, column: block.column, kind: block.kind };
  return index;
}

export function diffBlocks(before: readonly DocumentBlock[], after: readonly DocumentBlock[]): BlockChange[] {
  const beforeIds = new Map(before.map((block) => [block.id, block]));
  const afterIds = new Set(after.map((block) => block.id));
  const changes: BlockChange[] = [];
  for (const block of after) {
    const previous = beforeIds.get(block.id);
    if (previous && previous.line !== block.line)
      changes.push({ status: "moved", id: block.id, line: block.line, fromLine: previous.line });
  }
  const gone = before.filter((block) => !afterIds.has(block.id));
  const fresh = after.filter((block) => !beforeIds.has(block.id));
  const claimed = new Set<DocumentBlock>();
  for (const block of fresh) {
    const closest = gone
      .filter((candidate) => !claimed.has(candidate) && candidate.kind === block.kind)
      .map((candidate) => ({ candidate, distance: Math.abs(candidate.line - block.line) }))
      .filter((entry) => entry.distance <= 1)
      .sort((left, right) => left.distance - right.distance)[0];
    if (!closest) {
      changes.push({ status: "added", id: block.id, line: block.line });
      continue;
    }
    claimed.add(closest.candidate);
    changes.push({
      status: "changed",
      id: block.id,
      line: block.line,
      fromId: closest.candidate.id,
      fromLine: closest.candidate.line,
    });
  }
  for (const block of gone) {
    if (claimed.has(block)) continue;
    changes.push({ status: "removed", id: block.id, line: block.line });
  }
  return changes
    .map((change, position) => ({ change, position }))
    .sort((left, right) => left.change.line - right.change.line || left.position - right.position)
    .map(({ change }) => change);
}

export function canonicalMarkdown(document: MarkdownDocument): string {
  return document.text;
}

export function canonicalBytes(document: MarkdownDocument): Uint8Array {
  return new TextEncoder().encode(canonicalMarkdown(document));
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) offsets.push(index + 1);
  return offsets;
}

function offsetOf(text: string, position: DocumentPosition): number | null {
  if (!isPosition(position) || position.line < 1 || position.column < 1) return null;
  const offsets = lineOffsets(text);
  const start = offsets[position.line - 1];
  if (start === undefined) return null;
  const next = offsets[position.line];
  const lineEnd = next === undefined ? text.length : next - 1;
  if (position.column > lineEnd - start + 1) return null;
  return start + position.column - 1;
}

function matchIndexes(text: string, find: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + find.length)) found.push(at);
  return found;
}

function appendedText(text: string, addition: string): string {
  if (text.length === 0) return addition;
  if (text.endsWith("\n\n")) return `${text}${addition}`;
  if (text.endsWith("\n")) return `${text}\n${addition}`;
  return `${text}\n\n${addition}`;
}

function applyReplaceText(
  text: string,
  operation: Extract<DocumentOperation, { op: "replace_text" }>,
  index: number,
): SingleOutcome {
  if (typeof operation.find !== "string" || operation.find.length === 0) return invalid(index);
  if (typeof operation.replace !== "string") return invalid(index);
  const all = operation.all ?? false;
  if (typeof all !== "boolean") return invalid(index);
  const expected = operation.expectedOccurrences;
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1)) return invalid(index);
  if (expected !== undefined && !all && expected !== 1) return invalid(index);
  const positions = matchIndexes(text, operation.find);
  if (positions.length === 0) return refusal("text_not_found", index);
  if (expected !== undefined && positions.length !== expected)
    return refusal("occurrence_mismatch", index, { found: positions.length, expected });
  const selected = all ? positions : positions.slice(0, 1);
  let result = "";
  let cursor = 0;
  for (const at of selected) {
    result += text.slice(cursor, at) + operation.replace;
    cursor = at + operation.find.length;
  }
  return { ok: true, value: { text: result + text.slice(cursor), occurrences: selected.length } };
}

function applyInsertText(
  text: string,
  operation: Extract<DocumentOperation, { op: "insert_text" }>,
  index: number,
): SingleOutcome {
  if (typeof operation.text !== "string" || operation.text.length === 0) return invalid(index);
  if (operation.at === undefined) return { ok: true, value: { text: text + operation.text, occurrences: 0 } };
  const offset = offsetOf(text, operation.at);
  if (offset === null)
    return refusal("position_out_of_bounds", index, { line: operation.at.line, column: operation.at.column });
  return { ok: true, value: { text: text.slice(0, offset) + operation.text + text.slice(offset), occurrences: 0 } };
}

function applyDeleteRange(
  text: string,
  operation: Extract<DocumentOperation, { op: "delete_range" }>,
  index: number,
): SingleOutcome {
  const start = offsetOf(text, operation.start);
  if (start === null)
    return refusal("position_out_of_bounds", index, {
      line: operation.start?.line,
      column: operation.start?.column,
    });
  const end = offsetOf(text, operation.end);
  if (end === null)
    return refusal("position_out_of_bounds", index, { line: operation.end?.line, column: operation.end?.column });
  if (end <= start) return refusal("empty_range", index, { line: operation.end.line, column: operation.end.column });
  return { ok: true, value: { text: text.slice(0, start) + text.slice(end), occurrences: 0 } };
}

function applyAppendBlocks(
  text: string,
  operation: Extract<DocumentOperation, { op: "append_blocks" }>,
  index: number,
): SingleOutcome {
  if (typeof operation.text !== "string" || operation.text.length === 0) return invalid(index);
  if (operation.blockId === undefined)
    return { ok: true, value: { text: appendedText(text, operation.text), occurrences: 0 } };
  if (typeof operation.blockId !== "string" || operation.blockId.length === 0) return invalid(index);
  const block = scanBlocks(text).find((candidate) => candidate.id === operation.blockId);
  if (!block) return refusal("unknown_block", index, { blockId: operation.blockId });
  const endOffset = lineOffsets(text)[block.endLine] ?? text.length;
  if (endOffset >= text.length) {
    const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    return { ok: true, value: { text: `${text}${separator}${operation.text}`, occurrences: 0 } };
  }
  return {
    ok: true,
    value: { text: `${text.slice(0, endOffset)}${operation.text}\n${text.slice(endOffset)}`, occurrences: 0 },
  };
}

function applySingle(text: string, operation: DocumentOperation, index: number): SingleOutcome {
  if (typeof operation !== "object" || operation === null) return refusal("unknown_operation", index);
  switch (operation.op) {
    case "replace_text":
      return applyReplaceText(text, operation, index);
    case "insert_text":
      return applyInsertText(text, operation, index);
    case "delete_range":
      return applyDeleteRange(text, operation, index);
    case "append_blocks":
      return applyAppendBlocks(text, operation, index);
    case "replace_document":
      if (typeof operation.text !== "string") return invalid(index);
      return { ok: true, value: { text: operation.text, occurrences: 0 } };
    default:
      return refusal("unknown_operation", index);
  }
}

export function applyDocumentOperations(
  document: MarkdownDocument,
  operations: readonly DocumentOperation[],
): OperationsResult {
  if (!Array.isArray(operations) || operations.length === 0) return refusal("empty_operations", -1);
  let text = typeof document?.text === "string" ? document.text : "";
  const occurrences: number[] = [];
  for (const [index, operation] of operations.entries()) {
    const outcome = applySingle(text, operation, index);
    if (!outcome.ok) return outcome;
    text = outcome.value.text;
    occurrences.push(outcome.value.occurrences);
  }
  if (text.length === 0) return refusal("empty_document", operations.length - 1);
  return {
    ok: true,
    value: {
      formatVersion: document.formatVersion,
      text,
      applied: operations.length,
      replaced: occurrences.reduce((sum, count) => sum + count, 0),
      occurrences,
    },
  };
}
