import { useCallback, useEffect, useRef, useState } from "react";
import { IconAction } from "@/components/ui/icon.tsx";
import {
  anchorIsStale,
  anchorText,
  mapRenderedSelection,
  renderedQuote,
  composerTransition,
  compareCommentThreads,
  type CommentAnchor,
  type SourceSpan,
  type RenderedCandidate,
} from "@artiflow/domain/comment-anchors";
import {
  createComment,
  deleteComment,
  listComments,
  resolveComment,
  type CommentEntry,
  type CommentList,
} from "./comments-api.ts";
import type { ManageResult } from "./auth-client.ts";

export type CommentSelection = { text: string; span: SourceSpan; serial: number; left: number; top: number };
type Draft = {
  id: number;
  source: string;
  anchor: CommentAnchor | null;
  quotedText: string;
  candidates: RenderedCandidate[];
  parentId?: string;
  body: string;
};
const message = (code: string) =>
  code === "forbidden"
    ? "Read-only: the server refused this comment action."
    : code === "anchor_mismatch" || code === "invalid_anchor"
      ? "The source changed. Refresh the document and select the text again; your comment is kept here."
      : code === "too_large"
        ? "Use at most 4,000 characters in a comment and 2,000 in a quote."
        : "Could not confirm this comment action. Refresh threads to check before retrying.";

