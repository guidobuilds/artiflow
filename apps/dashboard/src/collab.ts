import { WebsocketProvider } from "y-websocket";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

export const COLLAB_PATH = "/api/collab";
export const COLLAB_CONNECT_TIMEOUT_MS = 4_000;
export const COLLAB_UNAVAILABLE_MESSAGE =
  "Live collaboration is unavailable right now. Your edits are still saved automatically.";
export const COLLAB_REFUSED_MESSAGE =
  "Live collaboration was refused for this document. Your edits are saved automatically only if your permissions allow it.";

export const PRESENCE_PALETTE = [
  "#2f6fd0",
  "#d0475f",
  "#2f9e6b",
  "#a45bd8",
  "#c47d15",
  "#1f8fa8",
  "#d15fa3",
  "#5b7a24",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export type PresenceUser = { id: string; name: string; color: string };

export type CollabFallback = { reason: "unavailable" | "refused"; message: string; code?: number };

export type CollabSession = {
  doc: Y.Doc;
  awareness: Awareness;
  user: PresenceUser;
  url: string;
  subscribe: (listener: (fallback: CollabFallback) => void) => () => void;
  destroy: () => void;
};

export type CollabOutcome = { ok: true; session: CollabSession } | { ok: false; fallback: CollabFallback };

export type OpenCollabInput = {
  artifactId: string;
  origin: string;
  user: { id: string; name: string };
  timeoutMs?: number;
  websocket?: unknown;
};

export type CursorMarkup = {
  tag: string;
  className: string;
  style: Record<string, string>;
  text?: string;
  children: CursorMarkup[];
};

export const isArtifactId = (value: string): boolean => UUID_RE.test(value);

export function collabBaseUrl(origin: string): string {
  const url = new URL(COLLAB_PATH, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const base = url.toString();
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export function collabSocketUrl(origin: string, artifactId: string): string {
  if (!isArtifactId(artifactId)) throw new Error("A collaboration socket needs a uuid artifact id.");
  return `${collabBaseUrl(origin)}/${artifactId}`;
}

export function presenceColor(userId: string): string {
  let hash = FNV_OFFSET;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return PRESENCE_PALETTE[hash % PRESENCE_PALETTE.length] as string;
}

export function presenceFor(user: { id: string; name: string }): PresenceUser {
  const name = user.name.trim();
  return { id: user.id, name: name === "" ? "Someone" : name, color: presenceColor(user.id) };
}

export function presenceCursor(user: { name: string; color: string }): CursorMarkup {
  return {
    tag: "span",
    className: "collaboration-carets__caret",
    style: {
      position: "relative",
      borderLeft: `2px solid ${user.color}`,
      marginLeft: "-1px",
      marginRight: "-1px",
      pointerEvents: "none",
      wordBreak: "normal",
    },
    children: [
      {
        tag: "div",
        className: "collaboration-carets__label",
        style: {
          position: "absolute",
          top: "-1.45em",
          left: "-1px",
          padding: "1px 4px",
          borderRadius: "3px",
          color: "#ffffff",
          backgroundColor: user.color,
          fontSize: "11px",
          lineHeight: "1.3",
          fontWeight: "600",
          whiteSpace: "nowrap",
          userSelect: "none",
          pointerEvents: "none",
        },
        text: user.name,
        children: [],
      },
    ],
  };
}

export function presenceSelection(user: { color: string }): { nodeName: string; class: string; style: string } {
  return {
    nodeName: "span",
    class: "collaboration-carets__selection",
    style: `background-color: ${user.color}33`,
  };
}

const refusedFallback = (code: number, reason: string): CollabFallback => ({
  reason: "refused",
  message: `${COLLAB_REFUSED_MESSAGE} (${[String(code), reason].filter((part) => part !== "").join(" · ")})`,
  code,
});

export function openCollabSession(input: OpenCollabInput): Promise<CollabOutcome> {
  if (!isArtifactId(input.artifactId))
    return Promise.resolve({ ok: false, fallback: { reason: "unavailable", message: COLLAB_UNAVAILABLE_MESSAGE } });

  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const user = presenceFor(input.user);
  awareness.setLocalStateField("user", user);

  const provider = new WebsocketProvider(collabBaseUrl(input.origin), input.artifactId, doc, {
    awareness,
    disableBc: true,
    ...(input.websocket === undefined ? {} : { WebSocketPolyfill: input.websocket as never }),
  });

  const listeners = new Set<(fallback: CollabFallback) => void>();

  return new Promise<CollabOutcome>((resolve) => {
    let settled = false;
    const abandon = (fallback: CollabFallback): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detach();
      provider.destroy();
      awareness.destroy();
      doc.destroy();
      resolve({ ok: false, fallback });
    };
    const onSync = (synced: boolean): void => {
      if (!synced || settled) return;
      settled = true;
      clearTimeout(timer);
      detach();
      provider.on("closed", onClosed);
      resolve({
        ok: true,
        session: {
          doc,
          awareness,
          user,
          url: provider.url,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          destroy: () => {
            listeners.clear();
            provider.off("closed", onClosed);
            provider.destroy();
            awareness.destroy();
            doc.destroy();
          },
        },
      });
    };
    const onError = (): void => abandon({ reason: "unavailable", message: COLLAB_UNAVAILABLE_MESSAGE });
    const onClosed = ({ code, reason }: { code: number; reason: string }): void => {
      const fallback = refusedFallback(code, reason ?? "");
      if (!settled) abandon(fallback);
      else for (const listener of [...listeners]) listener(fallback);
    };
    const detach = (): void => {
      provider.off("sync", onSync);
      provider.off("connection-error", onError);
      provider.off("closed", onClosed);
    };
    const timer = setTimeout(
      () => abandon({ reason: "unavailable", message: COLLAB_UNAVAILABLE_MESSAGE }),
      input.timeoutMs ?? COLLAB_CONNECT_TIMEOUT_MS,
    );
    provider.on("sync", onSync);
    provider.on("connection-error", onError);
    provider.on("closed", onClosed);
  });
}
