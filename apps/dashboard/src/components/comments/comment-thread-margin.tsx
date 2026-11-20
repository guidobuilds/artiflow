import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { Avatar } from "@/components/ui/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconAction } from "@/components/ui/icon.tsx";
import {
  layoutCommentThreads,
  marginHeight,
  partitionPlaced,
  placementOf,
  type ThreadPlacement,
} from "@/comment-thread-layout.ts";
import {
  browserCommentStorage,
  openThreadCount,
  readCommentsVisible,
  visibleThreads,
  writeCommentsVisible,
} from "@/comment-visibility.ts";

export type CommentAuthor = { id: string; name: string; image: string | null };

export type ThreadReply = {
  id: string;
  author: CommentAuthor;
  body: string;
  createdAt: string;
  canDelete: boolean;
};

export type CommentThread = {
  id: string;
  author: CommentAuthor;
  quotedText: string;
  body: string;
  createdAt: string;
  resolvedAt: string | null;
  canDelete: boolean;
  replies: ThreadReply[];
  stale?: boolean;
  staleLabel?: string;
};

export type CommentThreadsStatus = "loading" | "ready" | "empty" | "error";

export type CommentDraft = {
  quotedText: string;
  body: string;
  busy?: boolean;
  error?: string | null;
};

export type CommentThreadMarginProps = {
  threads: CommentThread[];
  anchors: Record<string, number>;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  onResolve?: (thread: CommentThread, resolved: boolean) => void;
  onReply?: (thread: CommentThread, body: string) => void;
  onDelete?: (thread: CommentThread, reply?: ThreadReply) => void;
  onRetry?: () => void;
  status: CommentThreadsStatus;
  canComment: boolean;
  draft?: CommentDraft | null;
  onSubmitDraft?: (body: string) => void;
  onCancelDraft?: () => void;
  publishError?: string | null;
  storage?: CommentStorage | null;
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
  showResolved?: boolean;
  onShowResolvedChange?: (show: boolean) => void;
  draftAnchorTop?: number;
  heights?: Record<string, number>;
  measuredHeight?: { collapsed: number; active: number };
  className?: string;
};

const COLLAPSED_HEIGHT = 96;
const ACTIVE_HEIGHT = 220;

type Reader = { getItem(key: string): string | null };
type Writer = { setItem(key: string, value: string): void };
export type CommentStorage = Reader & Writer;

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

const when = (iso: string): string => {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "";
};

function Author({ author }: { author: CommentAuthor }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar aria-hidden="true">{initials(author.name)}</Avatar>
      <span className="min-w-0 truncate text-[13px] font-medium">{author.name || author.id}</span>
    </span>
  );
}