export default function CommentSidebar({
  artifactId,
  source,
  revisionId,
  saved,
  selection,
  open,
  selectedThread,
  readOnly,
  onData,
  onFocus,
}: {
  artifactId: string;
  source: string;
  revisionId: string;
  saved: boolean;
  selection: CommentSelection | null;
  open: boolean;
  selectedThread: { id: string; serial: number } | null;
  readOnly: boolean;
  onData: (data: CommentList) => void;
  onFocus: (id: string) => void;
}) {
  const [data, setData] = useState<CommentList | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open || !selectedThread) return;
    const row = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[data-thread-id]") ?? []).find(
      (node) => node.dataset.threadId === selectedThread.id,
    );
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView({
      block: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
    row.classList.remove("comment-marker-flash");
    void row.offsetWidth;
    row.classList.add("comment-marker-flash");
  }, [open, selectedThread, data]);
  const [denied, setDenied] = useState(false);
  const deniedRef = useRef(false);
  const dataCallback = useRef(onData);
  dataCallback.current = onData;
  const run = useRef(0);
  const nextDraft = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++run.current;
    setLoading(true);
    const result = await listComments(artifactId);
    if (run.current !== current) return;
    setLoading(false);
    if (result.ok) {
      setData(result.value);
      dataCallback.current({ ...result.value, canComment: result.value.canComment && !deniedRef.current });
      setError("");
    } else {
      setData(null);
      dataCallback.current({ canComment: false, comments: [] });
      setError("Could not load comments. Refresh threads to retry.");
    }
  }, [artifactId]);
  useEffect(() => {
    void refresh();
    return () => {
      run.current++;
    };
  }, [refresh, revisionId]);
  const begin = useCallback(
    (text: string, span: SourceSpan, parentId?: string, anchor?: CommentAnchor) => {
      const mapped = anchor
        ? { anchor, quotedText: renderedQuote(text), candidates: [] }
        : mapRenderedSelection(source, text, span);
      setDraft({
        id: ++nextDraft.current,
        source,
        anchor: mapped.anchor,
        quotedText: mapped.quotedText,
        candidates: mapped.candidates,
        body: "",
        ...(parentId ? { parentId } : {}),
      });
      setError("");
    },
    [source],
  );
  useEffect(() => {
    if (selection && composerTransition(false, "open", !readOnly && !denied && data?.canComment === true))
      begin(selection.text, selection.span);
  }, [selection]);
  useEffect(() => {
    if (readOnly || denied || data?.canComment === false) setDraft(null);
  }, [readOnly, denied, data?.canComment]);
  useEffect(() => {
    if (!draft) return;
    bodyInput.current?.focus();
  }, [draft?.id]);
  const mutate = async (action: () => Promise<ManageResult<string>>, clearDraft = false) => {
    if (busy) return;
    setBusy(true);
    const result = await action();
    if (result.ok) {
      if (clearDraft && !composerTransition(true, "sent", true)) setDraft(null);
      await refresh();
    } else {
      if (result.code === "forbidden") {
        if (clearDraft) {
          deniedRef.current = true;
          setDenied(true);
          setDraft(null);
        }
        await refresh();
        if (clearDraft) dataCallback.current({ canComment: false, comments: data?.comments ?? [] });
      }
      setError(message(result.code));
    }
    setBusy(false);
  };
  const canComment = data?.canComment === true && !readOnly && !denied;
  const anchor = draft?.anchor ?? null;
  const quote = draft && anchor ? anchorText(draft.source, anchor) : null;
  const outdatedDraft = draft !== null && draft.source !== source;
  const remove = (row: CommentEntry, root = false) => {
    if (!window.confirm(root ? "Delete this comment and all its replies?" : "Delete this reply?")) return;
    void mutate(() => deleteComment(artifactId, row.id));
  };
  const content = (row: CommentEntry, root = false) => (
    <>
      <p className="break-all text-xs text-fg-muted">{row.author.email}</p>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{row.body}</p>
      <time dateTime={row.createdAt} className="mt-2 block text-xs text-fg-muted">
        {new Date(row.createdAt).toLocaleString()}
      </time>
      {row.canDelete ? (
        <IconAction
          icon="trash"
          label={root ? "Delete thread" : "Delete reply"}
          disabled={busy}
          onClick={() => remove(row, root)}
        />
      ) : null}
    </>
  );
  return (
    <>
      {draft && canComment ? (
        <form
          aria-label={draft.parentId ? "Reply to thread" : "Comment on selection"}
          className="comment-composer"
          style={{
            left: Math.max(12, Math.min(selection?.left ?? 80, window.innerWidth - 332)),
            top: Math.max(12, Math.min(selection?.top ?? 100, window.innerHeight - 300)),
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              if (!composerTransition(true, "cancel", canComment)) setDraft(null);
            }
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.target === bodyInput.current
            ) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !draft.body.trim() || draft.body.length > 4000 || outdatedDraft || !saved) return;
            if (!draft.parentId && (!anchor || !quote || quote.length > 2000)) return;
            void mutate(
              () =>
                createComment(
                  artifactId,
                  draft.parentId
                    ? { body: draft.body, parentId: draft.parentId }
                    : {
                        anchor: { ...anchor!, kind: "text-range", quotedText: quote! },
                        body: draft.body,
                      },
                ),
              true,
            );
          }}
        >
          <h3 className="text-sm font-medium">{draft.parentId ? "Reply to thread" : "Comment on selection"}</h3>
          <blockquote className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-xs">
            {draft.quotedText}
          </blockquote>
          {draft.candidates.length ? (
            <fieldset className="max-h-40 overflow-auto text-xs">
              <legend>Which occurrence?</legend>
              {draft.candidates.map((candidate, index) => (
                <label key={index} className="flex gap-2 py-1">
                  <input
                    type="radio"
                    name="occurrence"
                    checked={draft.anchor === candidate.anchor}
                    onChange={() => setDraft({ ...draft, anchor: candidate.anchor })}
                  />
                  <span>
                    {index + 1}. {candidate.snippet}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {outdatedDraft ? (
            <p role="status" className="text-xs">
              Local source changed. Reopen the selection to use the current text. Your body is kept until you cancel.
            </p>
          ) : null}
          {!saved ? (
            <p role="status" className="text-xs">
              Wait for document autosave before posting comments. Comments do not trigger saves.
            </p>
          ) : null}
          <label className="block text-xs">
            {draft.parentId ? "Reply" : "Comment"}
            <textarea
              ref={bodyInput}
              aria-label="Comment body"
              required
              maxLength={4000}
              value={draft.body}
              rows={3}
              className="mt-1 w-full border border-line p-2 text-sm"
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
          </label>
          {error ? (
            <p role="alert" className="text-xs">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-1">
            <IconAction icon="x" label="Cancel comment" disabled={busy} onClick={() => setDraft(null)} />
            <IconAction
              icon="send"
              label={draft.parentId ? "Post reply" : "Post comment"}
              type="submit"
              disabled={
                busy ||
                !saved ||
                outdatedDraft ||
                (!draft.parentId && (!anchor || !quote || quote.length > 2000)) ||
                !draft.body.trim()
              }
            />
          </div>
        </form>
      ) : null}
      <aside
        ref={panelRef}
        id="document-comments"
        hidden={!open}
        aria-label="Document comments"
        aria-busy={loading || busy}
        className="editor-side-panel"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm">Comments</h2>
          <IconAction
            icon="refresh"
            label="Refresh threads"
            disabled={busy || loading}
            onClick={() => {
              void refresh();
            }}
          />
        </div>
        {data && !canComment ? (
          <p role="status" className="mb-3 text-sm">
            Comments are read-only.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="my-3 text-sm">
            {error}
          </p>
        ) : null}
        {canComment ? (
          <p className="my-3 text-xs text-fg-muted">
            Select text in the document and choose Comment to start a thread.
          </p>
        ) : null}
        {loading && !data ? (
          <p role="status" className="my-4 text-sm">
            Loading comments…
          </p>
        ) : null}
        {data?.comments.length === 0 ? (
          <p className="my-4 text-sm text-fg-muted">No comments yet. Select text in the document to start a thread.</p>
        ) : null}
        <ol className="mt-4 space-y-4">
          {[...(data?.comments ?? [])].sort(compareCommentThreads).map((thread) => {
            const stale = anchorIsStale(source, thread.anchor, thread.quotedText);
            return (
              <li
                key={thread.id}
                data-thread-id={thread.id}
                tabIndex={-1}
                className="rounded-md border border-line p-3"
              >
                <details open={!thread.resolvedAt}>
                  <summary onClick={() => onFocus(thread.id)} className="cursor-pointer text-xs font-medium">
                    Line {thread.anchor.startLine}:{thread.anchor.startCol} · {thread.resolvedAt ? "Resolved" : "Open"}{" "}
                    · {thread.replies.length} {thread.replies.length === 1 ? "reply" : "replies"}
                    {stale ? " · Outdated" : ""}
                  </summary>
                  {stale ? <p className="mt-2 text-xs font-medium">Text changed since this comment.</p> : null}
                  <blockquote className="my-3 max-h-40 overflow-auto whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-xs">
                    {renderedQuote(thread.quotedText)}
                  </blockquote>
                  {content(thread, true)}
                  <ol className="mt-3 space-y-3 border-l border-line pl-3">
                    {thread.replies.map((reply) => (
                      <li key={reply.id}>{content(reply)}</li>
                    ))}
                  </ol>
                  {canComment ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <IconAction
                        icon="chat"
                        label="Reply"
                        disabled={busy}
                        onClick={() =>
                          begin(thread.quotedText, { start: 0, end: source.length }, thread.id, thread.anchor)
                        }
                      />
                      <IconAction
                        icon="check"
                        label={thread.resolvedAt ? "Unresolve" : "Resolve"}
                        disabled={busy}
                        onClick={() => {
                          void mutate(() => resolveComment(artifactId, thread.id, !thread.resolvedAt));
                        }}
                      />
                    </div>
                  ) : null}
                </details>
              </li>
            );
          })}
        </ol>
      </aside>
    </>
  );
}
