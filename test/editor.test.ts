import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import { Editor } from "@tiptap/core";
import { history } from "@tiptap/pm/history";
import {
  anchorText,
  mapRenderedSelection,
  sourceBlockSpan,
  commentThreadAtPosition,
} from "@artiflow/domain/comment-anchors";

test("editor selection block indexes map stored noncanonical markdown without editing it", () => {
  const source = "# Heading\n\nsame\n\n> **same** and *more*\n> continuation\n\n| A | B |\n| --- | --- |\n| C | D |\n";
  const editor = new Editor({ element: null, extensions: markdownExtensions, content: markdown.parse(source) });
  try {
    let from = 0,
      to = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "same" && pos > 15) {
        from = pos;
        to = pos + node.nodeSize;
      }
    });
    assert.ok(from);
    editor.commands.setTextSelection({ from, to });
    const block = editor.state.doc.resolve(from).index(0);
    const result = mapRenderedSelection(
      source,
      editor.state.doc.textBetween(from, to, "\n"),
      sourceBlockSpan(source, block, block),
    );
    assert.equal(anchorText(source, result.anchor!), "same");
    assert.equal(result.anchor!.startLine, 5);
    assert.equal(editor.getMarkdown().includes("same"), true);
  } finally {
    editor.destroy();
  }
});

test("fixed toolbar exposes the exact ordered groups and labeled commands", () => {
  assert.ok("toolbarGroups" in insertMenu);
  assert.deepEqual(
    insertMenu.toolbarGroups.map((g) => [g.label, g.entries.map((e) => [e.command, e.label])]),
    [
      [
        "History",
        [
          ["undo", "Undo"],
          ["redo", "Redo"],
        ],
      ],
      ["Block type", [["blockType", "Block type"]]],
      [
        "Text formatting",
        [
          ["toggleBold", "Bold"],
          ["toggleItalic", "Italic"],
          ["toggleStrike", "Strikethrough"],
          ["toggleCode", "Inline code"],
        ],
      ],
      [
        "Lists",
        [
          ["toggleBulletList", "Bulleted list"],
          ["toggleOrderedList", "Numbered list"],
          ["toggleTaskList", "Checklist"],
        ],
      ],
      [
        "Insert",
        [
          ["setLink", "Link"],
          ["setImage", "Image"],
          ["insertTable", "Table"],
          ["setHorizontalRule", "Divider"],
        ],
      ],
    ],
  );
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  assert.ok(page.indexOf('aria-label="Document formatting"') < page.indexOf("className={`editor-workspace"));
  assert.match(page, /toolbarGroups\.map/);
  assert.match(page, /aria-pressed=\{entry\.active \? !!active\?\.\[entry\.command\] : undefined\}/);
  assert.doesNotMatch(page, /insertOpen|pointerBlock|setGutter|insertMenuPosition|editor-insert/);
});

test("toolbar active predicates follow marks, lists, link and table selections", () => {
  assert.ok("toolbarGroups" in insertMenu);
  const expected: Record<string, string> = {
    toggleBold: "bold",
    toggleItalic: "italic",
    toggleStrike: "strike",
    toggleCode: "code",
    toggleBulletList: "bulletList",
    toggleOrderedList: "orderedList",
    toggleTaskList: "taskList",
    setLink: "link",
    insertTable: "table",
  };
  const toggles = insertMenu.toolbarGroups.flatMap((g) => g.entries).filter((e) => e.active);
  assert.deepEqual(
    toggles.map((e) => e.command),
    Object.keys(expected),
  );
  for (const entry of toggles) {
    const editor = new Editor({ element: null, extensions: markdownExtensions, content: markdown.parse("Text") });
    try {
      editor.commands.setTextSelection({ from: 1, to: 5 });
      assert.equal(entry.active!(editor), false);
      assert.equal(entry.run(editor.chain(), "https://example.test").run(), true);
      assert.equal(editor.isActive(expected[entry.command]!), true);
      assert.equal(entry.active!(editor), true);
      editor.commands.setContent(markdown.parse("Plain"), { emitUpdate: false });
      editor.commands.setTextSelection({ from: 1, to: 6 });
      assert.equal(entry.active!(editor), false, "active state follows the next selection rather than sticking");
    } finally {
      editor.destroy();
    }
  }
});
import { Autosave, AUTOSAVE_MS } from "../apps/dashboard/src/editor-autosave.ts";
import * as insertMenu from "../apps/dashboard/src/editor-markdown.ts";
import { markdown, markdownExtensions } from "../apps/dashboard/src/editor-markdown.ts";
import {
  getDocument,
  listRevisions,
  saveDocument,
  restoreRevision,
  openArtifact,
} from "../apps/dashboard/src/editor-api.ts";

