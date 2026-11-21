export type ShortcutAction = "next" | "previous" | "reply" | "close";

export type ShortcutInput = {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  editable: boolean;
  insideComments?: boolean;
  composing?: boolean;
};

const KEY_ACTIONS: Record<string, ShortcutAction> = {
  j: "next",
  k: "previous",
  r: "reply",
};

export function shortcutFor(input: ShortcutInput): ShortcutAction | null {
  if (input.composing === true) return null;
  if (input.defaultPrevented === true) return null;
  if (input.altKey === true || input.ctrlKey === true || input.metaKey === true || input.shiftKey === true) return null;
  if (input.key === "Escape") return input.editable && input.insideComments !== true ? null : "close";
  if (input.editable) return null;
  return KEY_ACTIONS[input.key.toLowerCase()] ?? null;
}

type TargetLike = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};

const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

export function isEditableTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as TargetLike;
  if (element.isContentEditable === true) return true;
  const tag = element.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return typeof element.closest === "function" && element.closest(EDITABLE_SELECTOR) !== null;
}

export function stepThread(order: string[], activeId: string | null, delta: 1 | -1): string | null {
  if (order.length === 0) return null;
  const index = activeId === null ? -1 : order.indexOf(activeId);
  if (index < 0) return delta === 1 ? order[0]! : order[order.length - 1]!;
  const next = Math.min(order.length - 1, Math.max(0, index + delta));
  return order[next]!;
}

const HASH_PATTERN = /^#c-([A-Za-z0-9_.~%-]{1,128})$/;

export function parseThreadHash(hash: string): string | null {
  const match = HASH_PATTERN.exec(hash);
  if (match === null) return null;
  try {
    const id = decodeURIComponent(match[1]!);
    return id === "" ? null : id;
  } catch {
    return null;
  }
}

export const formatThreadHash = (id: string): string => `#c-${encodeURIComponent(id)}`;

export const revealCommentsForHash = (storedVisible: boolean, hash: string): boolean =>
  storedVisible || parseThreadHash(hash) !== null;

export function threadHashUrl(href: string, id: string | null): string {
  const hashAt = href.indexOf("#");
  const base = hashAt < 0 ? href : href.slice(0, hashAt);
  const current = hashAt < 0 ? "" : href.slice(hashAt);
  if (id === null) return parseThreadHash(current) === null ? href : base;
  return `${base}${formatThreadHash(id)}`;
}

export function resolveDeepLink(hash: string, knownIds: Iterable<string>): string | null {
  const id = parseThreadHash(hash);
  if (id === null) return null;
  for (const known of knownIds) if (known === id) return id;
  return null;
}
