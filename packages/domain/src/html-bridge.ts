export const BRIDGE_CHANNEL = "artiflow-comments";
export const BRIDGE_VERSION = 1;
export const MAX_BRIDGE_MESSAGES = 600;
export const BRIDGE_BUDGET_WINDOW_MS = 1_000;

export type BridgeNonce = string;

export type ParentCommand =
  | {
      type: "pins";
      pins: { id: string; number: number; selector: string; textHint: string; x: number; y: number; stale: boolean }[];
    }
  | { type: "mode"; on: boolean }
  | { type: "focus"; id: string | null };

export type FrameEvent =
  | { type: "geometry"; id: string; x: number; y: number; visible: boolean }
  | {
      type: "pick";
      selector: string;
      textHint: string;
      x: number;
      y: number;
      viewportWidth: number;
      viewportY: number;
    }
  | { type: "pin-click"; id: string }
  | { type: "ready" };

export type Envelope = { channel: string; version: number; nonce: string };

export type BridgeMessage = Envelope & (ParentCommand | FrameEvent);

export type Structure = {
  getElementById(id: string): unknown;
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): Iterable<unknown>;
  documentElement?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === "string";

const validCommand = (raw: Record<string, unknown>): boolean => {
  switch (raw.type) {
    case "pins":
      return (
        Array.isArray(raw.pins) &&
        raw.pins.length <= 200 &&
        raw.pins.every(
          (pin) =>
            isRecord(pin) &&
            isString(pin.id) &&
            pin.id.length > 0 &&
            typeof pin.number === "number" &&
            Number.isSafeInteger(pin.number) &&
            isString(pin.selector) &&
            isString(pin.textHint) &&
            isFiniteNumber(pin.x) &&
            isFiniteNumber(pin.y) &&
            typeof pin.stale === "boolean",
        )
      );
    case "mode":
      return typeof raw.on === "boolean";
    case "focus":
      return raw.id === null || (isString(raw.id) && raw.id.length > 0);
    case "geometry":
      return (
        isString(raw.id) &&
        raw.id.length > 0 &&
        isFiniteNumber(raw.x) &&
        isFiniteNumber(raw.y) &&
        typeof raw.visible === "boolean"
      );
    case "pick":
      return (
        isString(raw.selector) &&
        raw.selector.length <= 512 &&
        isString(raw.textHint) &&
        raw.textHint.length <= 120 &&
        isFiniteNumber(raw.x) &&
        isFiniteNumber(raw.y) &&
        isFiniteNumber(raw.viewportWidth) &&
        isFiniteNumber(raw.viewportY)
      );
    case "pin-click":
      return isString(raw.id) && raw.id.length > 0;
    case "ready":
      return true;
    default:
      return false;
  }
};

export type ValidationFailure =
  "not-an-object" | "wrong-channel" | "wrong-version" | "wrong-source" | "wrong-nonce" | "budget" | "schema";

export type ValidationResult = { ok: true; message: BridgeMessage } | { ok: false; reason: ValidationFailure };

export function createMessageBudget(
  limit = MAX_BRIDGE_MESSAGES,
  windowMs = BRIDGE_BUDGET_WINDOW_MS,
  now: () => number = () => Date.now(),
): { take(): boolean; used(): number } {
  let used = 0;
  let openedAt = now();
  const roll = (): void => {
    const current = now();
    if (windowMs > 0 && current - openedAt >= windowMs) {
      openedAt = current;
      used = 0;
    }
  };
  return {
    take: () => {
      roll();
      if (used >= limit) return false;
      used += 1;
      return true;
    },
    used: () => {
      roll();
      return used;
    },
  };
}

export function parseBridgeMessage(
  raw: unknown,
  context: { nonce: BridgeNonce; source: unknown; frame: unknown; budget?: { take(): boolean } },
): ValidationResult {
  if (!isRecord(raw)) return { ok: false, reason: "not-an-object" };
  if (context.budget !== undefined && !context.budget.take()) return { ok: false, reason: "budget" };
  if (context.frame !== undefined && context.source !== context.frame) return { ok: false, reason: "wrong-source" };
  if (raw.channel !== BRIDGE_CHANNEL) return { ok: false, reason: "wrong-channel" };
  if (raw.version !== BRIDGE_VERSION) return { ok: false, reason: "wrong-version" };
  if (raw.nonce !== context.nonce) return { ok: false, reason: "wrong-nonce" };
  if (!validCommand(raw)) return { ok: false, reason: "schema" };
  return { ok: true, message: raw as BridgeMessage };
}

