import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Icon, IconAction } from "@/components/ui/icon.tsx";
import { Logo } from "@/components/ui/logo.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { Menu, MenuItem } from "@/components/ui/menu.tsx";
import {
  commentDecorations,
  commentThreadAtPosition,
  selectionMenuVisible,
  sourceBlockSpan,
} from "@artiflow/domain/comment-anchors";
import type { CommentList } from "./comments-api.ts";
import { TextLink } from "@/components/ui/text-link.tsx";
import type { PollerVisibility } from "@artiflow/sdk/poll";
import {
  getArtifactDetail,
  getDocument,
  listRevisions,
  restoreRevision,
  saveDocument,
  type Document,
  type Revision,
} from "./editor-api.ts";
import {
  createEditorFreshness,
  loadRemoteText,
  metadataFromDetail,
  type EditorFreshness,
} from "./lib/editor-freshness.ts";
import { Autosave, type SaveState } from "./editor-autosave.ts";
import { blockTypes, currentBlockType, toolbarGroups, markdownExtensions } from "./editor-markdown.ts";
import MarkdownComments, { type CommentSelection } from "./components/comments/markdown-comments.tsx";
import { browserCommentStorage, readCommentsVisible, writeCommentsVisible } from "./comment-visibility.ts";

const labels = {
  saved: "Saved",
  saving: "Saving",
  unsaved: "Unsaved",
  conflict: "Conflict",
  readonly: "Read-only",
  error: "Unsaved",
  restoring: "Loading",
};
const markerKey = new PluginKey("commentMarkers");

const documentVisibility = (): PollerVisibility => ({
  hidden: () => document.hidden === true,
  subscribe: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
});

const requireMetadata = async (artifactId: string, kind: Document["kind"]) => {
  const result = await getArtifactDetail(artifactId);
  const metadata = result.ok ? metadataFromDetail(result.value, kind) : null;
  if (metadata === null) throw new Error("Artifact metadata is unavailable.");
  return metadata;
};

const readRemoteText = (artifactId: string, kind: Document["kind"]) =>
  loadRemoteText({
    document: async () => {
      const result = await getDocument(artifactId);
      return result.ok
        ? {
            text: result.value.text,
            revisionId: result.value.revisionId,
            revisionNumber: result.value.revisionNumber,
          }
        : null;
    },
    detail: () => requireMetadata(artifactId, kind).catch(() => null),
  }).then((remote) => {
    if (remote === null) throw new Error("The remote document could not be read.");
    return remote;
  });

export default function EditorPage({ artifactId }: { artifactId: string }) {
  const [document, setDocument] = useState<Document | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void getDocument(artifactId).then((result) => {
      if (cancelled) return;
      if (result.ok) setDocument(result.value);
      else if (result.signInRequired)
        window.location.replace("/login?return=" + encodeURIComponent(window.location.pathname));
      else
        setError(
          result.code === "wrong_kind"
            ? "HTML artifacts use the viewer, not the markdown editor."
            : result.code === "forbidden"
              ? "Read-only: this document is not available for editing."
              : "Could not load this document.",
        );
    });
    return () => {
      cancelled = true;
    };
  }, [artifactId]);
  return (
    <TooltipProvider>
      <div className="min-w-0 flex-1">
        {document ? (
          <DocumentEditor key={artifactId} initial={document} />
        ) : (
          <section className="p-7" aria-busy={!error}>
            <TextLink href="/library">Back to library</TextLink>
            <p role={error ? "alert" : "status"} className="mt-6">
              {error || "Loading document…"}
            </p>
            {error ? <TextLink href={`/artifact/${encodeURIComponent(artifactId)}`}>Open viewer</TextLink> : null}
          </section>
        )}
      </div>
    </TooltipProvider>
  );
}

