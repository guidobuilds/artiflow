import { useCallback, useEffect, useRef, useState } from "react";

import {
  anchorIsStale,
  mapRenderedSelection,
  renderedQuote,
  type CommentAnchor,
  type RenderedCandidate,
  type SourceSpan,
} from "@artiflow/domain/comment-anchors";
import type { ManageResult } from "@/auth-client.ts";
import { useSessionUser } from "@/query/session.ts";
import { draftBlockedReason } from "@/comment-draft.ts";
import {
  createComment as createCommentRequest,
  deleteComment as deleteCommentRequest,
  listComments,
  resolveComment,
  type CommentEntry,
  type CommentList,
  type CommentThread,
} from "@/comments-api.ts";
import CommentThreadMargin, {
  type CommentDraft,
  type CommentThread as MarginThread,
  type ThreadReply,
} from "./comment-thread-margin.tsx";

export type CommentSelection = { text: string; span: SourceSpan; serial: number; top: number };

export type MarkdownCommentsProps = {
  artifactId: string;
  source: string;
  revisionId: string;
  saved: boolean;
  selection: CommentSelection | null;
  readOnly: boolean;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  showResolved: boolean;
  onShowResolvedChange: (show: boolean) => void;
  anchorTops: Record<string, number>;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  onData: (data: CommentList) => void;
  onFocusAnchor: (id: string) => void;
};

type Draft = {
  id: number;
  source: string;
  anchor: CommentAnchor | null;
  quotedText: string;
  candidates: RenderedCandidate[];
  body: string;
  anchorTop: number;
};

const message = (code: string): string =>
  code === "forbidden"
    ? "Read-only: the server refused this comment action."
    : code === "anchor_mismatch" || code === "invalid_anchor" || code === "unsupported_anchor_kind"
      ? "The source changed. Select the text again; your comment is kept here."
      : code === "too_large"
        ? "Use at most 4,000 characters in a comment and 2,000 in a quote."
        : "Could not confirm this comment action. Refresh comments to check before retrying.";

const threadAuthor = (entry: CommentEntry) => entry.author;

const toReply = (entry: CommentEntry): ThreadReply => ({
  id: entry.id,
  author: threadAuthor(entry),
  body: entry.body,
  createdAt: entry.createdAt,
  canDelete: entry.canDelete,
});

const toMarginThread = (thread: CommentThread, source: string, staleLabel: string): MarginThread => ({
  id: thread.id,
  author: threadAuthor(thread),
  quotedText: thread.quotedText,
  body: thread.body,
  createdAt: thread.createdAt,
  resolvedAt: thread.resolvedAt,
  canDelete: thread.canDelete,
  replies: thread.replies.map(toReply),
  stale: thread.anchor === null ? false : anchorIsStale(source, thread.anchor, thread.quotedText),
  staleLabel,
});