export function encodeCommand(command: ParentCommand, nonce: BridgeNonce): BridgeMessage {
  return { channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, nonce, ...command };
}

export const FORBIDDEN_PAYLOAD_KEYS = ["body", "quotedText", "author", "text", "comment"] as const;

export function commandCarriesCommentText(command: ParentCommand): boolean {
  const json = JSON.stringify(command);
  return FORBIDDEN_PAYLOAD_KEYS.some((key) => json.includes(`"${key}"`));
}

export type ElementLike = {
  id?: string;
  textContent?: string | null;
  getAttribute?(name: string): string | null;
  querySelectorAll?(selector: string): Iterable<ElementLike>;
  matches?(selector: string): boolean;
  tagName?: string;
};

export type PickedAnchor = { selector: string; textHint: string };

const HINT_LIMIT = 120;
const TEXT_HINTS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "p",
  "li",
  "td",
  "th",
  "figcaption",
  "blockquote",
  "button",
  "a",
  "span",
  "div",
];
const SKIP_TAGS = new Set(["html", "head", "body", "script", "style", "meta", "link", "title"]);

const isCandidate = (element: ElementLike): boolean =>
  !SKIP_TAGS.has((element.tagName ?? "").toLowerCase()) && (element.textContent ?? "").trim().length > 0;

export function describeElement(element: ElementLike): PickedAnchor {
  const id = element.id ?? "";
  if (id !== "") return { selector: `#${cssEscape(id)}`, textHint: "" };
  const attribute = ["data-block", "data-testid", "data-widget", "data-section", "aria-label"]
    .map((name) => ({ name, value: element.getAttribute?.(name) ?? null }))
    .find((entry) => entry.value !== null && entry.value !== "");
  if (attribute !== undefined && attribute.value !== null)
    return { selector: `[${attribute.name}="${cssString(attribute.value)}"]`, textHint: "" };
  const hint = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, HINT_LIMIT);
  return { selector: "", textHint: isCandidate(element) ? hint : "" };
}

export const cssEscape = (value: string): string => {
  const characters = [...value];
  return characters
    .map((character, index) => {
      const code = character.codePointAt(0) ?? 0;
      const leadingDigit = index === 0 && code >= 0x30 && code <= 0x39;
      const secondDigitAfterDash = index === 1 && code >= 0x30 && code <= 0x39 && characters[0] === "-";
      if (code === 0) return "\uFFFD";
      if ((code >= 0x01 && code <= 0x1f) || code === 0x7f || leadingDigit || secondDigitAfterDash)
        return `\\${code.toString(16)} `;
      if (
        code >= 0x80 ||
        code === 0x2d ||
        code === 0x5f ||
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a)
      )
        return character;
      return `\\${character}`;
    })
    .join("");
};

export const cssString = (value: string): string =>
  [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (character === '"' || character === "\\") return `\\${character}`;
      if (character === "\n") return "\\a ";
      if (code < 0x20 || code === 0x7f) return `\\${code.toString(16)} `;
      return character;
    })
    .join("");

export type Resolution = { status: "resolved"; element: ElementLike } | { status: "missing" } | { status: "ambiguous" };

export function resolveElement(root: Structure, anchor: { selector: string; textHint: string }): Resolution {
  const selector = anchor.selector.trim();
  if (selector.startsWith("#")) {
    const element = root.getElementById(selector.slice(1)) as ElementLike | null;
    return element === null ? { status: "missing" } : { status: "resolved", element };
  }
  if (selector.startsWith("[")) {
    const matches = [...root.querySelectorAll(selector)] as ElementLike[];
    return matches.length === 1
      ? { status: "resolved", element: matches[0]! }
      : matches.length === 0
        ? { status: "missing" }
        : { status: "ambiguous" };
  }
  const hint = anchor.textHint.replace(/\s+/g, " ").trim();
  if (hint === "") return { status: "missing" };
  const candidates = ([...root.querySelectorAll(TEXT_HINTS.join(","))] as ElementLike[]).filter(
    (element) => (element.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(hint) && isCandidate(element),
  );
  return candidates.length === 1
    ? { status: "resolved", element: candidates[0]! }
    : candidates.length === 0
      ? { status: "missing" }
      : { status: "ambiguous" };
}

export const pointInBox = (
  box: { left: number; top: number; width: number; height: number },
  at: { x: number; y: number },
) => ({
  x: box.width === 0 ? 0 : Math.min(1, Math.max(0, (at.x - box.left) / box.width)),
  y: box.height === 0 ? 0 : Math.min(1, Math.max(0, (at.y - box.top) / box.height)),
});
