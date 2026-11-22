export const SCENE_FORMAT_VERSION = 1;
export const SCENE_MAX_FRAMES = 200;
export const SCENE_MAX_NODES = 2000;
export const SCENE_MAX_DEPTH = 2;

export const NODE_TYPES = ["rect", "text", "image", "path"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const TEXT_ALIGNS = ["left", "center", "right"] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

export const SCENE_UNSUPPORTED_PROPERTIES = ["layout", "constraints", "componentId"] as const;

export type SceneUnknowns = { readonly [property: string]: unknown };

export type TextStyle = {
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  align?: TextAlign;
} & SceneUnknowns;

type NodeGeometry = { id: string; x: number; y: number; w: number; h: number };

export type RectNode = NodeGeometry & { type: "rect"; fill: string; radius?: number } & SceneUnknowns;
export type TextNode = NodeGeometry & { type: "text"; text: string; style?: TextStyle } & SceneUnknowns;
export type ImageNode = NodeGeometry & { type: "image"; assetId: string } & SceneUnknowns;
export type PathNode = NodeGeometry & {
  type: "path";
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
} & SceneUnknowns;
export type SceneNode = RectNode | TextNode | ImageNode | PathNode;

export type SceneFrame = {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  nodes: SceneNode[];
} & SceneUnknowns;

export type Scene = { formatVersion: number; frames: SceneFrame[] } & SceneUnknowns;

export type SceneRefusalReason =
  | "malformed_scene"
  | "missing_format_version"
  | "unsupported_format_version"
  | "unknown_node_type"
  | "duplicate_id"
  | "outside_frame_bounds"
  | "non_finite_number"
  | "unsupported_property"
  | "too_deep"
  | "node_limit"
  | "frame_limit";

export type SceneRefusalDetail = {
  version?: number;
  type?: string;
  id?: string;
  frameId?: string;
  property?: string;
  limit?: number;
  depth?: number;
};

export type SceneRefusal = { ok: false; reason: SceneRefusalReason; path: string; detail: SceneRefusalDetail };
export type SceneResult<T> = { ok: true; value: T } | SceneRefusal;

export type SceneBBox = { x: number; y: number; w: number; h: number };
export type SceneNodeLocation = { frameId: string; type: NodeType; x: number; y: number; w: number; h: number };
export type SceneNodeIndex = Record<string, SceneNodeLocation>;
export type SceneOutlineEntry = { id: string; name: string; nodeCount: number; bbox: SceneBBox };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isNodeType = (value: unknown): value is NodeType =>
  typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);

const refusal = (reason: SceneRefusalReason, path: string, detail: SceneRefusalDetail = {}): SceneRefusal => ({
  ok: false,
  reason,
  path,
  detail,
});

const unsupportedPropertyOf = (record: Record<string, unknown>): string | null =>
  SCENE_UNSUPPORTED_PROPERTIES.find((property) => property in record) ?? null;

const GEOMETRY_KEYS = ["x", "y", "w", "h"] as const;

function styleRefusal(style: unknown, where: string): SceneRefusal | null {
  if (style === undefined) return null;
  if (!isRecord(style)) return refusal("malformed_scene", where);
  if (style.fontSize !== undefined && !(finite(style.fontSize) && style.fontSize > 0))
    return refusal("malformed_scene", `${where}.fontSize`);
  if (
    style.fontWeight !== undefined &&
    !(
      Number.isSafeInteger(style.fontWeight) &&
      (style.fontWeight as number) >= 1 &&
      (style.fontWeight as number) <= 1000
    )
  )
    return refusal("malformed_scene", `${where}.fontWeight`);
  if (style.color !== undefined && typeof style.color !== "string") return refusal("malformed_scene", `${where}.color`);
  if (style.align !== undefined && !TEXT_ALIGNS.includes(style.align as TextAlign))
    return refusal("malformed_scene", `${where}.align`);
  return null;
}

function nodeShapeRefusal(node: Record<string, unknown>, where: string): SceneRefusal | null {
  if (node.type === "rect") {
    if (typeof node.fill !== "string" || node.fill === "") return refusal("malformed_scene", `${where}.fill`);
    if (node.radius !== undefined && !(finite(node.radius) && node.radius >= 0))
      return refusal("malformed_scene", `${where}.radius`);
    return null;
  }
  if (node.type === "text") {
    if (typeof node.text !== "string") return refusal("malformed_scene", `${where}.text`);
    return styleRefusal(node.style, `${where}.style`);
  }
  if (node.type === "image") {
    if (!isId(node.assetId)) return refusal("malformed_scene", `${where}.assetId`);
    return null;
  }
  if (typeof node.d !== "string" || node.d.trim() === "") return refusal("malformed_scene", `${where}.d`);
  for (const key of ["fill", "stroke"] as const)
    if (node[key] !== undefined && typeof node[key] !== "string") return refusal("malformed_scene", `${where}.${key}`);
  if (node.strokeWidth !== undefined && !(finite(node.strokeWidth) && node.strokeWidth > 0))
    return refusal("malformed_scene", `${where}.strokeWidth`);
  return null;
}

const copyValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(copyValue);
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = copyValue(entry);
  return copy;
};

