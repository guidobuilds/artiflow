import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import {
  createComment,
  deleteComment,
  listComments,
  parseComments,
  resolveComment,
} from "../apps/dashboard/src/comments-api.ts";
import type { TextRangeAnchor } from "@artiflow/domain/comment-anchors";
import { Autosave } from "../apps/dashboard/src/editor-autosave.ts";
import { toolbarGroups, blockTypes } from "../apps/dashboard/src/editor-markdown.ts";

test("every editor chrome, selection and comment action uses the shared noninteractive tooltip", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const page = read("../apps/dashboard/src/EditorPage.tsx");
  const sidebar = read("../apps/dashboard/src/CommentSidebar.tsx");
  const actions = [...(page + sidebar).matchAll(/<IconAction\s+icon="([^"]+)"\s+label=("[^"]+"|\{[^}]+\})/g)].map(
    (match) => [match[1], match[2]],
  );
  assert.deepEqual(actions, [
    ["history", '"Version history"'],
    ["chat", '"Comments"'],
    ["plus", '"Add row"'],
    ["plus", '"Add column"'],
    ["trash", '"Delete row"'],
    ["trash", '"Delete column"'],
    ["trash", '"Delete table"'],
    ["refresh", '"Reload from server (discard local edits)"'],
    ["refresh", '"Retry save"'],
    ["down", '"Reload from server"'],
    ["bold", '"Bold"'],
    ["italic", '"Italic"'],
    ["strike", '"Strikethrough"'],
    ["code", '"Inline code"'],
    ["chat", '"Comment"'],
    ["refresh", '"Retry history"'],
    ["history", "{`Restore version ${revision.revisionNumber}"],
    ["trash", '{root ? "Delete thread" : "Delete reply"}'],
    ["x", '"Cancel comment"'],
    ["send", '{draft.parentId ? "Post reply" : "Post comment"}'],
    ["refresh", '"Refresh threads"'],
    ["chat", '"Reply"'],
    ["check", '{thread.resolvedAt ? "Unresolve" : "Resolve"}'],
  ]);
  assert.equal(
    [...page.matchAll(/<button\b/g)].length,
    1,
    "only the text-valued block type trigger bypasses IconAction",
  );
  assert.doesNotMatch(sidebar, /<button\b/, "comment actions still use shared tooltips");
  assert.match(page, /icon=\{entry\.icon\}\s+label=\{entry\.label\}/, "every toolbar entry uses the shared tooltip");
  assert.deepEqual(
    toolbarGroups.flatMap((g) => g.entries.map((e) => e.label)),
    [
      "Undo",
      "Redo",
      "Block type",
      "Bold",
      "Italic",
      "Strikethrough",
      "Inline code",
      "Bulleted list",
      "Numbered list",
      "Checklist",
      "Link",
      "Image",
      "Table",
      "Divider",
    ],
  );
  assert.deepEqual(
    blockTypes.map((e) => e.label),
    ["Paragraph", "Heading 1", "Heading 2", "Heading 3", "Quote", "Code block"],
  );
  assert.match(page, /<TooltipContent>Block type<\/TooltipContent>/);
  assert.match(
    page,
    /<MenuItem[^]*?icon=\{block\.icon\}[^]*?>\s*\{block\.label\}\s*<\/MenuItem>/,
    "dropdown options have visible names and icons",
  );
  const icon = read("../apps/dashboard/src/components/ui/icon.tsx");
  assert.match(
    icon,
    /<Tooltip disableHoverableContent>/,
    "action labels must not trap the pointer in transit between triggers",
  );
  assert.match(icon, /<TooltipTrigger asChild>\s*<button[^>]*aria-label=\{label\}/);
  assert.match(icon, /<TooltipContent>\{label\}<\/TooltipContent>/);
});

