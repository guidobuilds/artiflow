import { MAX_SELECTION_HINT, MAX_SELECTION_SELECTOR } from "./html-bridge.ts";
import type { Scene, SceneFrame, SceneRefusal, SceneRefusalDetail, TextAlign } from "./scene.ts";

export const SCENE_MAX_OVERRIDES = 40;
export const SCENE_MAX_OVERRIDE_TEXT = 400;
export const SCENE_OVERRIDE_SPACING_MAX = 96;
export const SCENE_OVERRIDE_FONT_SIZE_MIN = 6;
export const SCENE_OVERRIDE_FONT_SIZE_MAX = 200;
export const SCENE_OVERRIDE_COLOR_MAX = 32;

export const SCENE_OVERRIDE_FRAME_KEYS = ["sourceRevisionId", "entries", "variant"] as const;
export const SCENE_OVERRIDE_KEYS = ["key", "selector", "textHint", "text", "style"] as const;
export const SCENE_OVERRIDE_STYLE_KEYS = ["color", "fontSize", "align", "spacing"] as const;
export const SCENE_VARIANTS = ["compact", "comfortable", "spacious", "warm", "cool"] as const;

export type SceneVariantId = (typeof SCENE_VARIANTS)[number];

const OVERRIDE_ALIGNS = ["left", "center", "right"] as const satisfies readonly TextAlign[];

export type SceneOverrideTarget = { selector: string; textHint: string };

export type SceneOverrideStyle = {
  color?: string;
  fontSize?: number;
  align?: TextAlign;
  spacing?: number;
};

export type SceneOverride = SceneOverrideTarget & {
  key: string;
  text?: string;
  style?: SceneOverrideStyle;
};

export type SceneFrameOverrides = {
  sourceRevisionId: string;
  entries: SceneOverride[];
  variant?: SceneVariantId;
};

export type SceneOverrideStatus = "absent" | "current" | "stale";

export type AppliedOverride = {
  key: string;
  selector: string;
  textHint: string;
  text?: string;
  style: SceneOverrideStyle;
};

export const elementKeyOf = (target: SceneOverrideTarget): string => {
  const selector = target.selector.trim();
  return selector === "" ? `text:${target.textHint.trim()}` : `node:${selector}`;
};

export const isEditableTarget = (target: SceneOverrideTarget): boolean =>
  target.selector.trim() !== "" || target.textHint.trim() !== "";

