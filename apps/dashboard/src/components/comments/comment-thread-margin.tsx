import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

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
  isChromeTarget,
  isEditableTarget,
  parseThreadHash,
  resolveDeepLink,
  shortcutFor,
  stepThread,
  threadHashUrl,
} from "@/comment-thread-navigation.ts";
import {
  browserCommentStorage,
  nextResolvedState,
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
  toggleHost?: HTMLElement | null;
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

export type CommentsChrome = {
  hostDisplay: "block" | "none";
  panelShown: boolean;
  togglePlacement: "inside" | "floating";
};

export function commentsVisibilityChrome(visible: boolean, floatingHost: boolean): CommentsChrome {
  const floating = floatingHost && !visible;
  return {
    hostDisplay: visible ? "block" : "none",
    panelShown: visible,
    togglePlacement: floating ? "floating" : "inside",
  };
}

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
  sheet = false,
}: {
  thread: CommentThread;
  index: number;
  total: number;
  canComment: boolean;
  sheet?: boolean;
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
      className={sheet ? "comment-thread-dock comment-thread-dock-sheet" : "comment-thread-dock"}
      role="region"
      aria-label={`Thread ${index + 1} of ${total}`}
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
              data-reply-input=""
              value={reply}
              data-comment-input={reply.trim() === "" ? "empty" : "typed"}
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
            <Button size="sm" onClick={() => onResolve(thread, nextResolvedState(thread))}>
              {nextResolvedState(thread) ? "Resolve" : "Reopen"}
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
  sheet = false,
}: {
  draft: CommentDraft;
  onSubmit?: (body: string) => void;
  onCancel?: () => void;
  sheet?: boolean;
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
      className={
        sheet
          ? "comment-thread-dock comment-thread-draft comment-thread-dock-sheet"
          : "comment-thread-dock comment-thread-draft"
      }
      data-comment-draft={body.trim() === "" ? "empty" : "typed"}
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

type Focusable = { focus: () => void };
const FOCUSABLE = 'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

function MobileSheet({ onBackdrop, children }: { onBackdrop: () => void; children: ReactNode }) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement as { focus?: () => void; isConnected?: boolean } | null;
    sheetRef.current?.focus();
    return () => {
      if (previous !== null && previous.isConnected !== false && typeof previous.focus === "function") {
        previous.focus();
      }
    };
  }, []);
  return (
    <div
      className="comment-thread-sheet comment-thread-sheet-open"
      onClick={(event: MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onBackdrop();
      }}
    >
      <div
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Comment thread"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = Array.from(event.currentTarget.querySelectorAll(FOCUSABLE)) as unknown as Focusable[];
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (first === undefined || last === undefined) return;
          const active: unknown = document.activeElement;
          if (event.shiftKey && (active === first || active === event.currentTarget)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

const COMPACT_QUERY = "(max-width: 800px)";

function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(COMPACT_QUERY).matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.(COMPACT_QUERY);
    if (!query) return;
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
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
  toggleHost = null,
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
  const chrome = commentsVisibilityChrome(visible, toggleHost !== null);
  const toggleId = `${label}-toggle`;
  const settledPlacement = useRef(chrome.togglePlacement);
  useEffect(() => {
    if (settledPlacement.current === chrome.togglePlacement) return;
    settledPlacement.current = chrome.togglePlacement;
    document.getElementById(toggleId)?.focus();
  }, [chrome.togglePlacement, toggleId]);
  const toggleControl = (
    <Button
      id={toggleId}
      size="sm"
      variant="ghost"
      aria-pressed={visible}
      aria-controls={label}
      onClick={toggle}
      className="min-h-11"
    >
      {visible ? "Hide comments" : "Show comments"}
    </Button>
  );
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
  const compact = useCompactViewport();
  const rootRef = useRef<HTMLElement>(null);
  const live = useRef({ dockOrder, activeId, onActivate, draft, onCancelDraft, visible, status, threads });
  live.current = { dockOrder, activeId, onActivate, draft, onCancelDraft, visible, status, threads };
  const pendingLink = useRef(typeof window !== "undefined" && parseThreadHash(window.location.hash) !== null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = live.current;
      if (!current.visible) return;
      const target = event.target;
      const action = shortcutFor({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        defaultPrevented: event.defaultPrevented,
        composing: event.isComposing,
        inChrome: isChromeTarget(target),
        editable: isEditableTarget(target),
        insideComments: target instanceof Node && rootRef.current?.contains(target) === true,
      });
      if (action === null) return;
      if (action === "close") {
        if (current.draft !== null && current.draft !== undefined) {
          event.preventDefault();
          current.onCancelDraft?.();
        } else if (current.activeId !== null) {
          event.preventDefault();
          current.onActivate(null);
        }
        return;
      }
      if (current.draft !== null && current.draft !== undefined) return;
      if (action === "reply") {
        const input = rootRef.current?.querySelector<HTMLInputElement>("[data-reply-input]");
        if (input) {
          event.preventDefault();
          input.focus();
        }
        return;
      }
      const next = stepThread(current.dockOrder, current.activeId, action === "next" ? 1 : -1);
      if (next !== null) {
        event.preventDefault();
        if (next !== current.activeId) current.onActivate(next);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const onHashChange = () => {
      const current = live.current;
      if (!current.visible) return;
      const id = resolveDeepLink(
        window.location.hash,
        current.threads.map((thread) => thread.id),
      );
      if (id !== null && id !== current.activeId) current.onActivate(id);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => {
    if (!pendingLink.current || !visible || (status !== "ready" && status !== "empty")) return;
    const id = resolveDeepLink(
      window.location.hash,
      threads.map((thread) => thread.id),
    );
    pendingLink.current = false;
    if (id !== null && id !== live.current.activeId) live.current.onActivate(id);
  }, [threads, status, visible]);
  useEffect(() => {
    if (pendingLink.current || typeof window === "undefined") return;
    const href = window.location.href;
    const next = threadHashUrl(href, activeId);
    if (next !== href) window.history.replaceState(window.history.state, "", next);
  }, [activeId]);
  const sheetOpen = compact && visible && status !== "error" && (draft !== null || activeThread !== null);
  return (
    <section
      ref={rootRef}
      className={["comment-thread-margin-root", visible ? "" : "comment-thread-margin-hidden", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      aria-label="Comments"
    >
      <div className="comment-thread-bar">
        {chrome.togglePlacement === "inside" ? toggleControl : null}
        <span className="text-[11.5px] text-fg-subtle" aria-live="polite">
          {openCount} open
        </span>
        {compact && visible && status !== "error" && dockOrder.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11"
            onClick={() => {
              const first = stepThread(dockOrder, activeId, 1);
              if (first !== null) onActivate(first);
            }}
          >
            Open threads
          </Button>
        ) : null}
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
      <div
        id={label}
        className="comment-thread-margin"
        hidden={!visible}
        style={visible ? { minHeight: marginHeight(placements, PILL_GAP) } : undefined}
      >
        {visible ? (
          <>
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
            {status !== "error" && !compact ? (
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
          </>
        ) : null}
      </div>
      {chrome.togglePlacement === "floating" && toggleHost !== null ? createPortal(toggleControl, toggleHost) : null}
      {sheetOpen ? (
        <MobileSheet onBackdrop={() => (draft !== null ? onCancelDraft?.() : onActivate(null))}>
          {draft !== null && draft !== undefined ? (
            <DraftPanel sheet draft={draft} onSubmit={onSubmitDraft} onCancel={onCancelDraft} />
          ) : activeThread !== null ? (
            <ThreadPanel
              sheet
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
          ) : null}
        </MobileSheet>
      ) : null}
    </section>
  );
}
