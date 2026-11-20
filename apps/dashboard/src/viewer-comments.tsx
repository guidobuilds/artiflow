import { createRoot } from "react-dom/client";

import "@/styles/globals.css";

import CommentThreadMargin, { type CommentThread } from "@/components/comments/comment-thread-margin.tsx";
import {
  createMessageBudget,
  encodeCommand,
  parseBridgeMessage,
  type ParentCommand,
} from "@artiflow/domain/html-bridge";
import { anchorOffsets } from "@/comment-thread-layout.ts";
import { attemptMutation } from "@/viewer-mutations.ts";
import { parseThreadsResponse, reconcileActive } from "@/viewer-thread-sync.ts";

type ElementAnchor = {
  kind: "element";
  selector: string;
  point: { x: number; y: number };
  textHint: string;
  viewportWidth: number;
};

type ViewerThread = CommentThread & { occurrence: number; anchor?: unknown };

type Config = {
  artifactId: string;
  mode: "text" | "element";
  bridgeNonce?: string;
  canComment: boolean;
  canResolve: boolean;
  threads: ViewerThread[];
  endpoints: { comments: string; resolve: string; deleteComment: string; list?: string };
};

const MARK = "viewer-comment-mark";

const readConfig = (): Config | null => {
  const node = document.getElementById("viewer-comments-data");
  if (node === null) return null;
  try {
    return JSON.parse(node.textContent ?? "") as Config;
  } catch {
    return null;
  }
};

const textNodes = (root: HTMLElement): Text[] => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node.textContent ?? "").trim() === "" || node.parentElement?.closest("script,style") !== null
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
};

export const indexOfOccurrence = (
  root: HTMLElement,
  needle: string,
  occurrence: number,
): { node: Text; start: number } | null => {
  if (needle.trim() === "") return null;
  let seen = 0;
  for (const node of textNodes(root)) {
    const text = node.textContent ?? "";
    for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) {
      if (seen === occurrence) return { node, start: index };
      seen++;
    }
  }
  return null;
};

const clearMarks = (root: HTMLElement): void => {
  for (const mark of Array.from(root.querySelectorAll<HTMLElement>(`mark.${MARK}`))) {
    const parent = mark.parentNode;
    if (parent === null) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  }
};

const markThread = (root: HTMLElement, thread: ViewerThread, active: boolean): HTMLElement | null => {
  const found = indexOfOccurrence(root, thread.quotedText, thread.occurrence);
  if (found === null) return null;
  const length = (found.node.textContent ?? "").length;
  const range = document.createRange();
  range.setStart(found.node, Math.min(found.start, length));
  range.setEnd(found.node, Math.min(found.start + thread.quotedText.length, length));
  const wrapper = document.createElement("mark");
  wrapper.className = [
    MARK,
    thread.stale === true ? "viewer-comment-mark-stale" : "",
    active ? "viewer-comment-mark-active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  wrapper.dataset.threadId = thread.id;
  try {
    range.surroundContents(wrapper);
    return wrapper;
  } catch {
    return null;
  }
};

const reducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const fetchThreads = async (url: string): Promise<{ canComment: boolean; threads: ViewerThread[] }> => {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not refresh the comments (${response.status}).`);
  const parsed = parseThreadsResponse<ViewerThread>(await response.json());
  if (parsed === null) throw new Error("Could not refresh the comments.");
  return parsed;
};

const postJson = async (url: string, body: unknown): Promise<void> => {
  if (url === "") throw new Error("Comments are not available on this page.");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Could not save the comment (${response.status}).`);
};

const deleteRequest = async (url: string): Promise<void> => {
  const response = await fetch(url, { method: "DELETE", credentials: "same-origin" });
  if (!response.ok) throw new Error(`Could not delete the comment (${response.status}).`);
};