export default function MarkdownComments({
  artifactId,
  source,
  revisionId,
  saved,
  selection,
  readOnly,
  visible,
  onVisibleChange,
  showResolved,
  onShowResolvedChange,
  anchorTops,
  activeId,
  onActivate,
  onData,
  onFocusAnchor,
}: MarkdownCommentsProps) {
  const [data, setData] = useState<CommentList | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const authorImage = useSessionUser()?.image ?? null;
  const run = useRef(0);
  const nextDraft = useRef(0);
  const dataCallback = useRef(onData);
  dataCallback.current = onData;
  const announcedSelection = useRef<number | null>(null);
  const activateCallback = useRef(onActivate);
  activateCallback.current = onActivate;
  const refresh = useCallback(async () => {
    const current = ++run.current;
    setStatus((value) => (value === "ready" || value === "empty" ? value : "loading"));
    const result = await listComments(artifactId);
    if (run.current !== current) return;
    if (result.ok) {
      setData(result.value);
      setStatus(result.value.comments.length === 0 ? "empty" : "ready");
      setError("");
      dataCallback.current(result.value);
    } else {
      setData(null);
      setStatus("error");
      dataCallback.current({ canComment: false, comments: [] });
    }
  }, [artifactId]);
  useEffect(() => {
    void refresh();
    return () => {
      run.current++;
    };
  }, [refresh, revisionId]);
  const canComment = data?.canComment === true && !readOnly;
  const begin = useCallback(
    (text: string, span: SourceSpan, anchorTop: number) => {
      const mapped = mapRenderedSelection(source, text, span);
      setDraft({
        id: ++nextDraft.current,
        source,
        anchor: mapped.anchor,
        quotedText: mapped.quotedText,
        candidates: mapped.candidates,
        body: "",
        anchorTop,
      });
      setError("");
    },
    [source],
  );
  useEffect(() => {
    if (selection === null || !canComment) return;
    begin(selection.text, selection.span, selection.top);
    if (announcedSelection.current !== selection.serial) {
      announcedSelection.current = selection.serial;
      activateCallback.current(null);
    }
  }, [selection, canComment, begin]);
  useEffect(() => {
    if (readOnly || data?.canComment === false) setDraft(null);
  }, [readOnly, data?.canComment]);
  const outdatedDraft = draft !== null && draft.source !== source;
  const quote = draft !== null && draft.anchor !== null ? renderedQuote(draft.quotedText) : null;
  const mutate = async (action: () => Promise<ManageResult<string>>, clearDraft = false) => {
    if (busy) return;
    setBusy(true);
    const result = await action();
    if (result.ok) {
      if (clearDraft) setDraft(null);
      await refresh();
    } else {
      setError(message(result.code));
      await refresh();
    }
    setBusy(false);
  };
  const threads = (data?.comments ?? []).map((thread) => toMarginThread(thread, source, "Text changed"));
  const blockedReason = draftBlockedReason(draft);
  const draftModel: CommentDraft | null =
    draft === null
      ? null
      : {
          quotedText: draft.quotedText,
          body: draft.body,
          busy,
          authorImage,
          error: error || (outdatedDraft ? "The document changed; select the text again." : "") || blockedReason || "",
        };
  const submitDraft = (body: string) => {
    if (draft === null) return;
    if (blockedReason !== null) {
      setError(blockedReason);
      return;
    }
    if (!saved) {
      setError("Wait for the document to save before commenting.");
      return;
    }
    if (quote === null || quote.length > 2000) return;
    void mutate(
      () =>
        createCommentRequest(artifactId, {
          anchor: { ...draft.anchor!, kind: "text-range", quotedText: quote },
          body,
        }),
      true,
    );
  };
  return (
    <CommentThreadMargin
      threads={threads}
      anchors={anchorTops}
      activeId={activeId}
      onActivate={(id) => {
        onActivate(id);
        if (id !== null) onFocusAnchor(id);
      }}
      onResolve={(thread, resolved) => {
        void mutate(() => resolveComment(artifactId, thread.id, resolved));
      }}
      onReply={(thread, body) => {
        if (!saved) {
          setError("Wait for the document to save before replying.");
          return;
        }
        void mutate(() => createCommentRequest(artifactId, { body, parentId: thread.id }));
      }}
      onDelete={(thread, reply) => {
        const target = reply ?? thread;
        if (!window.confirm(reply ? "Delete this reply?" : "Delete this comment and all its replies?")) return;
        void mutate(() => deleteCommentRequest(artifactId, target.id));
      }}
      onRetry={() => {
        void refresh();
      }}
      status={error && status !== "ready" ? "error" : status}
      canComment={canComment}
      draft={draftModel}
      draftAnchorTop={draft?.anchorTop ?? 0}
      onSubmitDraft={submitDraft}
      onCancelDraft={() => setDraft(null)}
      publishError={error || null}
      visible={visible}
      onVisibleChange={onVisibleChange}
      showResolved={showResolved}
      onShowResolvedChange={onShowResolvedChange}
      heights={{}}
    />
  );
}