const RESOLVABLE_ID = /^#[A-Za-z_\u0080-\uffff][-A-Za-z0-9_\u0080-\uffff]*$/;
const RESOLVABLE_ATTRIBUTE = /^\[\s*[A-Za-z_][-A-Za-z0-9_:.]*\s*(?:=\s*"[^"\\]*"\s*)?\]$/;

export const isResolvableLocator = (target: SceneOverrideTarget): boolean => {
  const selector = target.selector.trim();
  if (selector !== "") return RESOLVABLE_ID.test(selector) || RESOLVABLE_ATTRIBUTE.test(selector);
  return target.textHint.trim() !== "";
};

export const SCENE_VARIANT_PRESETS: Record<SceneVariantId, SceneOverrideStyle> = {
  compact: { fontSize: 13, spacing: 0 },
  comfortable: { fontSize: 15, spacing: 2 },
  spacious: { fontSize: 17, spacing: 8 },
  warm: { color: "#ff6a2b" },
  cool: { color: "#2f6fed" },
};

export const isSceneVariant = (value: unknown): value is SceneVariantId =>
  typeof value === "string" && (SCENE_VARIANTS as readonly string[]).includes(value);

export const variantStyleOf = (variant: SceneVariantId | undefined): SceneOverrideStyle =>
  variant === undefined ? {} : { ...SCENE_VARIANT_PRESETS[variant] };

export const resolvedStyleOf = (entry: SceneOverride, variant: SceneVariantId | undefined): SceneOverrideStyle => ({
  ...variantStyleOf(variant),
  ...entry.style,
});

export const overridesStatusOf = (frame: Pick<SceneFrame, "source" | "overrides">): SceneOverrideStatus => {
  if (frame.overrides === undefined) return "absent";
  if (frame.source === undefined) return "stale";
  return frame.source.revisionId === frame.overrides.sourceRevisionId ? "current" : "stale";
};

export const appliedOverridesOf = (frame: Pick<SceneFrame, "source" | "overrides">): AppliedOverride[] => {
  if (frame.overrides === undefined || overridesStatusOf(frame) !== "current") return [];
  return frame.overrides.entries.map((entry) => ({
    key: entry.key,
    selector: entry.selector,
    textHint: entry.textHint,
    text: entry.text,
    style: resolvedStyleOf(entry, frame.overrides?.variant),
  }));
};

const COLOR_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FUNCTION =
  /^(?:rgba?|hsla?)\(\s*-?[0-9]+(?:\.[0-9]+)?(?:deg|%)?(?:\s*[,\s]\s*-?[0-9]+(?:\.[0-9]+)?(?:deg|%)?){2,3}\s*\)$/i;
const COLOR_KEYWORDS = new Set(["transparent", "currentcolor", "black", "white"]);

export const isSceneOverrideColor = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= SCENE_OVERRIDE_COLOR_MAX &&
  (COLOR_HEX.test(value) || COLOR_FUNCTION.test(value) || COLOR_KEYWORDS.has(value.toLowerCase()));

export const isSceneOverrideText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= SCENE_MAX_OVERRIDE_TEXT;

export const isSceneOverrideFontSize = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= SCENE_OVERRIDE_FONT_SIZE_MIN &&
  value <= SCENE_OVERRIDE_FONT_SIZE_MAX;

export const isSceneOverrideSpacing = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= SCENE_OVERRIDE_SPACING_MAX;

export const isSceneOverrideAlign = (value: unknown): value is TextAlign =>
  (OVERRIDE_ALIGNS as readonly unknown[]).includes(value);

export type SceneOverrideStyleIssue = "color" | "fontSize" | "align" | "spacing";

export const sceneOverrideStyleIssueOf = (style: SceneOverrideStyle): SceneOverrideStyleIssue | null => {
  if (style.color !== undefined && !isSceneOverrideColor(style.color)) return "color";
  if (style.fontSize !== undefined && !isSceneOverrideFontSize(style.fontSize)) return "fontSize";
  if (style.align !== undefined && !isSceneOverrideAlign(style.align)) return "align";
  if (style.spacing !== undefined && !isSceneOverrideSpacing(style.spacing)) return "spacing";
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const refusal = (reason: SceneRefusal["reason"], path: string, detail: SceneRefusalDetail = {}): SceneRefusal => ({
  ok: false,
  reason,
  path,
  detail,
});

const unknownKeyOf = (record: Record<string, unknown>, allowed: readonly string[]): string | null =>
  Object.keys(record).find((key) => !allowed.includes(key)) ?? null;

function styleRefusalOf(value: unknown, where: string): SceneRefusal | null {
  if (!isRecord(value)) return refusal("invalid_override", where, { property: "style" });
  const unknown = unknownKeyOf(value, SCENE_OVERRIDE_STYLE_KEYS);
  if (unknown !== null) return refusal("unsupported_property", `${where}.${unknown}`, { property: unknown });
  if (value.color !== undefined && !isSceneOverrideColor(value.color))
    return refusal("invalid_override", `${where}.color`, { property: "color" });
  if (value.fontSize !== undefined && !isSceneOverrideFontSize(value.fontSize))
    return refusal("invalid_override", `${where}.fontSize`, { property: "fontSize" });
  if (value.align !== undefined && !isSceneOverrideAlign(value.align))
    return refusal("invalid_override", `${where}.align`, { property: "align" });
  if (value.spacing !== undefined && !isSceneOverrideSpacing(value.spacing))
    return refusal("invalid_override", `${where}.spacing`, { property: "spacing" });
  return null;
}

function entryRefusalOf(value: unknown, where: string): SceneRefusal | null {
  if (!isRecord(value)) return refusal("invalid_override", where, { property: "entry" });
  const unknown = unknownKeyOf(value, SCENE_OVERRIDE_KEYS);
  if (unknown !== null) return refusal("unsupported_property", `${where}.${unknown}`, { property: unknown });
  for (const field of ["key", "selector", "textHint"] as const)
    if (typeof value[field] !== "string") return refusal("invalid_override", `${where}.${field}`, { property: field });
  const target = { selector: value.selector as string, textHint: value.textHint as string };
  if (!isEditableTarget(target)) return refusal("invalid_override", `${where}.selector`, { property: "selector" });
  if (!isResolvableLocator(target)) return refusal("invalid_override", `${where}.selector`, { property: "selector" });
  if (target.selector.length > MAX_SELECTION_SELECTOR)
    return refusal("invalid_override", `${where}.selector`, { property: "selector", limit: MAX_SELECTION_SELECTOR });
  if (target.textHint.length > MAX_SELECTION_HINT)
    return refusal("invalid_override", `${where}.textHint`, { property: "textHint", limit: MAX_SELECTION_HINT });
  if (value.key !== elementKeyOf(target)) return refusal("invalid_override", `${where}.key`, { property: "key" });
  if (value.text !== undefined && !isSceneOverrideText(value.text))
    return refusal("invalid_override", `${where}.text`, { property: "text", limit: SCENE_MAX_OVERRIDE_TEXT });
  if (value.style !== undefined) {
    const style = styleRefusalOf(value.style, `${where}.style`);
    if (style !== null) return style;
  }
  return null;
}

export function overridesRefusal(value: unknown, where: string): SceneRefusal | null {
  if (!isRecord(value)) return refusal("invalid_override", where);
  const unknown = unknownKeyOf(value, SCENE_OVERRIDE_FRAME_KEYS);
  if (unknown !== null) return refusal("unsupported_property", `${where}.${unknown}`, { property: unknown });
  if (typeof value.sourceRevisionId !== "string" || value.sourceRevisionId === "")
    return refusal("invalid_override", `${where}.sourceRevisionId`, { property: "sourceRevisionId" });
  if (!Array.isArray(value.entries)) return refusal("invalid_override", `${where}.entries`, { property: "entries" });
  if (value.entries.length > SCENE_MAX_OVERRIDES)
    return refusal("invalid_override", `${where}.entries`, { property: "entries", limit: SCENE_MAX_OVERRIDES });
  const keys = new Set<string>();
  for (let index = 0; index < value.entries.length; index += 1) {
    const at = `${where}.entries[${index}]`;
    const issue = entryRefusalOf(value.entries[index], at);
    if (issue !== null) return issue;
    const key = (value.entries[index] as SceneOverride).key;
    if (keys.has(key)) return refusal("invalid_override", `${at}.key`, { property: key });
    keys.add(key);
  }
  if (value.variant !== undefined && !isSceneVariant(value.variant))
    return refusal("invalid_override", `${where}.variant`, { property: "variant" });
  return null;
}

const withFrame = (scene: Scene, frameId: string, change: (frame: SceneFrame) => SceneFrame): Scene => {
  const index = scene.frames.findIndex((frame) => frame.id === frameId);
  if (index === -1) return scene;
  const frame = scene.frames[index] as SceneFrame;
  const next = change(frame);
  if (next === frame) return scene;
  const frames = scene.frames.slice();
  frames[index] = next;
  return { ...scene, frames };
};

export const setFrameOverrides = (scene: Scene, frameId: string, overrides: SceneFrameOverrides | null): Scene =>
  withFrame(scene, frameId, (frame) => {
    if (overrides === null) {
      if (frame.overrides === undefined) return frame;
      const cleared: SceneFrame = { ...frame };
      delete cleared.overrides;
      return cleared;
    }
    if (sameOverrides(frame.overrides, overrides)) return frame;
    return { ...frame, overrides };
  });

export const setFrameVariant = (scene: Scene, frameId: string, variant: SceneVariantId | null): Scene =>
  withFrame(scene, frameId, (frame) => {
    if (frame.overrides === undefined) return frame;
    if ((frame.overrides.variant ?? null) === variant) return frame;
    const overrides: SceneFrameOverrides = { ...frame.overrides };
    if (variant === null) delete overrides.variant;
    else overrides.variant = variant;
    return { ...frame, overrides };
  });

const sameStyle = (left: SceneOverrideStyle, right: SceneOverrideStyle): boolean =>
  (left.color ?? null) === (right.color ?? null) &&
  (left.fontSize ?? null) === (right.fontSize ?? null) &&
  (left.align ?? null) === (right.align ?? null) &&
  (left.spacing ?? null) === (right.spacing ?? null);

const sameEntry = (left: SceneOverride, right: SceneOverride): boolean =>
  left.key === right.key &&
  left.selector === right.selector &&
  left.textHint === right.textHint &&
  (left.text ?? null) === (right.text ?? null) &&
  sameStyle(left.style ?? {}, right.style ?? {});

const sameOverrides = (left: SceneFrameOverrides | undefined, right: SceneFrameOverrides): boolean =>
  left !== undefined &&
  left.sourceRevisionId === right.sourceRevisionId &&
  (left.variant ?? null) === (right.variant ?? null) &&
  left.entries.length === right.entries.length &&
  left.entries.every((entry, index) => {
    const other = right.entries[index];
    return other !== undefined && sameEntry(entry, other);
  });

const baseOverridesOf = (frame: SceneFrame): SceneFrameOverrides | null => {
  if (frame.source === undefined) return null;
  if (frame.overrides === undefined) return { sourceRevisionId: frame.source.revisionId, entries: [] };
  if (overridesStatusOf(frame) === "stale")
    return {
      sourceRevisionId: frame.source.revisionId,
      entries: frame.overrides.entries,
      ...(frame.overrides.variant === undefined ? {} : { variant: frame.overrides.variant }),
    };
  return frame.overrides;
};

export const addFrameOverride = (scene: Scene, frameId: string, target: SceneOverrideTarget): Scene =>
  withFrame(scene, frameId, (frame) => {
    const base = baseOverridesOf(frame);
    if (base === null) return frame;
    if (!isResolvableLocator(target)) return frame;
    const key = elementKeyOf(target);
    if (base.entries.some((entry) => entry.key === key)) return frame;
    if (base.entries.length >= SCENE_MAX_OVERRIDES) return frame;
    const entry: SceneOverride = { key, selector: target.selector, textHint: target.textHint };
    return { ...frame, overrides: { ...base, entries: [...base.entries, entry] } };
  });

const patchedEntry = (entry: SceneOverride, patch: { text?: string; style?: SceneOverrideStyle }): SceneOverride => {
  const next: SceneOverride = { ...entry };
  if (patch.text !== undefined && isSceneOverrideText(patch.text)) next.text = patch.text;
  if (patch.style !== undefined) {
    const style: SceneOverrideStyle = { ...entry.style };
    if (isSceneOverrideColor(patch.style.color)) style.color = patch.style.color;
    if (isSceneOverrideFontSize(patch.style.fontSize)) style.fontSize = patch.style.fontSize;
    if (isSceneOverrideAlign(patch.style.align)) style.align = patch.style.align;
    if (isSceneOverrideSpacing(patch.style.spacing)) style.spacing = patch.style.spacing;
    if (Object.keys(style).length > 0) next.style = style;
  }
  return next;
};

export const patchFrameOverride = (
  scene: Scene,
  frameId: string,
  key: string,
  patch: { text?: string; style?: SceneOverrideStyle },
): Scene =>
  withFrame(scene, frameId, (frame) => {
    if (frame.overrides === undefined) return frame;
    const entry = frame.overrides.entries.find((candidate) => candidate["key"] === key);
    if (entry === undefined) return frame;
    const next = patchedEntry(entry, patch);
    if (sameEntry(entry, next)) return frame;
    const base = baseOverridesOf(frame);
    if (base === null) return frame;
    return {
      ...frame,
      overrides: { ...base, entries: base.entries.map((candidate) => (candidate["key"] === key ? next : candidate)) },
    };
  });

export const removeFrameOverride = (scene: Scene, frameId: string, key: string): Scene =>
  withFrame(scene, frameId, (frame) => {
    if (frame.overrides === undefined) return frame;
    const entries = frame.overrides.entries.filter((entry) => entry["key"] !== key);
    if (entries.length === frame.overrides.entries.length) return frame;
    if (entries.length > 0 || frame.overrides.variant !== undefined)
      return { ...frame, overrides: { ...frame.overrides, entries } };
    const next: SceneFrame = { ...frame };
    delete next.overrides;
    return next;
  });