test("block dropdown options match the installed schema and current selection", () => {
  assert.ok("blockTypes" in insertMenu, "shared block dropdown contract exists");
  const entries = insertMenu.blockTypes;
  assert.deepEqual(
    entries.map(({ label, command, schema }) => [label, command, schema]),
    [
      ["Paragraph", "setParagraph", "paragraph"],
      ["Heading 1", "setHeading", "heading"],
      ["Heading 2", "setHeading", "heading"],
      ["Heading 3", "setHeading", "heading"],
      ["Quote", "toggleBlockquote", "blockquote"],
      ["Code block", "toggleCodeBlock", "codeBlock"],
    ],
  );
  const editor = new Editor({ element: null, extensions: markdownExtensions, content: markdown.parse("Text") });
  try {
    for (const entry of entries) {
      assert.equal(typeof editor.commands[entry.command as keyof typeof editor.commands], "function", entry.label);
      assert.ok(editor.schema.nodes[entry.schema] || editor.schema.marks[entry.schema], entry.schema);
      assert.ok(entry.icon);
      const fresh = new Editor({
        element: null,
        extensions: markdownExtensions,
        content: markdown.parse(entry.schema === "paragraph" ? "# Text" : "Text"),
      });
      try {
        fresh.commands.setTextSelection({ from: 1, to: 5 });
        assert.equal(entry.run(fresh.chain(), "https://example.test/media").run(), true, entry.label);
        const json = JSON.stringify(fresh.getJSON());
        assert.ok(json.includes(`"type":"${entry.schema}"`), `${entry.label} inserts its declared schema type`);
        if (entry.attrs) assert.ok(json.includes(`"level":${entry.attrs.level}`));
        assert.equal(insertMenu.currentBlockType(fresh), entry.label);
      } finally {
        fresh.destroy();
      }
    }
    assert.deepEqual(
      entries.filter((entry) => entry.command === "setHeading").map((entry) => entry.attrs),
      [{ level: 1 }, { level: 2 }, { level: 3 }],
    );
  } finally {
    editor.destroy();
  }
});

test("toolbar preserves image, divider, table and history commands", () => {
  const entries = insertMenu.toolbarGroups.flatMap((g) => g.entries);
  for (const [command, schema] of [
    ["setImage", "image"],
    ["setHorizontalRule", "horizontalRule"],
    ["insertTable", "table"],
  ]) {
    const editor = new Editor({ element: null, extensions: markdownExtensions, content: markdown.parse("Text") });
    try {
      editor.registerPlugin(history());
      const before = editor.getJSON();
      assert.equal(
        entries
          .find((e) => e.command === command)!
          .run(editor.chain(), "https://example.test/media")
          .run(),
        true,
      );
      const after = editor.getJSON();
      assert.ok(JSON.stringify(after).includes(`"type":"${schema}"`));
      assert.equal(
        entries
          .find((e) => e.command === "undo")!
          .run(editor.chain(), "")
          .run(),
        true,
      );
      assert.deepEqual(editor.getJSON(), before);
      assert.equal(
        entries
          .find((e) => e.command === "redo")!
          .run(editor.chain(), "")
          .run(),
        true,
      );
      assert.deepEqual(editor.getJSON(), after);
    } finally {
      editor.destroy();
    }
  }
});

