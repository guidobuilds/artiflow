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
import { DRAFT_FLAG_SELECTOR, publishDraftFlag, republishedSince } from "../apps/dashboard/src/viewer-thread-sync.ts";

test("every editor chrome, selection and comment action uses the shared noninteractive tooltip", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const page = read("../apps/dashboard/src/EditorPage.tsx");
  const sidebar = read("../apps/dashboard/src/components/comments/comment-thread-margin.tsx");
  assert.doesNotMatch(
    sidebar,
    /<IconAction\s+icon="trash"\s+label=\{root/,
    "the shared margin replaced the old sidebar actions",
  );
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
    ["left", '"Previous thread"'],
    ["right", '"Next thread"'],
    ["x", '"Close thread"'],
    ["trash", "{`Delete reply by ${authorName(entry.author)}"],
    ["x", '"Cancel comment"'],
  ]);
  assert.equal(
    [...page.matchAll(/<button\b/g)].length,
    1,
    "only the text-valued block type trigger bypasses IconAction",
  );
  assert.match(
    sidebar,
    /<button\s+ref=\{pillRef\}\s+type="button"/,
    "only the pill is a native button so keyboard focus works; every icon action keeps the shared tooltip",
  );
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
  const sidebar = readFileSync(
    new URL("../apps/dashboard/src/components/comments/markdown-comments.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    sidebar,
    /Markdown source|Select comment source|Select source to comment|sourceInput|setSelectionRange/,
  );
  assert.match(sidebar, /mapRenderedSelection/);
  assert.match(sidebar, /renderedQuote\(draft\.quotedText\)/);
  assert.match(sidebar, /quotedText: quote/);
  assert.match(sidebar, /kind: "text-range"/);
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  assert.match(page, /sourceBlockSpan/);
});