function ThreadCard({
  thread,
  placement,
  active,
  canComment,
  onActivate,
  onResolve,
  onReply,
  onDelete,
  onMeasure,
}: {
  thread: CommentThread;
  placement: ThreadPlacement | null;
  active: boolean;
  canComment: boolean;
  onActivate: () => void;
  onMeasure?: (id: string, height: number) => void;
  onResolve?: (thread: CommentThread, resolved: boolean) => void;
  onReply?: (thread: CommentThread, body: string) => void;
  onDelete?: (thread: CommentThread, reply?: ThreadReply) => void;
}) {
  const [reply, setReply] = useState("");
  const bodyId = useId();
  const cardRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const card = cardRef.current;
    if (!card || !onMeasure || typeof ResizeObserver === "undefined") return;
    const report = (height: number) => onMeasure(thread.id, height);
    report(card.offsetHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      report(entry?.borderBoxSize?.[0]?.blockSize ?? card.offsetHeight);
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, [thread.id, onMeasure]);
  const stale = thread.stale === true;
  const resolved = thread.resolvedAt !== null;
  const openThread = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" && !active) {
        event.preventDefault();
        onActivate();
      }
      if (event.key === "Escape" && active) {
        event.preventDefault();
        onActivate();
      }
    },
    [active, onActivate],
  );
  return (
    <article
      ref={cardRef}
      data-thread-id={thread.id}
      aria-labelledby={`${bodyId}-label`}
      aria-expanded={active}
      tabIndex={0}
      onKeyDown={openThread}
      className={[
        "comment-thread-card",
        active ? "comment-thread-card-active" : "",
        resolved ? "comment-thread-card-resolved" : "",
        stale ? "comment-thread-card-stale" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={placement ? { top: placement.top } : undefined}
    >
      <button
        type="button"
        id={`${bodyId}-label`}
        onClick={() => onActivate()}
        className="comment-thread-header"
        aria-label={`${active ? "Close" : "Open"} thread by ${thread.author.name || thread.author.id}`}
      >
        <Author author={thread.author} />
        <time dateTime={thread.createdAt} className="text-[11px] text-fg-subtle">
          {when(thread.createdAt)}
        </time>
      </button>
      <p className={active ? "comment-thread-body" : "comment-thread-body comment-thread-clamp"}>{thread.body}</p>
      {stale ? (
        <p className="comment-thread-flag">
          {thread.staleLabel ?? "Text changed"}
          <span className="comment-thread-quote">{thread.quotedText}</span>
        </p>
      ) : null}
      {resolved ? <p className="comment-thread-flag">Resolved</p> : null}
      {active && !resolved ? (
        <div className="comment-thread-full">
          <blockquote className="comment-thread-quote">{thread.quotedText}</blockquote>
          <ol className="comment-thread-replies">
            {thread.replies.map((entry) => (
              <li key={entry.id} className="comment-thread-reply">
                <Author author={entry.author} />
                <p className="comment-thread-body">{entry.body}</p>
                {entry.canDelete && onDelete ? (
                  <IconAction
                    icon="trash"
                    label={`Delete reply by ${entry.author.name || entry.author.id}`}
                    onClick={() => onDelete(thread, entry)}
                  />
                ) : null}
              </li>
            ))}
          </ol>
          {canComment && onReply ? (
            <form
              className="comment-thread-reply-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!reply.trim()) return;
                onReply(thread, reply);
                setReply("");
              }}
            >
              <label className="sr-only" htmlFor={`${bodyId}-reply`}>
                Reply to {thread.author.name || thread.author.id}
              </label>
              <input
                id={`${bodyId}-reply`}
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder="Reply…"
                className="comment-thread-input"
              />
              <Button type="submit" size="sm" disabled={!reply.trim()}>
                Reply
              </Button>
            </form>
          ) : null}
          <div className="comment-thread-actions">
            {canComment && onResolve ? (
              <Button size="sm" onClick={() => onResolve(thread, true)}>
                Resolve
              </Button>
            ) : null}
            {canComment && thread.canDelete && onDelete ? (
              <Button size="sm" variant="danger-ghost" onClick={() => onDelete(thread)}>
                Delete
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => onActivate()}>
              Close
            </Button>
          </div>
        </div>
      ) : null}
      {active && resolved ? (
        <div className="comment-thread-actions">
          {canComment && onResolve ? (
            <Button size="sm" onClick={() => onResolve(thread, false)}>
              Reopen
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => onActivate()}>
            Close
          </Button>
        </div>
      ) : null}
      {!active && thread.replies.length > 0 ? (
        <p className="comment-thread-count">
          {thread.replies.length} {thread.replies.length === 1 ? "reply" : "replies"}
        </p>
      ) : null}
    </article>
  );
}

function DraftCard({
  draft,
  onSubmit,
  onCancel,
  placement,
}: {
  draft: CommentDraft;
  onSubmit?: (body: string) => void;
  onCancel?: () => void;
  placement: ThreadPlacement;
}) {
  const [body, setBody] = useState(draft.body);
  const inputId = useId();
  return (
    <form
      className="comment-thread-card comment-thread-card-active comment-thread-draft"
      style={{ top: placement.top }}
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.busy || !body.trim()) return;
        onSubmit?.(body);
      }}
    >
      <blockquote className="comment-thread-quote">{draft.quotedText}</blockquote>
      <label className="sr-only" htmlFor={inputId}>
        New comment
      </label>
      <textarea
        id={inputId}
        value={body}
        rows={3}
        required
        maxLength={4000}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel?.();
          }
        }}
        className="comment-thread-input"
        placeholder="Write a comment…"
      />
      {draft.error ? (
        <p role="alert" className="comment-thread-flag">
          {draft.error}
        </p>
      ) : null}
      <div className="comment-thread-actions">
        <Button type="button" size="sm" variant="ghost" onClick={() => onCancel?.()}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={draft.busy || !body.trim()}>
          Comment
        </Button>
      </div>
    </form>
  );
}