test("toolbar wraps in flow on theme tokens; selection bubble remains independent", () => {
  const css = readFileSync(new URL("../apps/dashboard/src/styles/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.editor-formatting \{[^}]*flex-wrap: wrap;[^}]*var\(--bg-raised\)/);
  assert.match(css, /\.editor-formatting-group \+ \.editor-formatting-group \{\s*border-left: 1px solid var\(--line\)/);
  assert.match(css, /\.editor-icon\[aria-pressed="true"\][^}]*background: var\(--selected\)/);
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  assert.match(page, /<BubbleMenu\s+editor=\{editor\}/);
  assert.match(page, /aria-label="Selection actions"/);
});

const doc = {
  artifactId: "a",
  title: "Notes",
  kind: "markdown" as const,
  revisionId: "r1",
  revisionNumber: 1,
  text: "old",
  seq: 4,
  publishedSeq: 2,
};
const ok = (revisionId = "r2", seq?: number) => ({
  ok: true as const,
  value: { revisionId, revisionNumber: 2, ...(seq === undefined ? {} : { seq }) },
});
const failure = (code: string) => ({ ok: false as const, code, error: "Failed", signInRequired: false });
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function editorWiring(session: Autosave, text: string) {
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  const update = page.match(/onUpdate:\s*(\([^\n]+\) => \{[^]*?\}),/)!;
  const editable = page.match(
    /useEffect\(\(\) => \{\s*(editor\?\.setEditable\([^;]+\));\s*\}, \[editor, readOnly\]\)/,
  )!;
  assert.ok(update, "page update callback exists");
  assert.ok(editable, "page editable-state effect exists");
  const onUpdate = compileFunction(`return ${update[1]}`, ["session"])({ current: session });
  const editor = new Editor({ element: null, extensions: markdownExtensions, content: markdown.parse(text), onUpdate });
  return {
    editor,
    setReadOnly: (readOnly: boolean) => compileFunction(editable[1]!, ["editor", "readOnly"])(editor, readOnly),
  };
}

const seeded =
  "# Quiet Observatory\n\nA copper lantern guides patient travelers across silver meadows while distant mountains shelter curious birds beneath violet skies.\n\n| Season | Place | Detail |\n| --- | --- | --- |\n| Spring | Valley | Blossom |\n| Winter | Ridge | Snow |\n";

for (const transition of ["mount", "restore", "reload"] as const) {
  test(`${transition}: initial/programmatic serialization stays saved without scheduling a flush`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const initial = { ...doc, text: seeded };
    const content = new Editor({ element: null, extensions: markdownExtensions, content: markdown.parse(seeded) });
    const serialized = content.getMarkdown();
    assert.notEqual(serialized, seeded, "fixture exercises noncanonical stored markdown");
    let saves = 0;
    const session = new Autosave(
      initial,
      async () => {
        saves++;
        return ok();
      },
      () => {},
      () => {},
      serialized,
    );
    const flushSpy = t.mock.method(session, "flush");
    const { editor } = editorWiring(session, seeded);
    try {
      if (transition !== "mount") {
        assert.equal(transition === "restore" ? session.beginRestore() : session.beginReload(), true);
        session.replace(initial, serialized);
      }
      editor.emit("update", { editor, transaction: editor.state.tr, appendedTransactions: [] });
      assert.deepEqual([session.state.status, session.state.dirty, session.state.text], ["saved", false, seeded]);
      t.mock.timers.tick(AUTOSAVE_MS + 12000);
      await flush();
      assert.equal(flushSpy.mock.callCount(), 0, "no flush scheduled by initialization");
      assert.equal(saves, 0);
      assert.equal(session.state.revisionId, "r1");
      editor.view.dispatch(editor.state.tr.insertText("User ", 1));
      assert.equal(session.state.status, "unsaved");
      session.change(serialized);
      assert.deepEqual(
        [session.state.status, session.state.dirty, session.state.text],
        ["saved", false, seeded],
        "reverting an edit must retain stored comment coordinates",
      );
      t.mock.timers.tick(AUTOSAVE_MS);
      await flush();
      assert.equal(saves, 0, "reverted edits do not save normalized source");
      session.change(editor.getMarkdown());
      t.mock.timers.tick(AUTOSAVE_MS);
      await flush();
      assert.equal(saves, 1, "genuine edit still saves");
    } finally {
      session.dispose();
      content.destroy();
      editor.destroy();
    }
  });
}

for (const [name, source] of [
  ["heading", "# Quiet Observatory"],
  ["paragraph", seeded.split("\n\n")[1]!],
  ["table", seeded.split("\n\n")[2]!],
  ["complete seeded document", seeded],
] as const) {
  test(`seeded ${name} round-trip is structurally lossless and serialization is idempotent`, () => {
    const parsed = markdown.parse(source);
    const canonical = markdown.serialize(parsed);
    assert.deepEqual(markdown.parse(canonical), parsed);
    assert.equal(markdown.serialize(markdown.parse(canonical)), canonical);
  });
}

test("page initializes and replaces autosave with the editor serialization baseline", () => {
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  assert.match(page, /setState,\s*refreshHistory,\s*editor\.getMarkdown\(\)/);
  assert.match(
    page,
    /session\.current = controller;\s+setState\(controller\.state\)/,
    "a recreated controller must synchronize the rendered save state",
  );
  assert.match(page, /controller\.replace\(result\.value, editor\?\.getMarkdown\(\)\)/);
  assert.match(page, /controller\.replace\(document\.value, editor\?\.getMarkdown\(\)\)/);
});

for (const transition of ["mount", "restore", "reload"] as const) {
  test(`${transition} does not dirty or autosave programmatic content; first user edit still debounces`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const text = "# Notes\n\nOriginal paragraph.\n";
    const calls: unknown[] = [];
    let committed = 0;
    const initial = { ...doc, text };
    const session = new Autosave(
      initial,
      async (source, revision) => {
        calls.push([source, revision]);
        return ok("r3");
      },
      () => {},
      () => {
        committed++;
      },
    );
    const { editor, setReadOnly } = editorWiring(session, text);
    try {
      setReadOnly(false);
      if (transition !== "mount") {
        session.change("pending local edit");
        assert.equal(transition === "restore" ? session.beginRestore() : session.beginReload(), true);
        setReadOnly(true);
        editor.commands.setContent(markdown.parse(text), { emitUpdate: false });
        session.replace({ ...initial, revisionId: "r2", revisionNumber: 2 });
        setReadOnly(false);
      }
      t.mock.timers.tick(AUTOSAVE_MS + 500);
      await flush();
      assert.deepEqual(calls, [], "no save without user input");
      assert.equal(committed, 0);
      assert.deepEqual(session.state, {
        text,
        revisionId: transition === "mount" ? "r1" : "r2",
        revisionNumber: transition === "mount" ? 1 : 2,
        seq: 4,
        dirty: false,
        status: "saved",
        ...(transition === "mount" ? {} : { code: undefined }),
      });
      editor.view.dispatch(editor.state.tr.insertText("User ", 1));
      assert.equal(session.state.dirty, true);
      assert.equal(session.state.status, "unsaved");
      t.mock.timers.tick(AUTOSAVE_MS - 1);
      assert.deepEqual(calls, []);
      t.mock.timers.tick(1);
      await flush();
      assert.deepEqual(calls, [[editor.getMarkdown(), transition === "mount" ? "r1" : "r2"]]);
      assert.equal(session.state.dirty, false);
      assert.equal(session.state.status, "saved");
      assert.equal(committed, 1);
    } finally {
      session.dispose();
      editor.destroy();
    }
  });
}

