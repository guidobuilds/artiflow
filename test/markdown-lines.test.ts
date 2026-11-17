import assert from "node:assert/strict";
import { test } from "node:test";

import { applyLineOps, decodeMarkdownText, joinLines, toLines, type LineOp } from "@artiflow/domain/markdown";

const doc = ["# Title", "", "intro paragraph", "| a | b |", "| 1 | 2 |", "tail"];

test("line splitting and joining are lossless, including embedded CR and a trailing newline", () => {
  const text = "a\nb\r\nc\n";
  assert.deepEqual(toLines(text), ["a", "b\r", "c", ""]);
  assert.equal(joinLines(toLines(text)), text);
  assert.deepEqual(toLines(""), [""]);
  assert.equal(joinLines(toLines("one")), "one");
});

test("decodeMarkdownText accepts valid UTF-8 and refuses invalid byte sequences", () => {
  assert.deepEqual(decodeMarkdownText(new TextEncoder().encode("# hola ñ 表")), { ok: true, text: "# hola ñ 表" });
  const broken = new Uint8Array([0x61, 0xf0, 0x28, 0x8c, 0x28]);
  assert.deepEqual(decodeMarkdownText(broken), { ok: false, kind: "not_utf8" });
});

test("replace swaps an inclusive 1-indexed line range", () => {
  const result = applyLineOps(doc, [{ op: "replace", from: 4, to: 5, text: ["| a | b | c |"] }]);
  assert.deepEqual(result, { ok: true, value: ["# Title", "", "intro paragraph", "| a | b | c |", "tail"] });
});

test("insert places text after a line, with 0 meaning the top of the document", () => {
  assert.deepEqual(applyLineOps(doc, [{ op: "insert", after: 0, text: ["---"] }]), {
    ok: true,
    value: ["---", "# Title", "", "intro paragraph", "| a | b |", "| 1 | 2 |", "tail"],
  });
  assert.deepEqual(applyLineOps(doc, [{ op: "insert", after: 6, text: ["", "EOF"] }]), {
    ok: true,
    value: [...doc, "", "EOF"],
  });
});

test("delete removes an inclusive range and empty ops are refused", () => {
  assert.deepEqual(applyLineOps(doc, [{ op: "delete", from: 2, to: 3 }]), {
    ok: true,
    value: ["# Title", "| a | b |", "| 1 | 2 |", "tail"],
  });
  assert.deepEqual(applyLineOps(doc, []), { ok: false, kind: "empty_ops" });
});

test("the expect guard compares the exact current range and refusal carries the live window", () => {
  const op: LineOp = { op: "replace", from: 4, to: 5, expect: ["| a | b |", "| 1 | 3 |"], text: ["x"] };
  const result = applyLineOps(doc, [op]);
  assert.equal(result.ok, false);
  if (!result.ok && result.kind === "expectation_mismatch") {
    assert.deepEqual(result.window, { from: 4, to: 5, lines: ["| a | b |", "| 1 | 2 |"] });
  } else assert.fail(`expected expectation_mismatch, got ${JSON.stringify(result)}`);
  assert.deepEqual(
    applyLineOps(doc, [{ op: "replace", from: 4, to: 5, expect: ["| a | b |", "| 1 | 2 |"], text: ["x"] }]),
    { ok: true, value: ["# Title", "", "intro paragraph", "x", "tail"] },
  );
});

test("out-of-range and malformed ops are refused before any mutation", () => {
  assert.equal(applyLineOps(doc, [{ op: "replace", from: 0, to: 1, text: ["x"] }]).ok, false);
  assert.equal(applyLineOps(doc, [{ op: "replace", from: 3, to: 9, text: ["x"] }]).ok, false);
  assert.equal(applyLineOps(doc, [{ op: "replace", from: 5, to: 2, text: ["x"] }]).ok, false);
  assert.equal(applyLineOps(doc, [{ op: "insert", after: 7, text: ["x"] }]).ok, false);
  assert.equal(
    applyLineOps(doc, [{ op: "replace", from: 1, to: 1 } as unknown as LineOp]).ok,
    false,
    "replace requires text",
  );
  assert.equal(
    applyLineOps(doc, [{ op: "replace", from: 1, to: 1, text: "x" } as unknown as LineOp]).ok,
    false,
    "text must be an array",
  );
  assert.equal(applyLineOps(doc, [{ op: "nonsense" } as unknown as LineOp]).ok, false);
  assert.deepEqual(
    doc,
    ["# Title", "", "intro paragraph", "| a | b |", "| 1 | 2 |", "tail"],
    "input lines never mutated",
  );
});

test("ops apply sequentially against the evolving document", () => {
  const result = applyLineOps(doc, [
    { op: "delete", from: 2, to: 2 },
    { op: "insert", after: 2, text: ["new intro"] },
    { op: "replace", from: 4, to: 4, expect: ["| a | b |"], text: ["| a | b | c |"] },
  ]);
  assert.deepEqual(result, {
    ok: true,
    value: ["# Title", "intro paragraph", "new intro", "| a | b | c |", "| 1 | 2 |", "tail"],
  });
});

test("a failed op in a sequence reports its index and leaves nothing applied", () => {
  const result = applyLineOps(doc, [
    { op: "delete", from: 2, to: 2 },
    { op: "replace", from: 1, to: 99, text: ["x"] },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok && result.kind === "range") assert.equal(result.opIndex, 1);
});