export function mountViewerComments(): void {
  const config = readConfig();
  const host = document.getElementById("viewer-comments");
  const documentRoot = document.getElementById("document");
  const shell = document.getElementById("docshell");
  if (config === null || host === null || documentRoot === null || shell === null) return;
  const root = createRoot(host);
  const state = {
    activeId: null as string | null,
    visible: true,
    showResolved: false,
    geometry: {} as Record<string, number>,
    error: null as string | null,
    retry: null as (() => void) | null,
  };
  const refetch = async (): Promise<void> => {
    const list = config.endpoints.list;
    if (list === undefined) return;
    try {
      const next = await fetchThreads(list);
      config.threads = next.threads;
      config.canComment = next.canComment;
      state.activeId = reconcileActive(state.activeId, next.threads);
      state.error = null;
      state.retry = null;
      repaintMarks();
      measure();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Could not refresh the comments.";
      state.retry = () => void refetch();
      render();
    }
  };
  const mutate = (run: () => Promise<unknown>): void => {
    state.error = null;
    render();
    void attemptMutation(run).then((outcome) => {
      if (outcome.ok) {
        state.retry = null;
        void refetch();
        return;
      }
      state.error = outcome.message;
      state.retry = () => mutate(run);
      render();
    });
  };
  const reveal = (id: string): void => {
    const mark = documentRoot.querySelector<HTMLElement>(`mark.${MARK}[data-thread-id="${CSS.escape(id)}"]`);
    if (mark === null) return;
    const box = mark.getBoundingClientRect();
    const view = shell.getBoundingClientRect();
    if (box.top < view.top || box.bottom > view.bottom)
      mark.scrollIntoView({ block: "center", behavior: reducedMotion() ? "instant" : "smooth" });
    mark.classList.remove(`${MARK}-flash`);
    void mark.offsetWidth;
    mark.classList.add(`${MARK}-flash`);
  };
  const activate = (id: string | null): void => {
    state.activeId = id;
    repaintMarks();
    measure();
    if (id !== null) reveal(id);
  };
  const shelfOrigin = (): number => {
    const shelf = host.querySelector<HTMLElement>(".comment-thread-margin");
    return shelf === null ? 0 : shelf.getBoundingClientRect().top;
  };
  const marked = new Set<string>();
  const repaintMarks = (): void => {
    clearMarks(documentRoot);
    marked.clear();
    if (!state.visible) return;
    for (const thread of config.threads)
      if (state.showResolved || thread.resolvedAt === null) {
        if (markThread(documentRoot, thread, thread.id === state.activeId) !== null) marked.add(thread.id);
      }
  };
  let measuredOrigin: number | null = null;
  const scheduleOriginCheck = (): void => {
    window.requestAnimationFrame(() => {
      const origin = shelfOrigin();
      if (measuredOrigin !== null && Math.abs(origin - measuredOrigin) > 1) measure();
    });
  };
  const threadsWithStaleMarks = () =>
    config.threads.map((thread) =>
      !marked.has(thread.id) && (state.showResolved || thread.resolvedAt === null)
        ? { ...thread, stale: true, staleLabel: "Text changed" }
        : thread,
    );
  const measure = (): void => {
    const origin = shelfOrigin();
    measuredOrigin = origin;
    const entries: { id: string; top: number }[] = [];
    for (const mark of Array.from(documentRoot.querySelectorAll<HTMLElement>(`mark.${MARK}`))) {
      const id = mark.dataset.threadId;
      if (id !== undefined) entries.push({ id, top: mark.getBoundingClientRect().top });
    }
    state.geometry = anchorOffsets(entries, origin);
    render();
  };
  const render = (): void => {
    scheduleOriginCheck();
    host.style.display = state.visible ? "block" : "none";
    shell.classList.toggle("comments-visible", state.visible);
    root.render(
      <CommentThreadMargin
        threads={threadsWithStaleMarks()}
        anchors={state.geometry}
        activeId={state.activeId}
        onActivate={activate}
        onResolve={(thread, resolved) => {
          mutate(() =>
            postJson(
              `${config.endpoints.resolve}/${encodeURIComponent(thread.id)}/${resolved ? "resolve" : "unresolve"}`,
              {},
            ),
          );
        }}
        onReply={(thread, body) => {
          mutate(() => postJson(config.endpoints.comments, { body, parentId: thread.id }));
        }}
        onDelete={(thread, reply) => {
          const target = reply ?? thread;
          mutate(() => deleteRequest(`${config.endpoints.deleteComment}/${encodeURIComponent(target.id)}`));
        }}
        onRetry={() => {
          if (state.retry !== null) {
            state.retry();
            return;
          }
          if (config.endpoints.list !== undefined) {
            void refetch();
            return;
          }
          window.location.reload();
        }}
        status={config.threads.length === 0 ? "empty" : "ready"}
        canComment={config.canComment}
        publishError={state.error}
        visible={state.visible}
        onVisibleChange={(next) => {
          state.visible = next;
          if (!next) state.activeId = null;
          repaintMarks();
          render();
        }}
        showResolved={state.showResolved}
        onShowResolvedChange={(next) => {
          state.showResolved = next;
          repaintMarks();
          measure();
        }}
      />,
    );
  };
  repaintMarks();
  measure();
  const frame = () => window.requestAnimationFrame(measure);
  window.addEventListener("resize", frame);
  shell.addEventListener("scroll", frame);
  void document.fonts?.ready.then(frame);
  documentRoot.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(`mark.${MARK}`);
    if (target?.dataset.threadId) activate(target.dataset.threadId);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.activeId !== null) activate(null);
  });
}