test("comment decoration and bubble dismissal transactions never dirty or schedule autosave", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const initial = { ...doc, text: "**Hello** world\n" };
  let saves = 0;
  const session = new Autosave(
    initial,
    async () => {
      saves++;
      return ok();
    },
    () => {},
    () => {},
  );
  const { editor } = editorWiring(session, initial.text);
  try {
    editor.view.dispatch(editor.state.tr.setMeta("commentMarkers", true));
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.setMeta("bubbleMenu", "hide");
    editor.view.dispatch(editor.state.tr.setMeta("commentMarkers", true));
    t.mock.timers.tick(AUTOSAVE_MS + 1);
    await flush();
    assert.deepEqual(
      [session.state.text, session.state.status, session.state.dirty, saves],
      [initial.text, "saved", false, 0],
    );
    editor.view.dispatch(editor.state.tr.insertText("!", 6));
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.equal(saves, 1, "real typing still saves");
  } finally {
    editor.destroy();
    session.dispose();
  }
});

test("canvas comment handlers navigate without editing; plain clicks, modified Enter and selections retain defaults", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  const click = page.match(/^([ \t]*)handleClick: (\(view, position, event\) => \{[^]*?\n\1\}),/m)!;
  const key = page.match(/^([ \t]*)handleKeyDown: (\(view, event\) => \{[^]*?\n\1\}),/m)!;
  assert.ok(click);
  assert.ok(key);
  const initial = { ...doc, text: "Hello world" };
  let saves = 0;
  const session = new Autosave(
    initial,
    async () => {
      saves++;
      return ok();
    },
    () => {},
    () => {},
  );
  const { editor } = editorWiring(session, initial.text);
  const threads = [
    { id: "thread", anchor: { startLine: 1, startCol: 1, endLine: 1, endCol: 6 }, createdAt: "2026-01-01" },
  ];
  const ranges = [{ id: "thread", from: 1, to: 6, stale: false, className: "comment-marker" }];
  const selected: string[] = [];
  const instantiate = (body: string) =>
    compileFunction(`return ${body}`, [
      "markerRanges",
      "markers",
      "commentThreadAtPosition",
      "selectThread",
      "Element",
    ])(
      () => ranges,
      { current: { data: { comments: threads } } },
      commentThreadAtPosition,
      (id: string) => selected.push(id),
      class {},
    );
  const handleClick = instantiate(click[2]!);
  const handleKeyDown = instantiate(key[2]!);
  try {
    const before = editor.getJSON();
    assert.equal(handleClick(editor.view, 2, { target: null }), false, "comment clicks preserve native selection");
    assert.deepEqual(selected, ["thread"]);
    assert.equal(handleClick(editor.view, 9, { target: null }), false);
    assert.deepEqual(selected, ["thread"], "plain clicks do not navigate");
    editor.commands.setTextSelection(2);
    assert.equal(handleKeyDown(editor.view, { key: "Enter" }), true);
    assert.deepEqual(selected, ["thread", "thread"]);
    for (const event of [
      { key: "x" },
      ...["shiftKey", "ctrlKey", "metaKey", "altKey", "isComposing"].map((modifier) => ({
        key: "Enter",
        [modifier]: true,
      })),
    ])
      assert.equal(handleKeyDown(editor.view, event), false);
    editor.commands.setTextSelection({ from: 2, to: 4 });
    assert.equal(handleKeyDown(editor.view, { key: "Enter" }), false);
    editor.commands.setTextSelection(9);
    assert.equal(handleKeyDown(editor.view, { key: "Enter" }), false);
    assert.deepEqual(selected, ["thread", "thread"]);
    assert.deepEqual(editor.getJSON(), before);
    t.mock.timers.tick(AUTOSAVE_MS + 1);
    await flush();
    assert.deepEqual(
      [saves, session.state.dirty, session.state.revisionId, session.state.text],
      [0, false, "r1", initial.text],
    );
  } finally {
    editor.destroy();
    session.dispose();
  }
});

