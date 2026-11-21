import assert from "node:assert/strict";
import * as anchors from "@artiflow/domain/comment-anchors";
import { test } from "node:test";
import {
  mapRenderedSelection,
  renderedQuote,
  sourceBlockSpan,
  anchorFromOffsets,
  anchorText,
  anchorIsStale,
  uniqueSourceSelection,
  commentDecorations,
  selectionMenuVisible,
  composerTransition,
} from "@artiflow/domain/comment-anchors";

test("canvas target resolution covers nested, overlapping and split decorations in sidebar order", () => {
  assert.equal(typeof anchors.commentThreadAtPosition, "function");
  const source = "first\nsecond\nthird";
  const threads = [
    { id: "later", anchor: anchorFromOffsets(source, 13, 18)!, createdAt: "2026-01-01" },
    { id: "outer", anchor: anchorFromOffsets(source, 0, 18)!, createdAt: "2026-01-02" },
    { id: "earlier", anchor: anchorFromOffsets(source, 0, 5)!, createdAt: "2026-01-01" },
  ];
  const range = (id: string, from: number, to: number) => ({ id, from, to, stale: false, className: "comment-marker" });
  const ranges = [range("later", 4, 8), range("outer", 1, 10), range("earlier", 3, 6), range("outer", 12, 15)];
  assert.equal(anchors.commentThreadAtPosition(4, ranges, threads), "earlier");
  assert.equal(anchors.commentThreadAtPosition(6, ranges, threads), "outer");
  assert.equal(anchors.commentThreadAtPosition(12, ranges, threads), "outer");
  for (const position of [0, 10, 15, 99])
    assert.equal(anchors.commentThreadAtPosition(position, ranges, threads), null);
  assert.equal(anchors.commentThreadAtPosition(4, [range("deleted", 1, 9)], threads), null);
  assert.deepEqual(
    threads.map((thread) => thread.id),
    ["later", "outer", "earlier"],
    "resolution must not reorder stored data",
  );
});

test("decoration mapping follows source coordinates, not repeated quotes, and flags stale ranges", () => {
  const source = "**same** same";
  const runs = [
    { text: "same", from: 1 },
    { text: " same", from: 5 },
  ];
  const threads = [
    { id: "first", anchor: anchorFromOffsets(source, 2, 6)!, quotedText: "same" },
    { id: "second", anchor: anchorFromOffsets(source, 9, 13)!, quotedText: "old!" },
  ];
  assert.deepEqual(commentDecorations(source, threads, runs), [
    { id: "first", from: 1, to: 5, stale: false, className: "comment-marker" },
    { id: "second", from: 6, to: 10, stale: true, className: "comment-marker comment-marker-stale" },
  ]);
  assert.deepEqual(
    commentDecorations(
      source,
      [{ ...threads[0]!, anchor: { startLine: 99, startCol: 1, endLine: 99, endCol: 2 } }],
      runs,
    ),
    [],
  );
  assert.deepEqual(commentDecorations("escaped", threads, [{ text: "missing", from: 1 }]), []);
});

test("decoration mapping skips link destinations, checkbox syntax and fence language names", () => {
  for (const [source, runs, start, end, expected] of [
    [
      "[one](https://host/two) two",
      [
        { text: "one", from: 1 },
        { text: "two", from: 5 },
      ],
      24,
      27,
      { from: 5, to: 8 },
    ],
    ["- [x] x", [{ text: "x", from: 3 }], 6, 7, { from: 3, to: 4 }],
    ["```js\njs\n```", [{ text: "js", from: 1 }], 6, 8, { from: 1, to: 3 }],
  ] as const) {
    const result = commentDecorations(
      source,
      [{ id: "c", anchor: anchorFromOffsets(source, start, end)!, quotedText: source.slice(start, end) }],
      [...runs],
    );
    assert.deepEqual(
      result.map(({ from, to }) => ({ from, to })),
      [expected],
    );
  }
});

test("selection menu and composer respect selection, permission, dismissal and cancellation", () => {
  assert.equal(selectionMenuVisible(true, 1, 4, false), true);
  for (const args of [
    [false, 1, 4, false],
    [true, 1, 1, false],
    [true, 1, 4, true],
  ] as const)
    assert.equal(selectionMenuVisible(args[0], args[1], args[2], args[3]), false);
  assert.equal(composerTransition(false, "open", true), true);
  assert.equal(composerTransition(false, "open", false), false);
  for (const event of ["cancel", "sent", "forbidden"] as const)
    assert.equal(composerTransition(true, event, true), false);
});

