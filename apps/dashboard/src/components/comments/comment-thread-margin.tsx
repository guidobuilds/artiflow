import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { UserAvatar } from "@/components/ui/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon, IconAction } from "@/components/ui/icon.tsx";
import {
  layoutCommentThreads,
  marginHeight,
  partitionPlaced,
  placementOf,
  threadOrder,
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
  authorImage?: string | null;
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
  minTop?: number;
  layerOffset?: number;
  heights?: Record<string, number>;
  measuredHeight?: { collapsed: number; active: number };
  className?: string;
};

const PILL_HEIGHT = 32;
const PILL_GAP = 6;

type Reader = { getItem(key: string): string | null };
type Writer = { setItem(key: string, value: string): void };
export type CommentStorage = Reader & Writer;

const when = (iso: string): string => {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "";
};

function Author({ author }: { author: CommentAuthor }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <UserAvatar aria-hidden="true" image={author.image} />
      <span className="min-w-0 truncate text-[13px] font-medium">{author.name || author.id}</span>
    </span>
  );
}

const authorName = (author: CommentAuthor): string => author.name || author.id;

function ThreadPill({
  thread,
  placement,
  active,
  onActivate,
  onMeasure,
}: {
  thread: CommentThread;
  placement: ThreadPlacement | null;
  active: boolean;
  onActivate: () => void;
  onMeasure?: (id: string, height: number) => void;
}) {
  const pillRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const pill = pillRef.current;
    if (!pill || !onMeasure || typeof ResizeObserver === "undefined") return;
    const report = (height: number) => onMeasure(thread.id, height);
    report(pill.offsetHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      report(entry?.borderBoxSize?.[0]?.blockSize ?? pill.offsetHeight);
    });
    observer.observe(pill);
    return () => observer.disconnect();
  }, [thread.id, onMeasure]);
  const stale = thread.stale === true;
  const resolved = thread.resolvedAt !== null;
  const replies = thread.replies.length;
  return (
    <button
      ref={pillRef}
      type="button"
      data-thread-id={thread.id}
      aria-expanded={active}
      aria-label={`Open thread by ${authorName(thread.author)}, ${resolved ? "resolved" : `${replies} ${replies === 1 ? "reply" : "replies"}`}`}
      onClick={onActivate}
      className={[
        "comment-thread-pill",
        active ? "comment-thread-pill-active" : "",
        resolved ? "comment-thread-pill-resolved" : "",
        stale ? "comment-thread-pill-stale" : "",
        !resolved && replies === 0 ? "comment-thread-pill-solo" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={placement ? { top: placement.top } : undefined}
    >
      <UserAvatar aria-hidden="true" image={thread.author.image} />
      {resolved ? (
        <Icon name="check" className="comment-thread-pill-check" />
      ) : replies > 0 ? (
        <span className="comment-thread-pill-count" aria-hidden="true">
          {replies}
        </span>
      ) : null}
    </button>
  );
}

function ThreadPanel({
  thread,
  index,
  total,
  canComment,
  onPrevious,
  onNext,
  onClose,
  onResolve,
  onReply,
  onDelete,
}: {
  thread: CommentThread;
  index: number;
  total: number;
  canComment: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onResolve?: (thread: CommentThread, resolved: boolean) => void;
  onReply?: (thread: CommentThread, body: string) => void;
  onDelete?: (thread: CommentThread, reply?: ThreadReply) => void;
}) {
  const [reply, setReply] = useState("");
  const replyId = useId();
  const stale = thread.stale === true;
  const resolved = thread.resolvedAt !== null;
  return (
    <div
      className="comment-thread-dock"
      role="region"
      aria-label={`Thread ${index + 1} of ${total}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="comment-thread-dock-head">
        <h3 className="comment-thread-dock-title">
          Thread {index + 1} of {total}
        </h3>
        <span className="flex items-center gap-1">
          <IconAction icon="left" label="Previous thread" disabled={index === 0} onClick={onPrevious} />
          <IconAction icon="right" label="Next thread" disabled={index === total - 1} onClick={onNext} />
          <IconAction icon="x" label="Close thread" onClick={onClose} />
        </span>
      </header>
      <div key={`${thread.id}-body`} className="comment-thread-dock-body">
        <div className="comment-thread-dock-meta">
          <Author author={thread.author} />
          <time dateTime={thread.createdAt} className="text-[11px] text-fg-subtle">
            {when(thread.createdAt)}
          </time>
        </div>
        <blockquote className="comment-thread-quote">{thread.quotedText}</blockquote>
        {stale ? <p className="comment-thread-flag">{thread.staleLabel ?? "Text changed"}</p> : null}
        {resolved ? <p className="comment-thread-flag">Resolved</p> : null}
        <p className="comment-thread-body">{thread.body}</p>
        <ol className="comment-thread-replies">
          {thread.replies.map((entry) => (
            <li key={entry.id} className="comment-thread-reply">
              <Author author={entry.author} />
              <p className="comment-thread-body">{entry.body}</p>
              {entry.canDelete && onDelete ? (
                <IconAction
                  icon="trash"
                  label={`Delete reply by ${authorName(entry.author)}`}
                  onClick={() => onDelete(thread, entry)}
                />
              ) : null}
            </li>
          ))}
        </ol>
      </div>
      <footer key={`${thread.id}-footer`} className="comment-thread-dock-foot">
        {canComment && onReply && !resolved ? (
          <form
            className="comment-thread-reply-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!reply.trim()) return;
              onReply(thread, reply);
              setReply("");
            }}
          >
            <label className="sr-only" htmlFor={`${replyId}-reply`}>
              Reply to {authorName(thread.author)}
            </label>
            <input
              id={`${replyId}-reply`}
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
            <Button size="sm" onClick={() => onResolve(thread, resolved)}>
              {resolved ? "Reopen" : "Resolve"}
            </Button>
          ) : null}
          {canComment && thread.canDelete && onDelete ? (
            <Button size="sm" variant="danger-ghost" onClick={() => onDelete(thread)}>
              Delete
            </Button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

function DraftPanel({
  draft,
  onSubmit,
  onCancel,
}: {
  draft: CommentDraft;
  onSubmit?: (body: string) => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(draft.body);
  const inputId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const empty = body.trim() === "";
  useEffect(() => {
    if (!empty) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && formRef.current?.contains(event.target)) return;
      onCancel?.();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [empty, onCancel]);
  return (
    <form
      ref={formRef}
      className="comment-thread-dock comment-thread-draft"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.busy || !body.trim()) return;
        onSubmit?.(body);
      }}
    >
      <header className="comment-thread-dock-head">
        <h3 className="comment-thread-dock-title">New comment</h3>
        <IconAction icon="x" label="Cancel comment" onClick={() => onCancel?.()} />
      </header>
      <div className="comment-thread-dock-body">
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
      </div>
      <footer className="comment-thread-dock-foot">
        <div className="comment-thread-actions">
          <Button type="button" size="sm" variant="ghost" onClick={() => onCancel?.()}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={draft.busy || !body.trim()}>
            Comment
          </Button>
        </div>
      </footer>
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

function DockSlot({ top, children }: { top: number; children: ReactNode }) {
  const slot = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState(top);
  useLayoutEffect(() => {
    const element = slot.current;
    const rail = element?.parentElement;
    if (!element || !rail) return;
    const place = () => setPlaced(Math.max(0, Math.min(top, rail.clientHeight - element.offsetHeight)));
    place();
    const observer = new ResizeObserver(place);
    observer.observe(rail);
    observer.observe(element);
    return () => observer.disconnect();
  }, [top]);
  return (
    <div ref={slot} className="comment-thread-dock-slot" style={{ top: placed }}>
      {children}
    </div>
  );
}

function draftPlacement(
  placements: ThreadPlacement[],
  anchorTop: number,
  height: number,
  minTop: number,
): ThreadPlacement {
  const [placed] = layoutCommentThreads({
    threads: [
      ...placements.map(({ id, anchorTop: top, height: size }) => ({ id, anchorTop: top, height: size })),
      { id: "__draft__", anchorTop, height },
    ],
    activeId: "__draft__",
    gap: PILL_GAP,
    minTop,
  }).filter((placement) => placement.id === "__draft__");
  return placed ?? { id: "__draft__", anchorTop, height, top: marginHeight(placements, PILL_GAP) };
}

function Skeleton() {
  return (
    <div className="comment-thread-skeletons" aria-hidden="true">
      <div className="comment-thread-pill comment-thread-skeleton" />
      <div className="comment-thread-pill comment-thread-skeleton" style={{ top: 44 }} />
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
  minTop = 0,
  layerOffset = 0,
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
  const collapsed = measuredHeight?.collapsed ?? PILL_HEIGHT;
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
          height: heights[thread.id] ?? measured[thread.id] ?? collapsed,
        })),
        activeId,
        gap: PILL_GAP,
        minTop,
      }),
    [placed, anchors, heights, measured, activeId, collapsed, minTop],
  );
  const order = useMemo(() => threadOrder(shown, anchors), [shown, anchors]);
  const activeThread = activeId === null ? null : (threads.find((thread) => thread.id === activeId) ?? null);
  const dockOrder = activeThread !== null && !order.includes(activeThread.id) ? [...order, activeThread.id] : order;
  const dockIndex = activeThread === null ? -1 : dockOrder.indexOf(activeThread.id);
  const stepTo = (delta: number) => {
    const next = dockOrder[dockIndex + delta];
    if (next !== undefined) onActivate(next);
  };
  const draftTop = draft === null ? 0 : draftPlacement(placements, draftAnchorTop, collapsed, minTop).top;
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
        <div id={label} className="comment-thread-margin" style={{ minHeight: marginHeight(placements, PILL_GAP) }}>
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
          {status !== "error" ? (
            <div className="comment-thread-pills">
              <div className="comment-thread-pills-layer" style={{ transform: `translateY(${layerOffset}px)` }}>
                {placed.map((thread) => {
                  const placement = placementOf(placements, thread.id);
                  if (!placement) return null;
                  return (
                    <ThreadPill
                      key={thread.id}
                      thread={thread}
                      placement={placement}
                      active={thread.id === activeId}
                      onActivate={() => onActivate(thread.id === activeId ? null : thread.id)}
                      onMeasure={onMeasure}
                    />
                  );
                })}
                {draft !== null && draft !== undefined ? (
                  <span
                    aria-hidden="true"
                    className="comment-thread-pill comment-thread-pill-solo comment-thread-pill-draft"
                    style={{ top: draftTop }}
                  >
                    <UserAvatar aria-hidden="true" image={draft.authorImage} />
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
          {status !== "error" ? (
            <div className="comment-thread-dock-rail">
              {draft !== null && draft !== undefined ? (
                <DockSlot top={draftTop + layerOffset}>
                  <DraftPanel draft={draft} onSubmit={onSubmitDraft} onCancel={onCancelDraft} />
                </DockSlot>
              ) : activeThread !== null ? (
                <DockSlot top={(placementOf(placements, activeThread.id)?.top ?? 0) + layerOffset}>
                  <ThreadPanel
                    key={activeThread.id}
                    thread={activeThread}
                    index={dockIndex}
                    total={dockOrder.length}
                    canComment={canComment}
                    onPrevious={() => stepTo(-1)}
                    onNext={() => stepTo(1)}
                    onClose={() => onActivate(null)}
                    onResolve={onResolve}
                    onReply={onReply}
                    onDelete={onDelete}
                  />
                </DockSlot>
              ) : unplaced.length > 0 ? (
                <div role="group" aria-label="No location" className="comment-thread-unplaced">
                  <h3 className="comment-thread-unplaced-title">No location</h3>
                  {unplaced.map((thread) => (
                    <ThreadPill
                      key={thread.id}
                      thread={thread}
                      placement={null}
                      active={false}
                      onActivate={() => onActivate(thread.id)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
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