test("autosave debounces 1500ms, uses CAS, refreshes history and preserves edits during a save", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: unknown[] = [];
  let resolve!: (result: ReturnType<typeof ok>) => void;
  let refreshed = 0;
  const session = new Autosave(
    doc,
    async (text, revision) => {
      calls.push([text, revision]);
      return calls.length === 1
        ? new Promise((done) => {
            resolve = done;
          })
        : ok("r3");
    },
    () => {},
    () => {
      refreshed++;
    },
  );
  session.change("a");
  t.mock.timers.tick(1000);
  session.change("b");
  t.mock.timers.tick(1499);
  assert.deepEqual(calls, []);
  assert.equal(session.state.status, "unsaved");
  t.mock.timers.tick(1);
  assert.equal(session.state.status, "saving");
  assert.deepEqual(calls, [["b", "r1"]]);
  session.change("c");
  t.mock.timers.tick(2000);
  assert.equal(calls.length, 1);
  resolve(ok());
  await flush();
  assert.equal(session.state.text, "c");
  assert.equal(session.state.status, "unsaved");
  assert.equal(refreshed, 1);
  t.mock.timers.tick(1500);
  await flush();
  assert.deepEqual(calls, [
    ["b", "r1"],
    ["c", "r2"],
  ]);
  assert.equal(session.state.status, "saved");
  assert.equal(refreshed, 2);
  session.dispose();
});