const pinsOf = (threads: ViewerThread[]) =>
  threads.flatMap((thread, index) => {
    const anchor = thread.anchor as
      | {
          kind?: string;
          selector?: string;
          textHint?: string;
          point?: { x: number; y: number };
          x?: number;
          y?: number;
        }
      | null
      | undefined;
    if (anchor === null || anchor === undefined) return [];
    const number = index + 1;
    if (anchor.kind === "element")
      return [
        {
          id: thread.id,
          number,
          selector: anchor.selector ?? "",
          textHint: anchor.textHint ?? "",
          x: anchor.point?.x ?? 0.5,
          y: anchor.point?.y ?? 0.5,
          stale: false,
        },
      ];
    if (anchor.kind === "page-point")
      return [{ id: thread.id, number, selector: "", textHint: "", x: anchor.x ?? 0.5, y: anchor.y ?? 0, stale: true }];
    return [];
  });

export function mountViewerCommentsInFrame(): void {
  const config = readConfig();
  const host = document.getElementById("viewer-comments");
  const frame = document.querySelector<HTMLIFrameElement>("#docshell iframe");
  const shell = document.getElementById("docshell");
  const nonce = config?.bridgeNonce ?? "";
  if (config === null || host === null || frame === null || shell === null || nonce === "") return;
  const root = createRoot(host);
  const budget = createMessageBudget();
  const state = {
    activeId: null as string | null,
    visible: true,
    showResolved: false,
    geometry: {} as Record<string, number>,
    error: null as string | null,
    staleIds: [] as string[],
    commenting: false,
    scrollY: 0,
    draft: null as { anchor: ElementAnchor; top: number } | null,
    busy: false,
    retry: null as (() => void) | null,
  };
  const refetch = async (): Promise<void> => {
    const list = config.endpoints.list;
    if (list === undefined) return;
    try {
      const next = await fetchThreads(list);
      const known = new Set(next.threads.map((thread) => thread.id));
      config.threads = next.threads;
      config.canComment = next.canComment;
      state.activeId = reconcileActive(state.activeId, next.threads);
      state.staleIds = state.staleIds.filter((id) => known.has(id));
      state.geometry = Object.fromEntries(Object.entries(state.geometry).filter(([id]) => known.has(id)));
      state.error = null;
      state.retry = null;
      send({ type: "pins", pins: pins() });
      if (state.activeId !== null) send({ type: "focus", id: state.activeId });
      render();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Could not refresh the comments.";
      state.retry = () => void refetch();
      render();
    }
  };
  const mutate = (run: () => Promise<unknown>, after: () => void = () => {}): void => {
    state.busy = true;
    state.error = null;
    render();
    void attemptMutation(run).then((outcome) => {
      state.busy = false;
      if (outcome.ok) {
        state.retry = null;
        after();
        void refetch();
        return;
      }
      state.error = outcome.message;
      state.retry = () => mutate(run, after);
      render();
    });
  };
  const send = (command: ParentCommand) => {
    frame.contentWindow?.postMessage(encodeCommand(command, nonce), "*");
  };
  const pins = () => pinsOf(config.threads);
  const frameOffset = (): number => {
    const shelf = host.querySelector<HTMLElement>(".comment-thread-margin");
    return Math.round(frame.getBoundingClientRect().top - (shelf?.getBoundingClientRect().top ?? 0));
  };
  let renderedOffset: number | null = null;
  const shelfAnchors = (offset: number): Record<string, number> => {
    const anchors: Record<string, number> = {};
    for (const [id, y] of Object.entries(state.geometry)) anchors[id] = Math.round(y + offset);
    return anchors;
  };
  const render = (): void => {
    const offset = frameOffset();
    renderedOffset = offset;
    window.requestAnimationFrame(() => {
      if (renderedOffset !== null && Math.abs(frameOffset() - renderedOffset) > 1) render();
    });
    host.style.display = state.visible ? "block" : "none";
    shell.classList.toggle("comments-visible", state.visible);
    if (!state.visible) send({ type: "mode", on: false });
    root.render(
      <CommentThreadMargin
        threads={config.threads.map((thread) =>
          state.staleIds.includes(thread.id) ? { ...thread, stale: true, staleLabel: "Element changed" } : thread,
        )}
        anchors={shelfAnchors(offset)}
        activeId={state.activeId}
        onActivate={(id) => {
          state.activeId = id;
          send({ type: "focus", id });
          render();
        }}
        onResolve={(thread, resolved) => {
          mutate(() =>
            postJson(
              `${config.endpoints.resolve}/${encodeURIComponent(thread.id)}/${resolved ? "resolve" : "unresolve"}`,
              {},
            ),
          );
        }}
        onReply={(thread, body) => {
          mutate(() => postJson(config.endpoints.comments, { body, parentId: thread.id }));
        }}
        onDelete={(thread, reply) => {
          const target = reply ?? thread;
          mutate(() => deleteRequest(`${config.endpoints.deleteComment}/${encodeURIComponent(target.id)}`));
        }}
        onRetry={() => {
          if (state.retry !== null) {
            state.retry();
            return;
          }
          if (config.endpoints.list !== undefined) {
            void refetch();
            return;
          }
          window.location.reload();
        }}
        status={config.threads.length === 0 ? "empty" : "ready"}
        canComment={config.canComment}
        publishError={state.error}
        visible={state.visible}
        onVisibleChange={(next) => {
          state.visible = next;
          if (!next) state.activeId = null;
          render();
        }}
        showResolved={state.showResolved}
        onShowResolvedChange={(next) => {
          state.showResolved = next;
          render();
        }}
        draft={
          state.draft === null
            ? null
            : {
                quotedText: state.draft.anchor.textHint || state.draft.anchor.selector,
                body: "",
                busy: state.busy,
                error: state.error,
              }
        }
        draftAnchorTop={state.draft === null ? 0 : state.draft.top + offset}
        onSubmitDraft={(body) => {
          if (state.draft === null) return;
          const anchor = state.draft.anchor;
          mutate(
            () => postJson(config.endpoints.comments, { anchor, body }),
            () => {
              state.draft = null;
              state.commenting = false;
              send({ type: "mode", on: false });
            },
          );
        }}
        onCancelDraft={() => {
          state.draft = null;
          state.commenting = false;
          send({ type: "mode", on: false });
          render();
        }}
      />,
    );
  };
  const commentButton = document.querySelector<HTMLElement>(".vbar-actions");
  if (config.canComment && commentButton !== null) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vbar-focus";
    button.dataset.commentMode = "true";
    button.textContent = "Comment";
    button.title = "Comment on an element (C)";
    button.addEventListener("click", () => {
      state.commenting = !state.commenting;
      send({ type: "mode", on: state.commenting });
      button.setAttribute("aria-pressed", String(state.commenting));
    });
    commentButton.prepend(button);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.commenting) {
        state.commenting = false;
        state.draft = null;
        send({ type: "mode", on: false });
        button.setAttribute("aria-pressed", "false");
        render();
      }
      if (
        (event.key === "c" || event.key === "C") &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.target === document.body
      ) {
        state.commenting = !state.commenting;
        send({ type: "mode", on: state.commenting });
        button.setAttribute("aria-pressed", String(state.commenting));
      }
    });
  }
  const onMessage = (event: MessageEvent) => {
    const parsed = parseBridgeMessage(event.data, {
      nonce,
      source: event.source,
      frame: frame.contentWindow,
      budget,
    });
    if (!parsed.ok) return;
    const message = parsed.message;
    if (message.type === "ready") {
      send({ type: "pins", pins: pins() });
      if (state.commenting) send({ type: "mode", on: true });
      render();
      return;
    }
    if (message.type === "geometry") {
      state.geometry = { ...state.geometry, [message.id]: message.y };
      const stale = state.staleIds.includes(message.id);
      if (!message.visible && !stale) state.staleIds = [...state.staleIds, message.id];
      if (message.visible && stale) state.staleIds = state.staleIds.filter((id) => id !== message.id);
      render();
      return;
    }
    if (message.type === "scroll") {
      state.scrollY = message.y;
      return;
    }
    if (message.type === "pin-click") {
      state.activeId = message.id;
      send({ type: "focus", id: message.id });
      render();
      return;
    }
    if (message.type === "pick") {
      if (!config.canComment) return;
      state.commenting = false;
      state.draft = {
        anchor: {
          kind: "element",
          selector: message.selector,
          textHint: message.textHint,
          point: { x: message.x, y: message.y },
          viewportWidth: Math.round(message.viewportWidth),
        },
        top: Math.max(0, Math.round(message.viewportY + state.scrollY) - 16),
      };
      render();
    }
  };
  window.addEventListener("message", onMessage);
  const sync = () => send({ type: "pins", pins: pins() });
  frame.addEventListener("load", sync);
  sync();
  render();
}

if (typeof document !== "undefined" && document.getElementById("viewer-comments") !== null) {
  const config = readConfig();
  if (config?.mode === "element") mountViewerCommentsInFrame();
  else mountViewerComments();
}
