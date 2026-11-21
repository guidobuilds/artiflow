import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOCUMENT_FORMAT_VERSION,
  applyDocumentOperations,
  canonicalBytes,
  canonicalMarkdown,
  indexBlocks,
  type DocumentOperation,
  type MarkdownDocument,
} from "@artiflow/domain/document-operations";

const DOC = [
  "# Title",
  "",
  "intro paragraph",
  "",
  "- first",
  "- second",
  "",
  "```",
  "code()",
  "```",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
].join("\n");

const documentOf = (text: string): MarkdownDocument => ({ formatVersion: DOCUMENT_FORMAT_VERSION, text });
const applied = (document: MarkdownDocument, operations: DocumentOperation[]) => {
  const result = applyDocumentOperations(document, operations);
  assert.equal(result.ok, true, result.ok ? "" : `${result.reason} at ${result.opIndex}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
};
const refused = (document: MarkdownDocument, operations: DocumentOperation[]) => {
  const result = applyDocumentOperations(document, operations);
  assert.equal(result.ok, false, "the batch is refused");
  if (result.ok) throw new Error("unreachable");
  return result;
};

test("the document format version is pinned and the published text is the text as produced", () => {
  assert.equal(DOCUMENT_FORMAT_VERSION, 1);
  const text = "# Título ñ 表 🎯  \nline with trailing spaces  \n\n";
  const document = documentOf(text);
  assert.equal(canonicalMarkdown(document), text, "no trim, no trailing-newline games");
  const bytes = canonicalBytes(document);
  assert.equal(new TextDecoder().decode(bytes), text, "UTF-8 exactly as produced");
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(bytes), text, "the bytes are valid UTF-8");
});

test("replace_text refuses a missing string, without touching the document", () => {
  const document = documentOf("# Title\n\nbody");
  const result = refused(document, [{ op: "replace_text", find: "absent", replace: "x" }]);
  assert.equal(result.reason, "text_not_found");
  assert.equal(result.opIndex, 0);
  assert.equal(canonicalMarkdown(document), "# Title\n\nbody", "the input document is unchanged");
});

test("replace_text reports how many occurrences it replaced and honours all and expectedOccurrences", () => {
  const document = documentOf("one two one two one");
  const first = applied(document, [{ op: "replace_text", find: "one", replace: "1" }]);
  assert.equal(first.text, "1 two one two one", "without all only the first occurrence changes");
  assert.deepEqual(first.occurrences, [1]);
  assert.equal(first.replaced, 1);
  const all = applied(document, [{ op: "replace_text", find: "one", replace: "1", all: true }]);
  assert.equal(all.text, "1 two 1 two 1");
  assert.deepEqual(all.occurrences, [3]);
  assert.equal(all.replaced, 3);
  const expected = applied(document, [
    { op: "replace_text", find: "two", replace: "2", all: true, expectedOccurrences: 2 },
  ]);
  assert.equal(expected.text, "one 2 one 2 one");
  const mismatch = refused(document, [
    { op: "replace_text", find: "two", replace: "2", all: true, expectedOccurrences: 3 },
  ]);
  assert.equal(mismatch.reason, "occurrence_mismatch");
  assert.deepEqual([mismatch.detail.found, mismatch.detail.expected], [2, 3]);
  assert.equal(mismatch.opIndex, 0);
});

test("a batch that fails mid-way leaves the text byte-identical and reports the failing index", () => {
  const document = documentOf(DOC);
  const before = canonicalBytes(document);
  const result = refused(document, [
    { op: "replace_text", find: "intro paragraph", replace: "new intro" },
    { op: "replace_text", find: "not in the document", replace: "x" },
    { op: "replace_document", text: "# never applied" },
  ]);
  assert.equal(result.opIndex, 1, "the failing operation index is reported");
  assert.equal(result.reason, "text_not_found");
  assert.deepEqual(canonicalBytes(document), before, "the document is byte-identical");
  assert.equal(document.text, DOC);
});

test("insert_text uses 1-indexed line and column, and appends at the end when the position is omitted", () => {
  const document = documentOf("# Title\n\nbody");
  assert.equal(applied(document, [{ op: "insert_text", text: "!" }]).text, "# Title\n\nbody!");
  const atStart = applied(document, [{ op: "insert_text", text: "> ", at: { line: 1, column: 1 } }]);
  assert.equal(atStart.text, "> # Title\n\nbody");
  const atEndOfLine = applied(document, [{ op: "insert_text", text: " II", at: { line: 3, column: 5 } }]);
  assert.equal(atEndOfLine.text, "# Title\n\nbody II");
  const pastEndOfLine = refused(document, [{ op: "insert_text", text: "x", at: { line: 3, column: 6 } }]);
  assert.equal(pastEndOfLine.reason, "position_out_of_bounds");
  assert.deepEqual([pastEndOfLine.detail.line, pastEndOfLine.detail.column], [3, 6]);
  const pastLastLine = refused(document, [{ op: "insert_text", text: "x", at: { line: 4, column: 1 } }]);
  assert.equal(pastLastLine.reason, "position_out_of_bounds");
  assert.equal(
    refused(document, [{ op: "insert_text", text: "x", at: { line: 0, column: 1 } }]).reason,
    "position_out_of_bounds",
  );
});

test("delete_range removes an end-exclusive range and refuses emptied or out-of-bounds ranges", () => {
  const document = documentOf("# Title\n\nbody");
  const sameLine = applied(document, [
    { op: "delete_range", start: { line: 1, column: 3 }, end: { line: 1, column: 8 } },
  ]);
  assert.equal(sameLine.text, "# \n\nbody", "the end column stays in the document");
  const acrossLines = applied(document, [
    { op: "delete_range", start: { line: 1, column: 8 }, end: { line: 3, column: 5 } },
  ]);
  assert.equal(acrossLines.text, "# Title");
  assert.equal(
    refused(document, [{ op: "delete_range", start: { line: 2, column: 1 }, end: { line: 2, column: 1 } }]).reason,
    "empty_range",
  );
  assert.equal(
    refused(document, [{ op: "delete_range", start: { line: 1, column: 2 }, end: { line: 1, column: 1 } }]).reason,
    "empty_range",
  );
  const outside = refused(document, [
    { op: "delete_range", start: { line: 3, column: 1 }, end: { line: 3, column: 9 } },
  ]);
  assert.equal(outside.reason, "position_out_of_bounds");
  assert.deepEqual([outside.detail.line, outside.detail.column], [3, 9]);
});

test("append_blocks adds at the end or after a known block and refuses an unknown id", () => {
  const document = documentOf("# Title\n\nbody");
  assert.equal(
    applied(document, [{ op: "append_blocks", text: "## Next" }]).text,
    "# Title\n\nbody\n\n## Next",
    "a blank line separates the new block, with no invented trailing newline",
  );
  const trailing = applied(documentOf("# Title\n\nbody\n"), [{ op: "append_blocks", text: "## Next" }]);
  assert.equal(trailing.text, "# Title\n\nbody\n\n## Next");
  const empty = applied(documentOf(""), [{ op: "append_blocks", text: "# First" }]);
  assert.equal(empty.text, "# First");
  const index = indexBlocks(DOC);
  const paragraphId = Object.keys(index).find((id) => index[id]?.line === 3);
  assert.ok(paragraphId, "the paragraph after the heading is indexed");
  const inside = applied(documentOf(DOC), [{ op: "append_blocks", text: "extra line", blockId: paragraphId }]);
  assert.equal(inside.text, DOC.replace("intro paragraph\n", "intro paragraph\nextra line\n"));
  const unknown = refused(document, [{ op: "append_blocks", text: "x", blockId: "paragraph-1-deadbeef" }]);
  assert.equal(unknown.reason, "unknown_block");
  assert.equal(unknown.detail.blockId, "paragraph-1-deadbeef");
  assert.equal(unknown.opIndex, 0);
});

test("replace_document is the whole-text escape hatch", () => {
  const document = documentOf(DOC);
  assert.equal(applied(document, [{ op: "replace_document", text: "# Fresh" }]).text, "# Fresh");
});

test("a batch that would leave the document empty is refused with a named reason", () => {
  const document = documentOf("# Title\n\nbody");
  const replaced = refused(document, [{ op: "replace_document", text: "" }]);
  assert.equal(replaced.reason, "empty_document");
  assert.equal(replaced.opIndex, 0);
  const deleted = refused(document, [
    { op: "delete_range", start: { line: 1, column: 1 }, end: { line: 3, column: 5 } },
  ]);
  assert.equal(deleted.reason, "empty_document");
  assert.equal(deleted.opIndex, 0);
  const emptied = refused(document, [
    { op: "replace_text", find: "body", replace: "" },
    { op: "delete_range", start: { line: 1, column: 1 }, end: { line: 3, column: 1 } },
  ]);
  assert.equal(emptied.reason, "empty_document");
  assert.equal(emptied.opIndex, 1, "the refusal names the operation that emptied the batch");
  assert.equal(document.text, "# Title\n\nbody", "the input document is unchanged");
  const refilled = applied(document, [
    { op: "replace_document", text: "" },
    { op: "append_blocks", text: "# Refilled" },
  ]);
  assert.equal(refilled.text, "# Refilled", "a batch that ends non-empty is allowed");
});

test("an empty batch and an unknown operation are refused instead of silently succeeding", () => {
  const document = documentOf("# Title");
  assert.equal(refused(document, []).reason, "empty_operations");
  const unknown = refused(document, [{ op: "rewrite_everything" } as unknown as DocumentOperation]);
  assert.equal(unknown.reason, "unknown_operation");
  assert.equal(unknown.opIndex, 0);
});

test("the block index names every block kind with a 1-indexed location", () => {
  const index = indexBlocks(DOC);
  const located = Object.values(index).map((block) => [block.line, block.column, block.kind]);
  assert.deepEqual(located, [
    [1, 1, "heading"],
    [3, 1, "paragraph"],
    [5, 1, "list-item"],
    [6, 1, "list-item"],
    [8, 1, "code-fence"],
    [12, 1, "table"],
  ]);
  for (const id of Object.keys(index))
    assert.match(id, /^(heading|paragraph|list-item|code-fence|table)-\d+-[0-9a-f]{16}$/);
  const indented = indexBlocks("- outer\n  - nested");
  assert.deepEqual(
    Object.values(indented).map((block) => [block.line, block.column, block.kind]),
    [
      [1, 1, "list-item"],
      [2, 3, "list-item"],
    ],
    "an indented block reports its own column",
  );
});

test("the block index is deterministic and keeps ids stable when other blocks change", () => {
  assert.deepEqual(indexBlocks(DOC), indexBlocks(DOC), "the same text always indexes the same way");
  const original = indexBlocks(DOC);
  const shifted = indexBlocks(`> a quoted intro\n\n${DOC}`);
  for (const [id, block] of Object.entries(original)) {
    const moved = shifted[id];
    assert.ok(moved, `${id} keeps its identity`);
    assert.deepEqual(
      [moved.kind, moved.line - 2, moved.column],
      [block.kind, block.line, block.column],
      `${id} moved by the inserted block only`,
    );
  }
  const edited = indexBlocks(DOC.replace("intro paragraph", "edited paragraph"));
  const editedId = Object.keys(edited).find((id) => edited[id]?.line === 3);
  assert.notEqual(
    editedId,
    Object.keys(original).find((id) => original[id]?.line === 3),
    "an edited block gets a new id",
  );
  assert.equal(
    Object.keys(edited).find((id) => edited[id]?.line === 1),
    Object.keys(original).find((id) => original[id]?.line === 1),
    "an untouched heading keeps its id",
  );
});

test("a batch applies every operation in order against the text produced so far", () => {
  const document = documentOf("# Title\n\nbody");
  const result = applied(document, [
    { op: "replace_text", find: "body", replace: "text" },
    { op: "insert_text", text: " para", at: { line: 3, column: 5 } },
    { op: "append_blocks", text: "tail" },
  ]);
  assert.equal(result.text, "# Title\n\ntext para\n\ntail");
  assert.equal(result.applied, 3);
  assert.deepEqual(result.occurrences, [1, 0, 0]);
  assert.equal(result.formatVersion, DOCUMENT_FORMAT_VERSION);
});
