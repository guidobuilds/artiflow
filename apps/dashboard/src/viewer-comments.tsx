import { createRoot } from "react-dom/client";

import CommentThreadMargin, { type CommentThread } from "@/components/comments/comment-thread-margin.tsx";
import {
  createMessageBudget,
  encodeCommand,
  parseBridgeMessage,
  type ParentCommand,
} from "@artiflow/domain/html-bridge";

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
  canComment: boolean;
  canResolve: boolean;
  threads: ViewerThread[];
  endpoints: { comments: string; resolve: string; deleteComment: string };
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

const postJson = async (url: string, body: unknown): Promise<void> => {
  if (url === "") return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
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
    anchors: {} as Record<string, number>,
    error: null as string | null,
  };
  const repaintMarks = (): void => {
    clearMarks(documentRoot);
    if (!state.visible) return;
    for (const thread of config.threads)
      if (state.showResolved || thread.resolvedAt === null)
        markThread(documentRoot, thread, thread.id === state.activeId);
  };
  const measure = (): void => {
    const origin = shell.getBoundingClientRect().top - shell.scrollTop;
    const anchors: Record<string, number> = {};
    for (const mark of Array.from(documentRoot.querySelectorAll<HTMLElement>(`mark.${MARK}`))) {
      const id = mark.dataset.threadId;
      if (id === undefined) continue;
      const top = mark.getBoundingClientRect().top - origin;
      anchors[id] = anchors[id] === undefined ? top : Math.min(anchors[id]!, top);
    }
    state.anchors = anchors;
    render();
  };
  const refresh = (): void => window.location.reload();
  const render = (): void => {
    host.style.display = state.visible ? "block" : "none";
    shell.classList.toggle("comments-visible", state.visible);
    root.render(
      <CommentThreadMargin
        threads={config.threads}
        anchors={state.anchors}
        activeId={state.activeId}
        onActivate={(id) => {
          state.activeId = id;
          repaintMarks();
          measure();
        }}
        onResolve={(thread, resolved) => {
          void postJson(
            `${config.endpoints.resolve}/${encodeURIComponent(thread.id)}/${resolved ? "resolve" : "unresolve"}`,
            {},
          ).then(refresh);
        }}
        onReply={(thread, body) => {
          void postJson(config.endpoints.comments, { body, parentId: thread.id }).then(refresh);
        }}
        onDelete={(thread, reply) => {
          const target = reply ?? thread;
          void fetch(`${config.endpoints.deleteComment}/${encodeURIComponent(target.id)}`, {
            method: "DELETE",
            credentials: "same-origin",
          }).then(refresh);
        }}
        onRetry={() => {
          void (async () => {
            const response = await fetch(config.endpoints.comments, { credentials: "same-origin" });
            state.error = response.ok ? null : "Could not refresh comments.";
            render();
          })();
        }}
        status={state.error === null ? (config.threads.length === 0 ? "empty" : "ready") : "error"}
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
    if (target?.dataset.threadId) {
      state.activeId = target.dataset.threadId;
      repaintMarks();
      measure();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.activeId !== null) {
      state.activeId = null;
      repaintMarks();
      measure();
    }
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
  const bridge = document.querySelector<HTMLScriptElement>("script[data-artiflow-bridge]");
  const nonce = bridge?.dataset.nonce ?? "";
  if (config === null || host === null || frame === null || shell === null || nonce === "") return;
  const root = createRoot(host);
  const budget = createMessageBudget();
  const state = {
    activeId: null as string | null,
    visible: true,
    showResolved: false,
    anchors: {} as Record<string, number>,
    error: null as string | null,
    commenting: false,
    draft: null as { anchor: ElementAnchor } | null,
    busy: false,
  };
  const send = (command: ParentCommand) => {
    frame.contentWindow?.postMessage(encodeCommand(command, nonce), "*");
  };
  const pins = () => pinsOf(config.threads);
  const render = (): void => {
    host.style.display = state.visible ? "block" : "none";
    shell.classList.toggle("comments-visible", state.visible);
    if (!state.visible) send({ type: "mode", on: false });
    root.render(
      <CommentThreadMargin
        threads={config.threads}
        anchors={state.anchors}
        activeId={state.activeId}
        onActivate={(id) => {
          state.activeId = id;
          send({ type: "focus", id });
          render();
        }}
        onResolve={(thread, resolved) => {
          void postJson(
            `${config.endpoints.resolve}/${encodeURIComponent(thread.id)}/${resolved ? "resolve" : "unresolve"}`,
            {},
          ).then(() => window.location.reload());
        }}
        onReply={(thread, body) => {
          void postJson(config.endpoints.comments, { body, parentId: thread.id }).then(() => window.location.reload());
        }}
        onDelete={(thread, reply) => {
          const target = reply ?? thread;
          void fetch(`${config.endpoints.deleteComment}/${encodeURIComponent(target.id)}`, {
            method: "DELETE",
            credentials: "same-origin",
          }).then(() => window.location.reload());
        }}
        onRetry={() => window.location.reload()}
        status={state.error === null ? (config.threads.length === 0 ? "empty" : "ready") : "error"}
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
        draftAnchorTop={0}
        onSubmitDraft={(body) => {
          if (state.draft === null) return;
          state.busy = true;
          render();
          void postJson(config.endpoints.comments, { anchor: state.draft.anchor, body }).then(() => {
            window.location.reload();
          });
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
    if (message.type === "geometry") {
      state.anchors = { ...state.anchors, [message.id]: message.y };
      render();
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