function DocumentEditor({ initial }: { initial: Document }) {
  const session = useRef<Autosave | null>(null);
  const [state, setState] = useState<SaveState>({ ...initial, status: "saved", dirty: false });
  const [history, setHistory] = useState<Revision[]>([]);
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);
  const freshness = useRef<EditorFreshness | null>(null);
  const commentStorage = useRef(browserCommentStorage());
  const [commentsVisible, setCommentsVisible] = useState(() => readCommentsVisible(commentStorage.current));
  const [showResolved, setShowResolved] = useState(false);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [anchorTops, setAnchorTops] = useState<Record<string, number>>({});
  const canvasRef = useRef<HTMLDivElement>(null);
  const [comments, setComments] = useState<CommentList>({ canComment: false, comments: [] });
  const markers = useRef<{ source: string; data: CommentList }>({ source: initial.text, data: comments });
  markers.current = { source: state.text, data: comments };
  const dismissed = useRef(false);
  const [commentSelection, setCommentSelection] = useState<CommentSelection | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyRun = useRef(0);
  const refreshHistory = useCallback(() => {
    const run = ++historyRun.current;
    setHistoryLoading(true);
    void listRevisions(initial.artifactId).then((result) => {
      if (historyRun.current !== run) return;
      setHistoryLoading(false);
      setHistoryError(result.ok ? "" : "Could not load version history.");
      if (result.ok) setHistory(result.value);
    });
  }, [initial.artifactId]);
  const selectThread = (id: string) => {
    setActiveThread(id);
    setHistoryOpen(false);
  };
  const live = useRef({ visible: commentsVisible, showResolved, active: activeThread });
  live.current = { visible: commentsVisible, showResolved, active: activeThread };
  const resolvedIds = useRef(new Set<string>());
  resolvedIds.current = new Set(comments.comments.filter((thread) => thread.resolvedAt !== null).map((t) => t.id));
  const markerRanges = (editorState: EditorState) => {
    const runs: { text: string; from: number }[] = [];
    editorState.doc.descendants((node, from) => {
      if (node.isText) runs.push({ text: node.text!, from });
    });
    if (!live.current.visible) return [];
    const threads = markers.current.data.comments
      .filter((thread) => thread.anchor !== null)
      .filter((thread) => live.current.showResolved || thread.resolvedAt === null)
      .map((thread) => ({ id: thread.id, anchor: thread.anchor!, quotedText: thread.quotedText }));
    return commentDecorations(markers.current.source, threads, runs);
  };
  const editor = useEditor({
    extensions: [
      ...markdownExtensions,
      Extension.create({
        name: "commentMarkers",
        addProseMirrorPlugins: () => [
          new Plugin({
            key: markerKey,
            props: {
              decorations: (editorState) =>
                DecorationSet.create(
                  editorState.doc,
                  (commentsVisible ? markerRanges(editorState) : []).map((range) =>
                    Decoration.inline(range.from, range.to, {
                      class: [
                        range.className,
                        range.id === activeThread ? "comment-marker-active" : "",
                        resolvedIds.current.has(range.id) ? "comment-marker-resolved" : "",
                      ]
                        .filter(Boolean)
                        .join(" "),
                      "data-comment-id": range.id,
                      title: `${range.stale ? "Outdated comment" : "Comment"} — click or press Enter inside to open thread`,
                    }),
                  ),
                ),
              handleClick: (view, position, event) => {
                const ranges = markerRanges(view.state);
                let id = commentThreadAtPosition(position, ranges, markers.current.data.comments);
                if (!id && event.target instanceof Element && event.target.closest("[data-comment-id]"))
                  id = commentThreadAtPosition(position - 1, ranges, markers.current.data.comments);
                if (id) selectThread(id);
                return false;
              },
              handleKeyDown: (view, event) => {
                if (
                  event.key !== "Enter" ||
                  event.isComposing ||
                  event.shiftKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.altKey ||
                  !view.state.selection.empty
                )
                  return false;
                const id = commentThreadAtPosition(
                  view.state.selection.from,
                  markerRanges(view.state),
                  markers.current.data.comments,
                );
                if (!id) return false;
                selectThread(id);
                return true;
              },
            },
          }),
        ],
      }),
    ],
    content: initial.text,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "markdown-editor",
        "aria-label": "Document content",
        role: "textbox",
        "aria-multiline": "true",
      },
    },
    onUpdate: ({ editor }) => {
      session.current?.change(editor.getMarkdown());
    },
    onSelectionUpdate: () => {
      dismissed.current = false;
    },
  });
  const active = useEditorState({
    editor,
    selector: ({ editor }): ({ blockType: string } & Record<string, boolean | string>) | null =>
      editor
        ? {
            ...Object.fromEntries(
              toolbarGroups
                .flatMap((group) => group.entries)
                .map((entry) => [entry.command, entry.active?.(editor) ?? false]),
            ),
            blockType: currentBlockType(editor),
          }
        : null,
  });
  useEffect(() => {
    if (!editor) return;
    const controller = new Autosave(
      initial,
      (text, revision) => saveDocument(initial.artifactId, text, revision),
      setState,
      refreshHistory,
      editor.getMarkdown(),
    );
    session.current = controller;
    setState(controller.state);
    refreshHistory();
    return () => {
      controller.dispose();
      session.current = null;
      historyRun.current++;
    };
  }, [editor, initial, refreshHistory]);
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    let handle: EditorFreshness | null = null;
    void createEditorFreshness({
      artifactId: initial.artifactId,
      kind: initial.kind,
      initial: { revisionId: initial.revisionId, revisionNumber: initial.revisionNumber },
      readMetadata: (query) => requireMetadata(query.artifactId, initial.kind),
      readDocument: () => readRemoteText(initial.artifactId, initial.kind),
      isDirty: () => session.current?.state.dirty === true,
      writeRemote: (remote) => {
        const top = window.scrollY;
        editor.commands.setContent(remote.text, { contentType: "markdown", emitUpdate: false });
        session.current?.replace(
          {
            ...initial,
            revisionId: remote.metadata.revisionId,
            revisionNumber: remote.metadata.revisionNumber,
            text: remote.text,
          },
          editor.getMarkdown(),
        );
        requestAnimationFrame(() => window.scrollTo({ top }));
        refreshHistory();
      },
      onPending: (pending) => {
        if (!cancelled) setPendingVersion(pending?.revisionNumber ?? null);
      },
      visibility: documentVisibility(),
    })
      .then((created) => {
        if (cancelled) {
          created.stop();
          return;
        }
        handle = created;
        freshness.current = created;
        created.start();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      handle?.stop();
      freshness.current = null;
    };
  }, [editor, initial, refreshHistory]);
  const adoptApplied = async () => {
    const current = freshness.current;
    if (!current) return;
    try {
      current.adopt(await requireMetadata(initial.artifactId, initial.kind));
    } catch {}
  };
  const busy = state.status === "saving" || state.status === "restoring";
  const readOnly =
    state.status === "readonly" ||
    state.status === "conflict" ||
    state.status === "restoring" ||
    state.code === "reload_required";
  useEffect(() => {
    editor?.setEditable(!readOnly, false);
  }, [editor, readOnly]);
  useEffect(() => {
    if (readOnly) editor?.commands.setMeta("bubbleMenu", "hide");
  }, [editor, readOnly]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!session.current?.state.dirty && session.current?.state.status !== "restoring") return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const reload = async () => {
    const controller = session.current;
    if (!controller || busy) return;
    if (controller.state.dirty && !window.confirm("Reload from server and discard your unsaved local edits?")) return;
    if (!controller.beginReload()) return;
    const result = await getDocument(initial.artifactId);
    if (session.current !== controller) return;
    if (!result.ok) {
      controller.reject(result.code);
      return;
    }
    editor?.commands.setContent(result.value.text, { contentType: "markdown", emitUpdate: false });
    controller.replace(result.value, editor?.getMarkdown());
    refreshHistory();
    void adoptApplied();
  };
  const restore = async (revision: Revision) => {
    const controller = session.current;
    if (
      !controller ||
      !window.confirm(
        `Restore version ${revision.revisionNumber} as a new version?${controller.state.dirty ? " This discards your unsaved local edits." : ""}`,
      ) ||
      !controller.beginRestore()
    )
      return;
    const result = await restoreRevision(initial.artifactId, revision.id, controller.state.revisionId);
    if (session.current !== controller) return;
    if (!result.ok) {
      controller.reject(result.code);
      return;
    }
    const document = await getDocument(initial.artifactId);
    if (session.current !== controller) return;
    if (!document.ok) {
      controller.reject("reload_required");
      refreshHistory();
      return;
    }
    editor?.commands.setContent(document.value.text, { contentType: "markdown", emitUpdate: false });
    controller.replace(document.value, editor?.getMarkdown());
    refreshHistory();
    void adoptApplied();
  };
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(markerKey, true));
  }, [editor, comments, state.text, commentsVisible, showResolved, activeThread]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismissed.current = true;
        editor?.commands.setMeta("bubbleMenu", "hide");
      }
    };
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(".selection-bubble, .markdown-editor, .editor-formatting")) return;
      dismissed.current = true;
      editor?.commands.setMeta("bubbleMenu", "hide");
    };
    window.addEventListener("keydown", close);
    window.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("pointerdown", outside);
    };
  }, [editor]);
  const markAnchor = (id: string) => {
    const nodes = editor?.view.dom.querySelectorAll<HTMLElement>("[data-comment-id]");
    const matches = Array.from(nodes ?? []).filter((node) => node.dataset.commentId === id);
    const first = matches[0];
    if (first) {
      const box = first.getBoundingClientRect();
      if (box.top < 0 || box.bottom > window.innerHeight)
        first.scrollIntoView({
          block: "center",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
        });
    }
    matches.forEach((node) => {
      node.classList.remove("comment-marker-flash");
      void node.offsetWidth;
      node.classList.add("comment-marker-flash");
    });
  };
  const measureAnchors = useCallback(() => {
    const view = editor?.view;
    const canvas = canvasRef.current;
    if (!view || !canvas || editor?.isDestroyed) return;
    const shelf = canvas.parentElement?.querySelector<HTMLElement>(".comment-thread-margin");
    const base = (shelf ?? canvas).getBoundingClientRect().top + window.scrollY;
    const next: Record<string, number> = {};
    for (const range of markerRanges(view.state)) {
      const top = Math.max(0, view.coordsAtPos(range.from).top + window.scrollY - base);
      next[range.id] = next[range.id] === undefined ? top : Math.min(next[range.id]!, top);
    }
    setAnchorTops((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
  }, [editor]);
  useEffect(() => {
    measureAnchors();
  }, [measureAnchors, comments, state.text, commentsVisible, showResolved]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const frame = () => window.requestAnimationFrame(measureAnchors);
    const observer = new ResizeObserver(frame);
    observer.observe(canvas);
    canvas.addEventListener("scroll", frame);
    window.addEventListener("resize", frame);
    window.addEventListener("scroll", frame, true);
    void document.fonts?.ready.then(frame);
    return () => {
      observer.disconnect();
      canvas.removeEventListener("scroll", frame);
      window.removeEventListener("resize", frame);
      window.removeEventListener("scroll", frame, true);
    };
  }, [measureAnchors]);
  const blocked = readOnly || !editor;
  return (
    <section aria-labelledby="editor-title" className="document-editor">
      <header className="editor-topbar">
        <a className="editor-topbar-back" href="/library" aria-label="Back to library">
          <Icon name="left" />
        </a>
        <div className="editor-topbar-brand">
          <Logo withWordmark={false} aria-hidden="true" />
          <span>artiflow</span>
        </div>
        <div className="editor-topbar-title">
          <h1 id="editor-title">{initial.title}</h1>
          <span className="editor-topbar-version">v{state.revisionNumber}</span>
        </div>
        <span role="status" aria-live="polite" className="editor-save-state" data-state={state.status}>
          <span aria-hidden="true">•</span>
          {labels[state.status]}
        </span>
        <nav aria-label="Document actions" className="editor-topbar-actions">
          <IconAction
            icon="history"
            label="Version history"
            aria-expanded={historyOpen}
            aria-controls="version-history"
            onClick={() => {
              setHistoryOpen(!historyOpen);
            }}
          />
          <IconAction
            icon="chat"
            label="Comments"
            aria-expanded={commentsVisible}
            aria-controls="document-comments"
            onClick={() => {
              const next = !commentsVisible;
              setCommentsVisible(next);
              writeCommentsVisible(commentStorage.current, next);
              if (!next) setActiveThread(null);
            }}
          />
        </nav>
      </header>
      <div role="toolbar" aria-label="Document formatting" className="editor-formatting">
        {toolbarGroups.map((group) => (
          <div role="group" aria-label={group.label} className="editor-formatting-group" key={group.label}>
            {group.entries.map((entry) =>
              entry.command === "blockType" ? (
                <Tooltip key={entry.command} disableHoverableContent>
                  <Menu
                    label="Block type"
                    trigger={
                      <TooltipTrigger asChild>
                        <button type="button" className="editor-block-type" aria-label="Block type" disabled={blocked}>
                          <span>{active?.blockType ?? "Paragraph"}</span>
                          <Icon name="chev" />
                        </button>
                      </TooltipTrigger>
                    }
                  >
                    {blockTypes.map((block) => (
                      <MenuItem
                        key={block.label}
                        icon={block.icon}
                        checked={active?.blockType === block.label}
                        disabled={blocked}
                        onClick={() => {
                          if (editor && !readOnly) block.run(editor.chain().focus(), "").run();
                        }}
                      >
                        {block.label}
                      </MenuItem>
                    ))}
                  </Menu>
                  <TooltipContent>Block type</TooltipContent>
                </Tooltip>
              ) : (
                <IconAction
                  key={entry.command}
                  icon={entry.icon}
                  label={entry.label}
                  disabled={blocked}
                  aria-pressed={entry.active ? !!active?.[entry.command] : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (!editor || readOnly) return;
                    let url = "";
                    if (entry.command === "setLink" || entry.command === "setImage") {
                      const value = window.prompt(
                        entry.command === "setLink" ? "Link URL (empty to remove)" : "Image URL",
                        entry.command === "setLink" ? (editor.getAttributes("link").href ?? "https://") : "https://",
                      );
                      if (value === null) return;
                      url = value;
                      if (entry.command === "setImage" && !url.trim()) return;
                    }
                    if (entry.command === "setLink" && url === "") editor.chain().focus().unsetLink().run();
                    else entry.run(editor.chain().focus(), url).run();
                  }}
                />
              ),
            )}
          </div>
        ))}
        {active?.insertTable ? (
          <div role="group" aria-label="Table actions" className="editor-formatting-group">
            <IconAction
              icon="plus"
              label="Add row"
              disabled={blocked}
              onClick={() => editor?.chain().focus().addRowAfter().run()}
            />
            <IconAction
              icon="plus"
              label="Add column"
              disabled={blocked}
              onClick={() => editor?.chain().focus().addColumnAfter().run()}
            />
            <IconAction
              icon="trash"
              label="Delete row"
              disabled={blocked}
              onClick={() => editor?.chain().focus().deleteRow().run()}
            />
            <IconAction
              icon="trash"
              label="Delete column"
              disabled={blocked}
              onClick={() => editor?.chain().focus().deleteColumn().run()}
            />
            <IconAction
              icon="trash"
              label="Delete table"
              disabled={blocked}
              onClick={() => editor?.chain().focus().deleteTable().run()}
            />
          </div>
        ) : null}
      </div>
      {state.status === "conflict" ? (
        <div role="alert" className="editor-notice">
          <p>
            Someone saved a newer version. Your local edits are kept here. Copy them before reloading; neither version
            will be overwritten.
          </p>
          <IconAction
            icon="refresh"
            label="Reload from server (discard local edits)"
            onClick={() => {
              void reload();
            }}
          />
        </div>
      ) : null}
      {pendingVersion !== null ? (
        <div role="status" className="editor-notice">
          <p>
            Version {pendingVersion} is available on the server. Your unsaved edits are kept here; loading that version
            would discard them.{" "}
            <TextLink
              onClick={() => {
                void freshness.current?.resolve("accept-remote");
              }}
            >
              Load version {pendingVersion}
            </TextLink>
          </p>
        </div>
      ) : null}
      {state.status === "readonly" ? (
        <div role="status" className="editor-notice">
          Read-only: you do not have editing permission. Autosave is stopped.{" "}
          {state.dirty ? "Your unsaved local edits remain here; copy them before leaving." : ""} You can still view
          version history.
        </div>
      ) : null}
      {state.status === "error" ? (
        <div role="alert" className="border-b border-line p-4">
          <p>
            {state.code === "too_large"
              ? "This document is too large to save (maximum 16 MiB). Shorten it, then retry."
              : state.code === "reload_required"
                ? "Restore succeeded, but the document could not be reloaded. Reload before editing again."
                : "The save was not confirmed. Your local edits remain here. Retry, or reload to check the server version."}
          </p>
          {state.code !== "reload_required" ? (
            <IconAction icon="refresh" label="Retry save" onClick={() => session.current?.retry()} />
          ) : null}
          <IconAction
            icon="down"
            label="Reload from server"
            onClick={() => {
              void reload();
            }}
          />
        </div>
      ) : null}
      <div
        className={`editor-workspace ${historyOpen ? "editor-panel-open" : ""} ${commentsVisible ? "editor-margin-open" : ""}`}
      >
        <div className="editor-canvas" ref={canvasRef}>
          {editor ? (
            <BubbleMenu
              editor={editor}
              shouldShow={({ from, to, view, state }) =>
                selectionMenuVisible(
                  editor.isEditable && !readOnly && view.hasFocus() && !!state.doc.textBetween(from, to).trim(),
                  from,
                  to,
                  dismissed.current,
                )
              }
              options={{ placement: "top", offset: 10 }}
            >
              <div
                role="toolbar"
                aria-label="Selection actions"
                className="selection-bubble"
                onMouseDown={(event) => event.preventDefault()}
              >
                <IconAction
                  icon="bold"
                  label="Bold"
                  aria-pressed={!!active?.toggleBold}
                  onClick={() => editor.chain().focus().toggleBold().run()}
                />
                <IconAction
                  icon="italic"
                  label="Italic"
                  aria-pressed={!!active?.toggleItalic}
                  onClick={() => editor.chain().focus().toggleItalic().run()}
                />
                <IconAction
                  icon="strike"
                  label="Strikethrough"
                  aria-pressed={!!active?.toggleStrike}
                  onClick={() => editor.chain().focus().toggleStrike().run()}
                />
                <IconAction
                  icon="code"
                  label="Inline code"
                  aria-pressed={!!active?.toggleCode}
                  onClick={() => editor.chain().focus().toggleCode().run()}
                />
                {comments.canComment ? (
                  <IconAction
                    icon="chat"
                    label="Comment"
                    onClick={() => {
                      const { from, to } = editor.state.selection;
                      const position = editor.view.coordsAtPos(to);
                      const startBlock = editor.state.doc.resolve(from).index(0);
                      const endBlock = editor.state.doc.resolve(Math.max(from, to - 1)).index(0);
                      const span = sourceBlockSpan(state.text, startBlock, endBlock);
                      setCommentSelection((previous) => ({
                        text: editor.state.doc.textBetween(from, to, "\n"),
                        span,
                        serial: (previous?.serial ?? 0) + 1,
                        top: Math.max(0, position.top - (canvasRef.current?.getBoundingClientRect().top ?? 0) - 8),
                      }));
                      dismissed.current = true;
                      editor.commands.setMeta("bubbleMenu", "hide");
                    }}
                  />
                ) : null}
              </div>
            </BubbleMenu>
          ) : null}
          <EditorContent editor={editor} />
        </div>
        {historyOpen ? (
          <aside
            id="version-history"
            aria-label="Version history"
            aria-busy={historyLoading}
            className="editor-side-panel"
          >
            <h2 className="caps mb-4">Version history</h2>
            <p className="mb-4 text-xs text-fg-muted">
              Restoring creates a new version. Previous versions stay in history.
            </p>
            {historyError ? (
              <div role="alert">
                <p>{historyError}</p>
                <IconAction icon="refresh" label="Retry history" onClick={refreshHistory} />
              </div>
            ) : null}
            {historyLoading ? <p role="status">Loading history…</p> : null}
            <ol className="space-y-4">
              {history.map((revision) => (
                <li key={revision.id} className="border-t border-line pt-3">
                  <p className="font-mono text-xs">
                    Version {revision.revisionNumber}
                    {revision.id === state.revisionId ? " · current" : ""}
                  </p>
                  <time dateTime={revision.createdAt} className="mt-1 block text-xs text-fg-muted">
                    {new Date(revision.createdAt).toLocaleString()}
                  </time>
                  <IconAction
                    icon="history"
                    label={`Restore version ${revision.revisionNumber}`}
                    disabled={busy || readOnly || state.code === "reload_required" || revision.id === state.revisionId}
                    onClick={() => {
                      void restore(revision);
                    }}
                  />
                </li>
              ))}
            </ol>
          </aside>
        ) : null}
        {commentsVisible ? (
          <div className="editor-comments-column">
            <MarkdownComments
              artifactId={initial.artifactId}
              source={state.text}
              revisionId={state.revisionId}
              saved={!state.dirty && state.status !== "restoring" && state.status !== "conflict"}
              selection={commentSelection}
              readOnly={readOnly}
              visible={commentsVisible}
              onVisibleChange={(next) => {
                setCommentsVisible(next);
                if (!next) setActiveThread(null);
              }}
              showResolved={showResolved}
              onShowResolvedChange={setShowResolved}
              anchorTops={anchorTops}
              activeId={activeThread}
              onActivate={setActiveThread}
              onData={setComments}
              onFocusAnchor={markAnchor}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