for (const [code, status] of [
  ["concurrent_edit", "conflict"],
  ["forbidden", "readonly"],
  ["too_large", "error"],
  ["network", "error"],
] as const) {
  test(`${code} preserves local text and stops automatic retries`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const session = new Autosave(
      doc,
      async () => {
        calls++;
        return failure(code);
      },
      () => {},
      () => assert.fail("history must not refresh"),
    );
    session.change("local");
    t.mock.timers.tick(1500);
    await flush();
    assert.equal(session.state.status, status);
    assert.equal(session.state.text, "local");
    assert.equal(session.state.revisionId, "r1");
    t.mock.timers.tick(10000);
    assert.equal(calls, 1);
    session.change("more");
    t.mock.timers.tick(1500);
    assert.equal(calls, 1);
    session.dispose();
  });
}

test("unchanged text, reverted edits and disposed sessions never save", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new Autosave(
    doc,
    async () => assert.fail("unexpected save"),
    () => {},
    () => {},
  );
  session.change("old");
  session.change("new");
  session.change("old");
  t.mock.timers.tick(2000);
  assert.equal(session.state.status, "saved");
  session.change("new");
  session.dispose();
  t.mock.timers.tick(2000);
});

test("restore pauses pending autosave, reload replaces the base, and future saves use the restored revision", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: unknown[] = [];
  const session = new Autosave(
    doc,
    async (text, revision) => {
      calls.push([text, revision]);
      return ok("r4");
    },
    () => {},
    () => {},
  );
  session.change("unsaved");
  assert.equal(session.beginRestore(), true);
  session.change("must not apply");
  t.mock.timers.tick(5000);
  assert.deepEqual(calls, []);
  assert.equal(session.state.text, "unsaved");
  session.replace({ ...doc, text: "restored", revisionId: "r3", revisionNumber: 3 });
  assert.equal(session.state.status, "saved");
  assert.equal(session.state.dirty, false);
  session.change("new edits");
  t.mock.timers.tick(1500);
  await flush();
  assert.deepEqual(calls, [["new edits", "r3"]]);
  session.reject("concurrent_edit");
  assert.equal(session.beginRestore(), false);
  assert.equal(session.beginReload(), true);
  session.replace(doc);
  assert.equal(session.state.status, "saved");
  session.reject("forbidden");
  assert.equal(session.beginRestore(), false);
  assert.equal(session.beginReload(), true);
  session.replace(doc);
  assert.equal(session.state.status, "readonly");
  session.dispose();
});