export function validateScene(input: unknown): SceneResult<Scene> {
  if (!isRecord(input)) return refusal("malformed_scene", "$");
  const version = input.formatVersion;
  if (version === undefined) return refusal("missing_format_version", "formatVersion");
  if (!Number.isSafeInteger(version) || (version as number) < 1) return refusal("malformed_scene", "formatVersion");
  if ((version as number) > SCENE_FORMAT_VERSION)
    return refusal("unsupported_format_version", "formatVersion", { version: version as number });
  if (!Array.isArray(input.frames)) return refusal("malformed_scene", "frames");
  if (input.frames.length > SCENE_MAX_FRAMES) return refusal("frame_limit", "frames", { limit: SCENE_MAX_FRAMES });

  const ids = new Set<string>();
  let nodeCount = 0;
  for (let index = 0; index < input.frames.length; index += 1) {
    const at = `frames[${index}]`;
    const frame = input.frames[index];
    if (!isRecord(frame)) return refusal("malformed_scene", at);
    const frameProperty = unsupportedPropertyOf(frame);
    if (frameProperty !== null)
      return refusal("unsupported_property", `${at}.${frameProperty}`, { property: frameProperty });
    if (!isId(frame.id)) return refusal("malformed_scene", `${at}.id`);
    if (ids.has(frame.id)) return refusal("duplicate_id", `${at}.id`, { id: frame.id });
    ids.add(frame.id);
    if (!isId(frame.name)) return refusal("malformed_scene", `${at}.name`);
    for (const key of GEOMETRY_KEYS) if (!finite(frame[key])) return refusal("non_finite_number", `${at}.${key}`);
    if ((frame.w as number) <= 0 || (frame.h as number) <= 0)
      return refusal("malformed_scene", (frame.w as number) <= 0 ? `${at}.w` : `${at}.h`);
    if (!Array.isArray(frame.nodes)) return refusal("malformed_scene", `${at}.nodes`);

    for (let position = 0; position < frame.nodes.length; position += 1) {
      const where = `${at}.nodes[${position}]`;
      nodeCount += 1;
      if (nodeCount > SCENE_MAX_NODES)
        return refusal("node_limit", where, { limit: SCENE_MAX_NODES, frameId: frame.id });
      const node = frame.nodes[position];
      if (!isRecord(node)) return refusal("malformed_scene", where);
      const nodeProperty = unsupportedPropertyOf(node);
      if (nodeProperty !== null)
        return refusal("unsupported_property", `${where}.${nodeProperty}`, { property: nodeProperty });
      if ("nodes" in node) return refusal("too_deep", `${where}.nodes`, { depth: SCENE_MAX_DEPTH + 1 });
      if (!isId(node.id)) return refusal("malformed_scene", `${where}.id`);
      if (ids.has(node.id)) return refusal("duplicate_id", `${where}.id`, { id: node.id });
      ids.add(node.id);
      if (!isNodeType(node.type)) return refusal("unknown_node_type", `${where}.type`, { type: String(node.type) });
      for (const key of GEOMETRY_KEYS) if (!finite(node[key])) return refusal("non_finite_number", `${where}.${key}`);
      const x = node.x as number;
      const y = node.y as number;
      const w = node.w as number;
      const h = node.h as number;
      if (w < 0 || h < 0) return refusal("malformed_scene", w < 0 ? `${where}.w` : `${where}.h`);
      if (x < 0 || y < 0 || x + w > (frame.w as number) || y + h > (frame.h as number))
        return refusal("outside_frame_bounds", where, { id: node.id, frameId: frame.id });
      const shape = nodeShapeRefusal(node, where);
      if (shape !== null) return shape;
    }
  }
  return { ok: true, value: copyValue(input) as Scene };
}

export function readScene(text: string): SceneResult<Scene> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return refusal("malformed_scene", "$");
  }
  return validateScene(parsed);
}

const canonicalValue = (value: unknown): unknown => {
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = canonicalValue(value[key]);
  return sorted;
};

export const canonicalScene = (scene: Scene): string => JSON.stringify(canonicalValue(scene));

export const sceneBytes = (scene: Scene): Uint8Array => new TextEncoder().encode(canonicalScene(scene));

export function sceneIndex(scene: Scene): SceneNodeIndex {
  const index: SceneNodeIndex = {};
  for (const frame of scene.frames)
    for (const node of frame.nodes)
      index[node.id] = { frameId: frame.id, type: node.type, x: node.x, y: node.y, w: node.w, h: node.h };
  return index;
}

const frameBBox = (frame: SceneFrame): SceneBBox => {
  if (frame.nodes.length === 0) return { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const node of frame.nodes) {
    left = Math.min(left, frame.x + node.x);
    top = Math.min(top, frame.y + node.y);
    right = Math.max(right, frame.x + node.x + node.w);
    bottom = Math.max(bottom, frame.y + node.y + node.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
};

export const sceneOutline = (scene: Scene): SceneOutlineEntry[] =>
  scene.frames.map((frame) => ({
    id: frame.id,
    name: frame.name,
    nodeCount: frame.nodes.length,
    bbox: frameBBox(frame),
  }));

export const sceneSubtree = (scene: Scene, frameId: string): SceneFrame | null =>
  scene.frames.find((frame) => frame.id === frameId) ?? null;
