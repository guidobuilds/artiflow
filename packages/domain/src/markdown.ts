export type LineOp =
  | {
      op: "replace";
      from: number;
      to: number;
      expect?: string[];
      text: string[];
    }
  | { op: "insert"; after: number; text: string[] }
  | { op: "delete"; from: number; to: number; expect?: string[] };

export type LinesFailure =
  | { ok: false; kind: "empty_ops" }
  | { ok: false; kind: "range"; reason: string; opIndex: number }
  | {
      ok: false;
      kind: "expectation_mismatch";
      reason: string;
      opIndex: number;
      window: { from: number; to: number; lines: string[] };
    };

export function toLines(text: string): string[] {
  return text.split("\n");
}

export function joinLines(lines: string[]): string {
  return lines.join("\n");
}

export function decodeMarkdownText(bytes: Uint8Array): { ok: true; text: string } | { ok: false; kind: "not_utf8" } {
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) return { ok: false, kind: "not_utf8" };
  return { ok: true, text };
}

const isLine = (value: unknown): value is string => typeof value === "string";

function checkExpect(
  lines: string[],
  op: { expect?: string[]; from: number; to: number },
  opIndex: number,
): LinesFailure | undefined {
  if (op.expect === undefined) return undefined;
  if (!Array.isArray(op.expect) || !op.expect.every(isLine)) {
    return { ok: false, kind: "range", reason: "expect_must_be_array_of_strings", opIndex };
  }
  const window = lines.slice(op.from - 1, op.to);
  if (window.length !== op.expect.length || window.some((line, index) => line !== op.expect?.[index])) {
    return {
      ok: false,
      kind: "expectation_mismatch",
      reason: "expected_text_does_not_match_current_lines",
      opIndex,
      window: { from: op.from, to: op.to, lines: window },
    };
  }
  return undefined;
}

function opText(op: LineOp, opIndex: number): string[] | LinesFailure {
  const text = (op as { text?: unknown }).text;
  if (!Array.isArray(text) || text.length === 0 || !text.every(isLine)) {
    return { ok: false, kind: "range", reason: "text_must_be_nonempty_array_of_strings", opIndex };
  }
  return text;
}

export function applyLineOps(lines: string[], ops: LineOp[]): { ok: true; value: string[] } | LinesFailure {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, kind: "empty_ops" };
  const draft = [...lines];
  for (const [opIndex, op] of ops.entries()) {
    if (typeof op !== "object" || op === null || !["replace", "insert", "delete"].includes(op.op)) {
      return { ok: false, kind: "range", reason: "unknown_op", opIndex };
    }
    const count = draft.length;
    if (op.op === "insert") {
      if (!Number.isInteger(op.after) || op.after < 0 || op.after > count) {
        return { ok: false, kind: "range", reason: "insert_after_out_of_range", opIndex };
      }
      const text = opText(op, opIndex);
      if (!Array.isArray(text)) return text;
      draft.splice(op.after, 0, ...text);
      continue;
    }
    if (!Number.isInteger(op.from) || op.from < 1 || !Number.isInteger(op.to) || op.to < op.from || op.to > count) {
      return { ok: false, kind: "range", reason: "line_range_out_of_bounds", opIndex };
    }
    const mismatch = checkExpect(draft, op, opIndex);
    if (mismatch) return mismatch;
    if (op.op === "delete") {
      draft.splice(op.from - 1, op.to - op.from + 1);
      continue;
    }
    const text = opText(op, opIndex);
    if (!Array.isArray(text)) return text;
    draft.splice(op.from - 1, op.to - op.from + 1, ...text);
  }
  return { ok: true, value: draft };
}
