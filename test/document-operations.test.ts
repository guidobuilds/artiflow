import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOCUMENT_FORMAT_VERSION,
  applyDocumentOperations,
  diffBlocks,
  diffDocumentOperations,
  documentBlocks,
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

test("documentBlocks reports kind, line span and heading level without changing any id", () => {
  const blocks = documentBlocks(DOC);
  assert.deepEqual(
    blocks.map((block) => [block.kind, block.line, block.endLine, block.level]),
    [
      ["heading", 1, 1, 1],
      ["paragraph", 3, 3, undefined],
      ["list-item", 5, 5, undefined],
      ["list-item", 6, 6, undefined],
      ["code-fence", 8, 10, undefined],
      ["table", 12, 14, undefined],
    ],
  );
  assert.equal(blocks[0]?.content, "# Title");
  assert.deepEqual(
    Object.keys(indexBlocks(DOC)),
    blocks.map((block) => block.id),
    "the index is a projection",
  );
  assert.deepEqual(
    indexBlocks(DOC)[blocks[0]?.id as string],
    { line: 1, column: 1, kind: "heading" },
    "the published sidecar keeps its shape",
  );
  assert.deepEqual(
    documentBlocks(DOC.replace("# Title", "## Title")).map((block) => block.level),
    [2, undefined, undefined, undefined, undefined, undefined],
    "the level follows the heading marker",
  );
});

test("diffBlocks reports added, removed, changed and moved blocks by id only", () => {
  const before = documentBlocks("# Title\n\nfirst paragraph\n\nsecond paragraph\n\nlast line");
  const after = documentBlocks("# Title\n\nfirst paragraph edited\n\nlast line\n\nbrand new block");
  assert.deepEqual(
    diffBlocks(before, after).map((change) => [change.status, change.line]),
    [
      ["changed", 3],
      ["moved", 5],
      ["removed", 5],
      ["added", 7],
    ],
  );
  const changed = diffBlocks(before, after)[0];
  assert.deepEqual(
    [changed?.fromId, changed?.fromLine],
    [before[1]?.id, 3],
    "a changed block names the identity it replaced",
  );
  assert.deepEqual(
    diffBlocks(documentBlocks("a\n\nb"), documentBlocks("a\n\nb\n\nc")).map((change) => change.status),
    ["added"],
    "an append moves nothing",
  );
  assert.deepEqual(
    diffBlocks(documentBlocks("a\n\nb"), documentBlocks("new\n\na\n\nb")).map((change) => [
      change.status,
      change.line,
      change.fromLine,
    ]),
    [
      ["added", 1, undefined],
      ["moved", 3, 1],
      ["moved", 5, 3],
    ],
    "a block that keeps its identity but changes line is moved",
  );
  assert.deepEqual(
    diffBlocks(documentBlocks("a\n\nb\n\nc"), documentBlocks("a\n\nc")).map((change) => change.status),
    ["moved", "removed"],
    "a deletion moves the block after it and removes the deleted one",
  );
  assert.deepEqual(diffBlocks(before, before), [], "an unchanged document reports nothing");
});

const batchOf = (previous: string, next: string) => diffDocumentOperations(previous, next);
const kindsOf = (operations: DocumentOperation[]) => operations.map((operation) => operation.op);

test("diffDocumentOperations returns an empty batch for identical texts", () => {
  assert.deepEqual(batchOf(DOC, DOC), [], "no operations when nothing changed");
  assert.deepEqual(batchOf("", ""), []);
});

test("diffDocumentOperations turns one changed word into one delete_range plus one insert_text", () => {
  const previous = "# Title\n\nintro paragraph\n\nlast line";
  const next = "# Title\n\nchanged paragraph\n\nlast line";
  const operations = batchOf(previous, next);
  assert.deepEqual(kindsOf(operations), ["delete_range", "insert_text"], "a contiguous change is never a replace");
  assert.deepEqual(operations, [
    { op: "delete_range", start: { line: 3, column: 1 }, end: { line: 3, column: 6 } },
    { op: "insert_text", text: "changed", at: { line: 3, column: 1 } },
  ]);
  assert.equal(applied(documentOf(previous), operations).text, next);
  assert.equal(
    operations.some((operation) => operation.op === "replace_document"),
    false,
  );
});