test("composer quotes the rendered selection and offers rendered occurrences, never source edits", () => {
  const sidebar = readFileSync(new URL("../apps/dashboard/src/CommentSidebar.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(
    sidebar,
    /Markdown source|Select comment source|Select source to comment|sourceInput|setSelectionRange/,
  );
  assert.match(sidebar, /Which occurrence\?/);
  assert.match(sidebar, /\{draft\.quotedText\}/);
  assert.match(sidebar, /quotedText: quote/);
  assert.match(sidebar, /renderedQuote\(thread\.quotedText\)/);
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  assert.match(page, /sourceBlockSpan/);
});

test("canvas selection opens the panel with a repeatable request; sidebar focuses, scrolls and flashes even resolved threads", () => {
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  const sidebar = readFileSync(new URL("../apps/dashboard/src/CommentSidebar.tsx", import.meta.url), "utf8");
  const callback = page.match(/const selectThread = \(id: string\) => \{([^]*?)\n  \};/);
  assert.ok(callback, "canvas navigation has an isolated state-only callback");
  let open = false,
    history = true,
    selected: { id: string; serial: number } | null = null;
  const select = compileFunction(`return (id) => {${callback[1]}}`, [
    "setCommentsOpen",
    "setHistoryOpen",
    "setSelectedThread",
  ])(
    (value: boolean) => {
      open = value;
    },
    (value: boolean) => {
      history = value;
    },
    (update: (previous: typeof selected) => typeof selected) => {
      selected = update(selected);
    },
  );
  select("resolved");
  assert.deepEqual([open, history, selected], [true, false, { id: "resolved", serial: 1 }]);
  select("resolved");
  assert.deepEqual(selected, { id: "resolved", serial: 2 });
  assert.match(page, /handleClick:/);
  assert.match(page, /handleKeyDown:[^]*?event.key !== "Enter"[^]*?selection.empty/);
  assert.match(page, /selectedThread=\{selectedThread\}/);
  assert.match(sidebar, /if \(!open \|\| !selectedThread\) return/);
  assert.match(sidebar, /data-thread-id=\{thread.id\}\s+tabIndex=\{-1\}/);
  assert.match(sidebar, /focus\(\{ preventScroll: true \}\)/);
  assert.match(sidebar, /scrollIntoView/);
  assert.match(sidebar, /classList.add\("comment-marker-flash"\)/);
  assert.match(sidebar, /\[open, selectedThread, data\]/);
  assert.match(
    sidebar,
    /<details open=\{!thread.resolvedAt\}>/,
    "resolved rows remain navigable without mutating resolution",
  );
});

const anchor: TextRangeAnchor = {
  kind: "text-range",
  startLine: 1,
  startCol: 1,
  endLine: 1,
  endCol: 6,
  quotedText: "Hello",
};
const row = {
  id: "comment",
  authorId: "author",
  author: { id: "author", name: "Author One", image: null },
  anchor,
  body: "Thought",
  resolvedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  canDelete: false,
};
test("thread parsing preserves server permissions, source anchors and ordered replies", () => {
  const payload = {
    canComment: false,
    comments: [{ ...row, quotedText: "Hello", replies: [{ ...row, anchor: null, quotedText: "", id: "reply" }] }],
  };
  assert.deepEqual(parseComments(payload), payload);
  assert.equal(parseComments({ comments: payload.comments }), null);
  assert.equal(
    parseComments({ ...payload, comments: [{ ...row, replies: [{ ...row, canDelete: undefined }] }] }),
    null,
  );
  assert.equal(parseComments({ ...payload, comments: [{ ...row, anchor: null, replies: [] }] }), null);
});
test("comment requests use only comments endpoints and JSON; forbidden remains authoritative; autosave unaffected", async () => {
  const original = globalThis.fetch;
  const calls: { path: string; init: RequestInit }[] = [];
  const controller = new Autosave(
    { artifactId: "doc", title: "Title", kind: "markdown", text: "Hello", revisionId: "v1", revisionNumber: 1 },
    async () => {
      throw new Error("Commenting must not save");
    },
    () => {
      throw new Error("Commenting must not dirty the document");
    },
    () => {},
  );
  let forbidden = false;
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ path: String(input), init });
    return new Response(
      JSON.stringify(
        forbidden
          ? { error: "forbidden" }
          : init.method === "GET"
            ? { canComment: true, comments: [{ ...row, replies: [] }] }
            : { id: "comment" },
      ),
      { status: forbidden ? 403 : 200 },
    );
  };
  try {
    assert.equal((await listComments("doc")).ok, true);
    assert.equal((await createComment("doc", { anchor, body: "Thought" })).ok, true);
    assert.equal((await resolveComment("doc", "comment", true)).ok, true);
    assert.equal((await resolveComment("doc", "comment", false)).ok, true);
    assert.equal((await deleteComment("doc", "comment")).ok, true);
    assert.deepEqual(
      calls.map(({ path, init }) => [path, init.method]),
      [
        ["/api/artifacts/doc/comments", "GET"],
        ["/api/artifacts/doc/comments", "POST"],
        ["/api/artifacts/doc/comments/comment/resolve", "POST"],
        ["/api/artifacts/doc/comments/comment/unresolve", "POST"],
        ["/api/artifacts/doc/comments/comment", "DELETE"],
      ],
    );
    for (const { init } of calls.slice(1)) {
      assert.equal(new Headers(init.headers).get("content-type"), "application/json");
      assert.equal(init.credentials, "same-origin");
      assert.ok(init.body);
    }
    forbidden = true;
    const result = await createComment("doc", { anchor, body: "Thought" });
    assert.ok(!result.ok);
    assert.equal(result.code, "forbidden");
    assert.deepEqual(
      [controller.state.text, controller.state.status, controller.state.dirty],
      ["Hello", "saved", false],
    );
    await controller.flush();
  } finally {
    controller.dispose();
    globalThis.fetch = original;
  }
});
