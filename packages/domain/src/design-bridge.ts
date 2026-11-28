import { MAX_REQUEST_TEXT, parseArtboardSelection, type ArtboardSelection } from "./design-request.ts";

export const DESIGN_BRIDGE_CHANNEL = "artiflow-design-request";
export const DESIGN_BRIDGE_VERSION = 1;
export const DESIGN_ID_MAX_LENGTH = 200;
export const DESIGN_REQUEST_ID_MAX_LENGTH = 200;

export type DesignSubmit = {
  readonly type: "submit";
  readonly frameId: string;
  readonly revisionId: string;
  readonly selection: ArtboardSelection;
  readonly body: string;
};

export type DesignResult = {
  readonly type: "result";
  readonly requestId: string | null;
  readonly error: string | null;
};

export type DesignEnvelope = { channel: string; version: number; nonce: string };
export type DesignSubmitMessage = DesignEnvelope & DesignSubmit;
export type DesignResultMessage = DesignEnvelope & DesignResult;

export type DesignFailure =
  "not-an-object" | "wrong-source" | "wrong-channel" | "wrong-version" | "wrong-nonce" | "schema";

export type DesignParseResult<T> =
  { readonly ok: true; readonly message: T } | { readonly ok: false; readonly reason: DesignFailure };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const hasControlCharacter = (value: string, allowNewlines = false): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || (allowNewlines && code === 10)) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
};
const boundedId = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= max && !hasControlCharacter(value) ? value : null;

const SUBMIT_KEYS = ["channel", "version", "nonce", "type", "frameId", "revisionId", "selection", "body"];
const RESULT_KEYS = ["channel", "version", "nonce", "type", "requestId", "error"];

const envelopeOf = (
  raw: Record<string, unknown>,
  context: { nonce: string; source: unknown; frame?: unknown },
): DesignFailure | null => {
  if (context.frame !== undefined && context.source !== context.frame) return "wrong-source";
  if (raw.channel !== DESIGN_BRIDGE_CHANNEL) return "wrong-channel";
  if (raw.version !== DESIGN_BRIDGE_VERSION) return "wrong-version";
  if (raw.nonce !== context.nonce) return "wrong-nonce";
  return null;
};

export function parseDesignSubmit(
  raw: unknown,
  context: { nonce: string; source: unknown; frame: unknown },
): DesignParseResult<DesignSubmitMessage> {
  if (!isRecord(raw)) return { ok: false, reason: "not-an-object" };
  const envelope = envelopeOf(raw, context);
  if (envelope !== null) return { ok: false, reason: envelope };
  if (raw.type !== "submit" || !onlyKeys(raw, SUBMIT_KEYS)) return { ok: false, reason: "schema" };
  const frameId = boundedId(raw.frameId, DESIGN_ID_MAX_LENGTH);
  const revisionId = boundedId(raw.revisionId, DESIGN_ID_MAX_LENGTH);
  const selection = parseArtboardSelection(raw.selection);
  const body = typeof raw.body === "string" ? raw.body.replace(/\r\n/g, "\n").trim() : "";
  if (frameId === null || revisionId === null) return { ok: false, reason: "schema" };
  if (!selection.ok) return { ok: false, reason: "schema" };
  if (body === "" || body.length > MAX_REQUEST_TEXT || hasControlCharacter(body, true))
    return { ok: false, reason: "schema" };
  return {
    ok: true,
    message: {
      channel: DESIGN_BRIDGE_CHANNEL,
      version: DESIGN_BRIDGE_VERSION,
      nonce: context.nonce,
      type: "submit",
      frameId,
      revisionId,
      selection: selection.value,
      body,
    },
  };
}

export function parseDesignResult(
  raw: unknown,
  context: { nonce: string; source: unknown; frame?: unknown },
): DesignParseResult<DesignResultMessage> {
  if (!isRecord(raw)) return { ok: false, reason: "not-an-object" };
  const envelope = envelopeOf(raw, context);
  if (envelope !== null) return { ok: false, reason: envelope };
  if (raw.type !== "result" || !onlyKeys(raw, RESULT_KEYS)) return { ok: false, reason: "schema" };
  const requestId = raw.requestId === null ? null : boundedId(raw.requestId, DESIGN_REQUEST_ID_MAX_LENGTH);
  const error = raw.error === null ? null : boundedId(raw.error, DESIGN_REQUEST_ID_MAX_LENGTH);
  if ((requestId === null) === (error === null)) return { ok: false, reason: "schema" };
  return {
    ok: true,
    message: {
      channel: DESIGN_BRIDGE_CHANNEL,
      version: DESIGN_BRIDGE_VERSION,
      nonce: context.nonce,
      type: "result",
      requestId,
      error,
    },
  };
}

export const encodeDesignSubmit = (message: Omit<DesignSubmit, "type">, nonce: string): DesignSubmitMessage => ({
  channel: DESIGN_BRIDGE_CHANNEL,
  version: DESIGN_BRIDGE_VERSION,
  nonce,
  type: "submit",
  ...message,
});

export const encodeDesignResult = (message: Omit<DesignResult, "type">, nonce: string): DesignResultMessage => ({
  channel: DESIGN_BRIDGE_CHANNEL,
  version: DESIGN_BRIDGE_VERSION,
  nonce,
  type: "result",
  ...message,
});