function MobileSheet({
  threads,
  activeId,
  onActivate,
  canComment,
  onResolve,
  onReply,
}: {
  threads: CommentThread[];
  activeId: string | null;
  onActivate: (id: string | null) => void;
  canComment: boolean;
  onResolve?: (thread: CommentThread, resolved: boolean) => void;
  onReply?: (thread: CommentThread, body: string) => void;
}) {
  const index = threads.findIndex((thread) => thread.id === activeId);
  const thread = index >= 0 ? threads[index]! : null;
  const [reply, setReply] = useState("");
  const replyId = useId();
  useEffect(() => {
    if (thread === null) setReply("");
  }, [thread]);
  if (thread === null) return null;
  const step = (delta: number) => {
    const next = threads[index + delta];
    if (next) onActivate(next.id);
  };
  return (
    <div className="comment-thread-sheet comment-thread-sheet-open">
      <div role="dialog" aria-modal="true" aria-label={`Comment thread ${index + 1} of ${threads.length}`}>
        <header className="comment-thread-sheet-head">
          <Author author={thread.author} />
          <span className="flex items-center gap-1">
            <IconAction icon="left" label="Previous thread" disabled={index === 0} onClick={() => step(-1)} />
            <IconAction
              icon="right"
              label="Next thread"
              disabled={index === threads.length - 1}
              onClick={() => step(1)}
            />
            <IconAction icon="x" label="Close thread" onClick={() => onActivate(null)} />
          </span>
        </header>
        <div className="comment-thread-sheet-body">
          <blockquote className="comment-thread-quote">{thread.quotedText}</blockquote>
          <p className="comment-thread-body">{thread.body}</p>
          <ol className="comment-thread-replies">
            {thread.replies.map((entry) => (
              <li key={entry.id} className="comment-thread-reply">
                <Author author={entry.author} />
                <p className="comment-thread-body">{entry.body}</p>
              </li>
            ))}
          </ol>
        </div>
        {canComment && onReply ? (
          <form
            className="comment-thread-sheet-reply"
            onSubmit={(event) => {
              event.preventDefault();
              if (!reply.trim()) return;
              onReply(thread, reply);
              setReply("");
            }}
          >
            <label className="sr-only" htmlFor={replyId}>
              Reply
            </label>
            <input
              id={replyId}
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              placeholder="Reply…"
              className="comment-thread-input"
            />
            <Button type="submit" size="sm" disabled={!reply.trim()}>
              Reply
            </Button>
          </form>
        ) : null}
        <div className="comment-thread-actions">
          {canComment && onResolve ? (
            <Button size="sm" onClick={() => onResolve(thread, thread.resolvedAt === null)}>
              {thread.resolvedAt === null ? "Resolve" : "Reopen"}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => onActivate(null)}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

function draftPlacement(placements: ThreadPlacement[], anchorTop: number, height: number): ThreadPlacement {
  const [placed] = layoutCommentThreads({
    threads: [
      ...placements.map(({ id, anchorTop: top, height: size }) => ({ id, anchorTop: top, height: size })),
      { id: "__draft__", anchorTop, height },
    ],
    activeId: "__draft__",
  }).filter((placement) => placement.id === "__draft__");
  return placed ?? { id: "__draft__", anchorTop, height, top: marginHeight(placements) };
}

function Skeleton() {
  return (
    <div className="comment-thread-skeletons" aria-hidden="true">
      <div className="comment-thread-card comment-thread-skeleton" />
      <div className="comment-thread-card comment-thread-skeleton" style={{ top: 112 }} />
    </div>
  );
}

export default function CommentThreadMargin({
  threads,
  anchors,
  activeId,
  onActivate,
  onResolve,
  onReply,
  onDelete,
  onRetry,
  status,
  canComment,
  draft = null,
  onSubmitDraft,
  onCancelDraft,
  publishError = null,
  storage,
  visible: visibleProp,
  onVisibleChange,
  showResolved: showResolvedProp,
  onShowResolvedChange,
  draftAnchorTop = 0,
  heights = {},
  measuredHeight,
  className,
}: CommentThreadMarginProps) {
  const store = storage === undefined ? browserCommentStorage() : storage;
  const [visibleState, setVisibleState] = useState(() => readCommentsVisible(store));
  const [resolvedState, setResolvedState] = useState(false);
  const visible = visibleProp ?? visibleState;
  const showResolved = showResolvedProp ?? resolvedState;
  const label = useId();
  const collapsed = measuredHeight?.collapsed ?? COLLAPSED_HEIGHT;
  const active = measuredHeight?.active ?? ACTIVE_HEIGHT;
  const setVisible = (next: boolean) => {
    setVisibleState(next);
    onVisibleChange?.(next);
    writeCommentsVisible(store, next);
    if (!next) onActivate(null);
  };
  const setShowResolved = (next: boolean) => {
    setResolvedState(next);
    onShowResolvedChange?.(next);
  };
  const toggle = () => setVisible(!visible);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const onMeasure = useCallback((id: string, height: number) => {
    const rounded = Math.ceil(height);
    setMeasured((current) => (current[id] === rounded ? current : { ...current, [id]: rounded }));
  }, []);
  const shown = useMemo(() => visibleThreads(threads, showResolved), [threads, showResolved]);
  const { placed, unplaced } = useMemo(() => partitionPlaced(shown, anchors), [shown, anchors]);
  const placements = useMemo(
    () =>
      layoutCommentThreads({
        threads: placed.map((thread) => ({
          id: thread.id,
          anchorTop: anchors[thread.id] ?? 0,
          height: heights[thread.id] ?? measured[thread.id] ?? (thread.id === activeId ? active : collapsed),
        })),
        activeId,
      }),
    [placed, anchors, heights, measured, activeId, active, collapsed],
  );
  const openCount = openThreadCount(threads);
  const sheetThreads = shown.filter((thread) => thread.resolvedAt === null);
  return (
    <section
      className={["comment-thread-margin-root", visible ? "" : "comment-thread-margin-hidden", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      aria-label="Comments"
    >
      <div className="comment-thread-bar">
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={visible}
          aria-controls={label}
          onClick={toggle}
          className="min-h-11"
        >
          {visible ? "Hide comments" : "Show comments"}
        </Button>
        <span className="text-[11.5px] text-fg-subtle" aria-live="polite">
          {openCount} open
        </span>
        {visible ? (
          <label className="flex min-h-11 items-center gap-2 text-[11.5px] text-fg-muted">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(event) => setShowResolved(event.target.checked)}
              className="size-4"
            />
            Show resolved
          </label>
        ) : null}
      </div>
      {visible && publishError ? (
        <p role="alert" className="comment-thread-alert">
          {publishError}
        </p>
      ) : null}
      {visible ? (
        <div id={label} className="comment-thread-margin" style={{ minHeight: marginHeight(placements) }}>
          {status === "loading" ? <Skeleton /> : null}
          {status === "error" ? (
            <div role="alert" className="comment-thread-error">
              <p>Could not load comments.</p>
              {onRetry ? (
                <Button size="sm" onClick={onRetry}>
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
          {status === "empty" && draft === null ? (
            <p className="comment-thread-empty">Select text in the document to start a thread.</p>
          ) : null}
          {status !== "error"
            ? placed.map((thread) => {
                const placement = placementOf(placements, thread.id);
                if (!placement) return null;
                return (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    placement={placement}
                    active={thread.id === activeId}
                    canComment={canComment}
                    onActivate={() => onActivate(thread.id === activeId ? null : thread.id)}
                    onResolve={onResolve}
                    onReply={onReply}
                    onDelete={onDelete}
                    onMeasure={onMeasure}
                  />
                );
              })
            : null}
          {status !== "error" && unplaced.length > 0 ? (
            <div
              role="group"
              aria-label="No location"
              className="comment-thread-unplaced"
              style={{ marginTop: marginHeight(placements) }}
            >
              <h3 className="comment-thread-unplaced-title">No location</h3>
              {unplaced.map((thread) => (
                <ThreadCard
                  key={thread.id}
                  thread={thread}
                  placement={null}
                  active={thread.id === activeId}
                  canComment={canComment}
                  onActivate={() => onActivate(thread.id === activeId ? null : thread.id)}
                  onResolve={onResolve}
                  onReply={onReply}
                  onDelete={onDelete}
                />
              ))}
            </div>
          ) : null}
          {draft !== null && draft !== undefined ? (
            <DraftCard
              draft={draft}
              onSubmit={onSubmitDraft}
              onCancel={onCancelDraft}
              placement={draftPlacement(placements, draftAnchorTop, active)}
            />
          ) : null}
        </div>
      ) : null}
      <MobileSheet
        threads={sheetThreads}
        activeId={activeId}
        onActivate={onActivate}
        canComment={canComment}
        onResolve={onResolve}
        onReply={onReply}
      />
    </section>
  );
}