test("source anchors are 1-indexed, end-exclusive and preserve exact multiline selections", () => {
  const source = "# Title\n\n| a | b |\n| c | d |\n";
  const start = source.indexOf("| a");
  const end = source.indexOf("| c");
  const anchor = anchorFromOffsets(source, start, end)!;
  assert.deepEqual(anchor, { startLine: 3, startCol: 1, endLine: 4, endCol: 1 });
  assert.equal(anchorText(source, anchor), "| a | b |\n");
  assert.equal(anchorIsStale(source, anchor, "| a | b |\n"), false);
  assert.equal(anchorIsStale(source.replace("a", "z"), anchor, "| a | b |\n"), true);
});
test("invalid, empty and reversed anchors never match, stale quotes are retained", () => {
  for (const anchor of [
    { startLine: 0, startCol: 1, endLine: 1, endCol: 2 },
    { startLine: 1, startCol: 1.5, endLine: 1, endCol: 2 },
    { startLine: 1, startCol: 1, endLine: 8, endCol: 1 },
    { startLine: 1, startCol: 1, endLine: 1, endCol: 99 },
    { startLine: 1, startCol: 3, endLine: 1, endCol: 2 },
    { startLine: 1, startCol: 2, endLine: 1, endCol: 2 },
  ]) {
    assert.equal(anchorText("abc", anchor), null);
    assert.equal(anchorIsStale("abc", anchor, "b"), true);
  }
  assert.equal(anchorFromOffsets("abc", -1, 2), null);
  assert.equal(anchorFromOffsets("abc", 0, 4), null);
});
test("rendered selections map formatting and entities within their block only", () => {
  const source = "Outside OCR\n\n**OCR** (*Optical* `code`) &amp; \\*escaped\\*";
  const span = sourceBlockSpan(source, 1, 1);
  const result = mapRenderedSelection(source, "OCR (Optical code) & *escaped*", span);
  assert.equal(result.kind, "anchor");
  assert.equal(result.quotedText, "OCR (Optical code) & *escaped*");
  assert.equal(anchorText(source, result.anchor!), source.slice(source.indexOf("OCR**")));
});

test("mapping skips hidden destinations and scopes identical words to the selected block", () => {
  const source = "same\n\n[**one**](https://same) same &amp; end";
  const result = mapRenderedSelection(source, "same", sourceBlockSpan(source, 1, 1));
  assert.equal(result.kind, "anchor");
  assert.deepEqual(
    result.anchor,
    anchorFromOffsets(source, source.lastIndexOf("same"), source.lastIndexOf("same") + 4),
  );
  const quote = mapRenderedSelection(source, "same & end", sourceBlockSpan(source, 1, 1));
  assert.equal(anchorText(source, quote.anchor!), "same &amp; end");
});

test("multi-block selections normalize continuation prefixes and blank lines", () => {
  const source = "# First\n\n> **second**\n> continuation\n\n- third";
  const result = mapRenderedSelection(source, "First\nsecond\ncontinuation\nthird", sourceBlockSpan(source, 0, 2));
  assert.equal(result.kind, "anchor");
  assert.equal(anchorText(source, result.anchor!), source.slice(2));
});

test("repeated occurrences offer only rendered context snippets", () => {
  const source = "**same** near *left*, same near `right`";
  const result = mapRenderedSelection(source, "same", sourceBlockSpan(source, 0, 0));
  assert.equal(result.kind, "candidates");
  assert.equal(result.anchor, null);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(
    result.candidates.map((c) => anchorText(source, c.anchor)),
    ["same", "same"],
  );
  for (const candidate of result.candidates) assert.doesNotMatch(candidate.snippet, /[*`]/);
});

test("whole table and unmatched selections fall back to the containing block span", () => {
  const source = "Before\n\n| A | B |\n| --- | --- |\n| C | D |\n\nAfter";
  for (const selection of ["A\tB\nC\tD", "not literally present"]) {
    const span = sourceBlockSpan(source, 1, 1);
    const result = mapRenderedSelection(source, selection, span);
    assert.equal(result.kind, "anchor");
    assert.deepEqual(result.anchor, anchorFromOffsets(source, span.start, span.end));
    assert.equal(result.quotedText, selection);
    assert.deepEqual(Object.keys(result).sort(), ["anchor", "candidates", "kind", "quotedText"]);
  }
});

test("a selection inside one table cell anchors on the exact cell text", () => {
  const source = "Before\n\n| Campo | Valor |\n| --- | --- |\n| Origen | markdown |\n\nAfter";
  const result = mapRenderedSelection(source, "Origen", sourceBlockSpan(source, 1, 1));
  assert.equal(result.kind, "anchor");
  assert.equal(result.quotedText, "Origen");
  assert.equal(anchorText(source, result.anchor!), "Origen");
});

test("thread quotes render inline markdown as safe plain fragments, never HTML or syntax", () => {
  assert.equal(renderedQuote("**OCR** (*Optical* `code`) &amp; [link](https://host)"), "OCR (Optical code) & link");
  assert.equal(renderedQuote("<script>alert(1)</script> **safe**"), "alert(1) safe");
  assert.equal(renderedQuote("# Heading\n\n> **quote**"), "Heading\nquote");
  assert.equal(renderedQuote("OCR** (*Optical* `code`)"), "OCR (Optical code)");
  assert.equal(renderedQuote("foo_bar and x * y"), "foo_bar and x * y");
  assert.equal(renderedQuote("`<div>` and `a_b * c`"), "<div> and a_b * c");
  assert.equal(renderedQuote("\\*literal\\*"), "*literal*");
});

test("rendered selections only suggest a source location when unambiguous", () => {
  assert.deepEqual(uniqueSourceSelection("**hello** world", "hello"), { start: 2, end: 7 });
  assert.equal(uniqueSourceSelection("same same", "same"), null);
  assert.equal(uniqueSourceSelection("**hello**", "missing"), null);
  assert.equal(uniqueSourceSelection("text", ""), null);
});