test("canvas selection opens the margin at the selection; cards mark, scroll when needed and flash", () => {
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  const margin = readFileSync(
    new URL("../apps/dashboard/src/components/comments/comment-thread-margin.tsx", import.meta.url),
    "utf8",
  );
  const markdown = readFileSync(
    new URL("../apps/dashboard/src/components/comments/markdown-comments.tsx", import.meta.url),
    "utf8",
  );
  const callback = page.match(/const selectThread = \(id: string\) => \{([^]*?)\n  \};/);
  assert.ok(callback, "canvas navigation has an isolated state-only callback");
  let active: string | null = null,
    history = true;
  const select = compileFunction(`return (id) => {${callback[1]}}`, ["setActiveThread", "setHistoryOpen"])(
    (value: string | null) => {
      active = value;
    },
    (value: boolean) => {
      history = value;
    },
  );
  select("thread");
  assert.deepEqual([active, history], ["thread", false], "a highlight opens its thread and closes history");
  assert.match(page, /handleClick:/);
  assert.match(page, /handleKeyDown:[^]*?event.key !== "Enter"[^]*?selection.empty/);
  assert.match(page, /onFocusAnchor=\{markAnchor\}/);
  assert.match(page, /activeId=\{activeThread\}/);
  assert.match(page, /top: Math\.max\(0, position\.top/);
  assert.match(markdown, /begin\(selection\.text, selection\.span, selection\.top\)/);
  assert.match(markdown, /draftAnchorTop=\{draft\?\.anchorTop \?\? 0\}/);
  assert.match(page, /box\.top < 0 \|\| box\.bottom > window\.innerHeight/);
  assert.match(page, /block: "center"/);
  assert.match(page, /classList\.add\("comment-marker-flash"\)/);
  assert.match(margin, /data-thread-id=\{thread\.id\}/);
  assert.match(margin, /<button\s+ref=\{pillRef\}\s+type="button"\s+data-thread-id=\{thread\.id\}/);
  assert.match(margin, /aria-expanded=\{active\}/);
  assert.match(markdown, /activateCallback\.current\(null\)/);
});

test("the editor highlights follow the thread state and hide with the margin", () => {
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../apps/dashboard/src/styles/globals.css", import.meta.url), "utf8");
  assert.match(page, /if \(!live\.current\.visible\) return \[\]/);
  assert.match(page, /live\.current\.showResolved \|\| thread\.resolvedAt === null/);
  assert.match(page, /"comment-marker-active"/);
  assert.match(page, /"comment-marker-resolved"/);
  assert.match(page, /readCommentsVisible\(commentStorage\.current\)/);
  assert.match(page, /writeCommentsVisible\(commentStorage\.current, next\)/);
  assert.match(styles, /\.comment-marker-active \{/);
  assert.match(styles, /\.comment-marker-stale \{[^}]*border-bottom: 1px dotted var\(--fg-subtle\)/);
  assert.match(styles, /\.editor-workspace\.editor-margin-open \{\s*grid-template-columns: minmax\(0, 1fr\) 360px;/);
  assert.equal(
    readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8").includes("CommentSidebar"),
    false,
  );
});

test("anchor positions recompute on resize, scroll, content and font load", () => {
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  assert.match(page, /coordsAtPos\(range\.from\)\.top \+ window\.scrollY - base/);
  assert.match(page, /new ResizeObserver\(frame\)/);
  assert.match(page, /canvas\.addEventListener\("scroll", frame\)/);
  assert.match(page, /window\.addEventListener\("resize", frame\)/);
  assert.match(page, /document\.fonts\?\.ready\.then\(frame\)/);
  assert.match(page, /\[measureAnchors, comments, state\.text, commentsVisible, showResolved\]/);
});

test("the viewer island advertises a typed draft on the shell the poller reads", () => {
  assert.equal(
    DRAFT_FLAG_SELECTOR,
    "[data-comment-draft='typed'], [data-comment-input='typed']",
    "both draft surfaces the margin already renders are watched",
  );
  const target = { dataset: {} as Record<string, string | undefined> };
  publishDraftFlag({ querySelector: () => null }, target);
  assert.equal(target.dataset.commentDraft, undefined, "no draft, no flag");
  publishDraftFlag({ querySelector: () => ({}) }, target);
  assert.equal(target.dataset.commentDraft, "typed", "a typed draft is advertised where the poller looks");
  publishDraftFlag({ querySelector: () => null }, target);
  assert.equal(
    "commentDraft" in target.dataset,
    false,
    "ending the draft removes the flag instead of leaving a stale one",
  );

  const viewer = readFileSync(new URL("../apps/dashboard/src/viewer-comments.tsx", import.meta.url), "utf8");
  assert.equal([...viewer.matchAll(/watchDrafts\(host, shell, /g)].length, 2, "both mounts advertise the state");
  assert.match(viewer, /publishDraftFlag\(host, shell\)/, "the flag is published on the shell, not on a draft node");
  const block = viewer.slice(viewer.indexOf("const watchDrafts"), viewer.indexOf("const fetchThreads"));
  assert.match(block, /new MutationObserver\(publish\)/, "a draft opened inside the React tree is observed");
  assert.match(block, /childList: true/, "opening a draft is a childList mutation");
  assert.match(block, /subtree: true/, "the draft panel is nested under the host");
  assert.match(block, /observe\(host, \{/, "the observed node is the comments host");
  assert.match(block, /attributeFilter: \["data-comment-draft", "data-comment-input"\]/);
  assert.ok(block.includes("publish();"), "the state is published on mount, not only on mutation");
  assert.ok(
    block.indexOf("publish();") < block.indexOf("new MutationObserver"),
    "and that first publish happens before anything is observed",
  );
  assert.match(
    block,
    /new MutationObserver\(onShell\)\.observe\(shell, \{/,
    "the shell is observed too, or the island never learns the poller marked the draft",
  );
  assert.match(block, /attributeFilter: \["data-revision-stale"\]/);
});

test("the draft panel says the artifact was republished while the draft was open", () => {
  const margin = readFileSync(
    new URL("../apps/dashboard/src/components/comments/comment-thread-margin.tsx", import.meta.url),
    "utf8",
  );
  const viewer = readFileSync(new URL("../apps/dashboard/src/viewer-comments.tsx", import.meta.url), "utf8");
  assert.equal(republishedSince({ dataset: {} }), false, "a page that was never republished says nothing");
  assert.equal(republishedSince({ dataset: { revisionStale: "4" } }), true, "the poller's mark is what is read");
  assert.match(margin, /republished\?: boolean/, "the margin takes it as an optional prop");
  assert.match(margin, /republished while your draft was open/, "and says what happened");
  assert.match(margin, /role="status"/, "the line is announced, not just painted");
  assert.equal([...margin.matchAll(/republished=\{republished\}/g)].length, 2, "both draft panels receive it");
  assert.match(viewer, /republishedSince\(shell\)/, "the island reads the mark the poller writes");
  assert.equal(
    [...viewer.matchAll(/draftFlagOf\(host\) === null \? false : republishedSince\(shell\)/g)].length,
    2,
    "both mounts refuse the line unless a typed draft is open",
  );
  assert.equal(
    [...viewer.matchAll(/republished=\{state\.republished\}/g)].length,
    2,
    "and both mounts hand it to the margin, not just one",
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