test("editor wiring keeps explicit discard confirmations, history and reader controls", () => {
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  assert.match(page, /window\.confirm\("Reload from server and discard your unsaved local edits\?"\)/);
  assert.match(page, /window\.confirm\(\s*`Restore version/);
  assert.match(page, /restoreRevision\(\s*initial\.artifactId,\s*revision\.id,\s*controller\.state\.revisionId,?\s*\)/);
  assert.match(page, /editor\?\.setEditable\(!readOnly, false\)/);
  assert.match(page, /emitUpdate: false/);
  assert.match(page, /beforeunload/);
  assert.match(page, /Version \{revision\.revisionNumber\}/);
  assert.match(page, /dateTime=\{revision\.createdAt\}/);
  assert.match(page, /disabled=\{\s*busy \|\| readOnly/);
  const main = readFileSync(new URL("../apps/dashboard/src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /<EditorPage artifactId=/);
  for (const file of ["LibraryPage.tsx", "CommandPalette.tsx"]) {
    assert.match(
      readFileSync(new URL(`../apps/dashboard/src/${file}`, import.meta.url), "utf8"),
      /openArtifact\(artifact, window\.location\)/,
    );
  }
});

test("GFM markdown round-trips document structure, including tasks, tables, links, images and fenced code", () => {
  const text =
    "# Title\n\n## Subheading\n\n**bold** *emphasis* ~~gone~~ [link](https://example.com) `inline`\n\n- one\n  - nested\n\n1. first\n2. second\n\n- [x] done\n- [ ] pending\n\n> quotation\n\n```ts\nconst x = 1;\n```\n\n| Name | Value |\n| --- | --- |\n| a | b |\n\n![alt](https://example.com/image.png)\n\n---\n";
  const parsed = markdown.parse(text);
  const serialized = markdown.serialize(parsed);
  assert.deepEqual(markdown.parse(serialized), parsed);
  for (const type of [
    "heading",
    "bold",
    "italic",
    "strike",
    "link",
    "code",
    "bulletList",
    "orderedList",
    "taskList",
    "blockquote",
    "codeBlock",
    "table",
    "image",
    "horizontalRule",
  ]) {
    assert.ok(JSON.stringify(parsed).includes(`"type":"${type}"`), type);
  }
});

test("editing requests reuse same-origin JSON/Origin conventions and retain typed failures", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  const replies = [
    doc,
    { revisions: [{ id: "r1", revisionNumber: 1, sizeBytes: 3, createdAt: "2026-01-01T00:00:00Z" }] },
    { revisionId: "r2", revisionNumber: 2 },
    { revisionId: "r3", revisionNumber: 3 },
  ];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Response.json(replies.shift());
  }) as typeof fetch;
  try {
    assert.deepEqual(await getDocument("a"), { ok: true, value: doc });
    assert.equal((await listRevisions("a")).ok, true);
    assert.equal((await saveDocument("a", "next", "r1", 4)).ok, true);
    assert.equal((await restoreRevision("a", "r1", "r2")).ok, true);
    assert.deepEqual(
      calls.map((c) => [c.url, c.init.method]),
      [
        ["/api/artifacts/a/document", "GET"],
        ["/api/artifacts/a/revisions", "GET"],
        ["/api/artifacts/a/document", "PUT"],
        ["/api/artifacts/a/revisions/r1/restore", "POST"],
      ],
    );
    for (const c of calls) assert.equal(c.init.credentials, "same-origin");
    for (const c of calls.slice(2))
      assert.deepEqual(c.init.headers, {
        "content-type": "application/json",
        accept: "application/json",
        origin: "http://127.0.0.1:5173",
      });
    assert.deepEqual(JSON.parse(calls[2]!.init.body as string), {
      text: "next",
      expectedRevisionId: "r1",
      expectedSeq: 4,
    });
    assert.deepEqual(JSON.parse(calls[3]!.init.body as string), { expectedRevisionId: "r2" });
    for (const [status, error] of [
      [409, "concurrent_edit"],
      [413, "too_large"],
      [403, "forbidden"],
    ] as const) {
      globalThis.fetch = (async () => Response.json({ error }, { status })) as typeof fetch;
      const result = await saveDocument("a", "local", "r1", 4);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, error);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("library Open resolves markdown to the editor, HTML keeps its viewer, and failures do not enter an editor", async () => {
  const original = globalThis.fetch;
  try {
    for (const [body, status, expected] of [
      [doc, 200, "/edit/a"],
      [{ error: "wrong_kind" }, 409, "/artifact/a"],
      [{ error: "not_found" }, 404, "/artifact/a"],
    ] as const) {
      globalThis.fetch = (async () => Response.json(body, { status })) as typeof fetch;
      let href = "";
      await openArtifact(
        { id: "a", viewerHref: "/artifact/a" },
        {
          assign: (url) => {
            href = url;
          },
        },
      );
      assert.equal(href, expected);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("autosave sends the sequence it read and adopts the sequence the save reports", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: unknown[] = [];
  const session = new Autosave(
    doc,
    async (text, revision, expectedSeq) => {
      calls.push([text, revision, expectedSeq]);
      return ok("r2", 5);
    },
    () => {},
    () => {},
  );
  try {
    session.change("edited");
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.deepEqual(calls, [["edited", "r1", 4]], "the save carries the sequence that was read");
    assert.equal(session.state.seq, 5, "the save response advances the remembered sequence");
    session.change("edited again");
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.deepEqual(calls[1], ["edited again", "r2", 5], "the next save uses the adopted sequence and revision");
  } finally {
    session.dispose();
  }
});

test("a conflict keeps the sequence and the local text for the retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new Autosave(
    doc,
    async () => failure("concurrent_edit"),
    () => {},
    () => assert.fail("history must not refresh"),
  );
  try {
    session.change("local text");
    t.mock.timers.tick(AUTOSAVE_MS);
    await flush();
    assert.deepEqual(
      [session.state.status, session.state.text, session.state.seq, session.state.revisionId],
      ["conflict", "local text", 4, "r1"],
      "the conflict path keeps what the person wrote and the position they wrote against",
    );
  } finally {
    session.dispose();
  }
});

test("reload and remote replacement adopt the sequence of the document they read", () => {
  const session = new Autosave(
    doc,
    async () => ok(),
    () => {},
    () => {},
  );
  try {
    session.replace({ ...doc, text: "restored", revisionId: "r9", revisionNumber: 9, seq: 31, publishedSeq: 30 });
    assert.equal(session.state.seq, 31, "the read sequence replaces the old one");
  } finally {
    session.dispose();
  }
});

test("the page passes the read sequence to the save and the remote sequence to the replacement", () => {
  const page = readFileSync(new URL("../apps/dashboard/src/EditorPage.tsx", import.meta.url), "utf8");
  assert.match(
    page,
    /\(text, revision, expectedSeq\) => saveDocument\(initial\.artifactId, text, revision, expectedSeq\)/,
  );
  assert.match(page, /seq: remote\.seq/);
  assert.match(page, /seq: result\.value\.seq/);
});

test("the editor read and the save response carry the shared sequence and a read without it is refused", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json(doc)) as typeof fetch;
    assert.deepEqual(await getDocument("a"), { ok: true, value: doc }, "the read keeps its sequence");
    const { seq: _seq, publishedSeq: _publishedSeq, ...withoutSequence } = doc;
    globalThis.fetch = (async () => Response.json(withoutSequence)) as typeof fetch;
    assert.equal((await getDocument("a")).ok, false, "a document served without a sequence cannot be saved against");
    globalThis.fetch = (async () => Response.json({ revisionId: "r2", revisionNumber: 2, seq: 9 })) as typeof fetch;
    assert.deepEqual(await saveDocument("a", "next", "r1", 4), {
      ok: true,
      value: { revisionId: "r2", revisionNumber: 2, seq: 9 },
    });
  } finally {
    globalThis.fetch = original;
  }
});