test("diffDocumentOperations keeps a multi-line change contiguous", () => {
  const previous = "a\nb\nc\nd";
  const next = "a\nB\nC\nd";
  const operations = batchOf(previous, next);
  assert.deepEqual(kindsOf(operations), ["delete_range", "insert_text"]);
  assert.deepEqual(operations, [
    { op: "delete_range", start: { line: 2, column: 1 }, end: { line: 3, column: 2 } },
    { op: "insert_text", text: "B\nC", at: { line: 2, column: 1 } },
  ]);
  assert.equal(applied(documentOf(previous), operations).text, next);
});

test("diffDocumentOperations locates a change at the very start and at the very end", () => {
  const atStart = batchOf("hello world", "Hello world");
  assert.deepEqual(atStart, [
    { op: "delete_range", start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    { op: "insert_text", text: "H", at: { line: 1, column: 1 } },
  ]);
  assert.equal(applied(documentOf("hello world"), atStart).text, "Hello world");
  const atEnd = batchOf("hello", "hellO");
  assert.deepEqual(atEnd, [
    { op: "delete_range", start: { line: 1, column: 5 }, end: { line: 1, column: 6 } },
    { op: "insert_text", text: "O", at: { line: 1, column: 5 } },
  ]);
  assert.equal(applied(documentOf("hello"), atEnd).text, "hellO");
});

test("diffDocumentOperations inserts without deleting and deletes without inserting", () => {
  const insertion = batchOf("ac", "abc");
  assert.deepEqual(kindsOf(insertion), ["insert_text"], "a pure insertion carries no delete_range");
  assert.deepEqual(insertion, [{ op: "insert_text", text: "b", at: { line: 1, column: 2 } }]);
  assert.equal(applied(documentOf("ac"), insertion).text, "abc");
  const appendedLine = batchOf("a", "a\nb");
  assert.deepEqual(kindsOf(appendedLine), ["insert_text"]);
  assert.equal(applied(documentOf("a"), appendedLine).text, "a\nb");
  const deletion = batchOf("abXc", "abc");
  assert.deepEqual(kindsOf(deletion), ["delete_range"], "a pure deletion carries no insert_text");
  assert.deepEqual(deletion, [{ op: "delete_range", start: { line: 1, column: 3 }, end: { line: 1, column: 4 } }]);
  assert.equal(applied(documentOf("abXc"), deletion).text, "abc");
});

test("diffDocumentOperations round-trips every pair through the engine", () => {
  const texts = [
    "",
    "a",
    "\n",
    "# Title",
    "# Title\n",
    "# Title\n\nbody",
    "line one\nline two\nline three",
    "línea ñ 表 🎯\n\nsecond block\n",
    DOC,
    `${DOC}\n\ntrailing paragraph\n`,
    DOC.replace("- second", "- second edited"),
  ];
  for (const previous of texts) {
    for (const next of texts) {
      if (previous === next) {
        assert.deepEqual(batchOf(previous, next), [], "identical texts need no operations");
        continue;
      }
      const operations = batchOf(previous, next);
      assert.ok(operations.length > 0, "a real change produces a batch");
      assert.equal(operations.length <= 2, true, "the smallest batch is at most one delete and one insert");
      const result = applyDocumentOperations(documentOf(previous), operations);
      if (next.length === 0) {
        assert.equal(result.ok, false, "an emptied document is refused by the engine");
        continue;
      }
      assert.equal(result.ok, true, result.ok ? "" : `${result.reason} ${previous} -> ${next}`);
      if (result.ok) assert.equal(result.value.text, next, `${JSON.stringify(previous)} -> ${JSON.stringify(next)}`);
    }
  }
});
