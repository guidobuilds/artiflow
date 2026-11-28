export const SCENE_FORMAT_VERSION = 1;
export const SCENE_MAX_FRAMES = 200;
export const SCENE_MAX_NODES = 2000;
export const SCENE_MAX_DEPTH = 2;
export const SCENE_MAX_PAGES = 40;
export const SCENE_MAX_GUIDES = 24;
export const SCENE_TITLE_MIN_FRAMES = 2;

export const SCENE_ANNOTATION_KINDS = ["title", "note"] as const;
export type SceneAnnotationKind = (typeof SCENE_ANNOTATION_KINDS)[number];

export const SCENE_GUIDE_KINDS = ["columns", "rows", "grid"] as const;
export type SceneGuideKind = (typeof SCENE_GUIDE_KINDS)[number];

export const ARTBOARD_MODES = ["fixed", "fluid"] as const;
export type ArtboardMode = (typeof ARTBOARD_MODES)[number];

export const ARTBOARD_VIEWPORT_WIDTHS = [390, 1280] as const;
export type ArtboardViewportWidth = (typeof ARTBOARD_VIEWPORT_WIDTHS)[number];

export const ARTBOARD_SOURCE_KEYS = ["artifactId", "revisionId", "mode"] as const;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ArtboardSource = {
  readonly artifactId: string;
  readonly revisionId: string;
  readonly mode: ArtboardMode;
};

export const isArtboardMode = (value: unknown): value is ArtboardMode =>
  typeof value === "string" && (ARTBOARD_MODES as readonly string[]).includes(value);

export const artboardViewportWidth = (
  source: ArtboardSource,
  viewport: ArtboardViewportWidth,
  frameWidth: number,
): number => (source.mode === "fixed" ? frameWidth : viewport);

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

export type ScenePage = { id: string; name: string } & SceneUnknowns;

export type SceneAnnotation = { kind: SceneAnnotationKind; targets?: string[] } & SceneUnknowns;

export type SceneGuides = {
  kind: SceneGuideKind;
  count: number;
  gutter?: number;
  margin?: number;
  color?: string;
} & SceneUnknowns;

export type SceneFrame = {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  nodes: SceneNode[];
  source?: ArtboardSource;
  page?: string;
  locked?: boolean;
} & SceneUnknowns;

export type SceneCanvasNode = SceneNode & { page?: string; annotation?: SceneAnnotation };

export type Scene = {
  formatVersion: number;
  frames: SceneFrame[];
  nodes?: SceneCanvasNode[];
  pages?: ScenePage[];
  guides?: SceneGuides;
} & SceneUnknowns;

export type SceneRefusalReason =
  | "malformed_scene"
  | "missing_format_version"
  | "unsupported_format_version"
  | "unknown_node_type"
  | "duplicate_id"
  | "non_finite_number"
  | "unsupported_property"
  | "too_deep"
  | "node_limit"
  | "frame_limit"
  | "invalid_source"
  | "page_limit"
  | "unknown_page"
  | "invalid_annotation"
  | "invalid_guides";

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
export type SceneFrameLocation = { frameId: string; name: string; nodeCount: number };
export type SceneBlockIndex = Record<string, SceneNodeLocation | SceneFrameLocation>;
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

function sharedNodeRefusal(node: unknown, where: string, ids: Set<string>): SceneRefusal | null {
  if (!isRecord(node)) return refusal("malformed_scene", where);
  const property = unsupportedPropertyOf(node);
  if (property !== null) return refusal("unsupported_property", `${where}.${property}`, { property });
  if ("nodes" in node) return refusal("too_deep", `${where}.nodes`, { depth: SCENE_MAX_DEPTH + 1 });
  if (!isId(node.id)) return refusal("malformed_scene", `${where}.id`);
  if (ids.has(node.id)) return refusal("duplicate_id", `${where}.id`, { id: node.id });
  ids.add(node.id);
  if (!isNodeType(node.type)) return refusal("unknown_node_type", `${where}.type`, { type: String(node.type) });
  for (const key of GEOMETRY_KEYS) if (!finite(node[key])) return refusal("non_finite_number", `${where}.${key}`);
  if ((node.w as number) < 0) return refusal("malformed_scene", `${where}.w`);
  if ((node.h as number) < 0) return refusal("malformed_scene", `${where}.h`);
  return null;
}

function sourceRefusal(value: unknown, where: string): SceneRefusal | null {
  if (!isRecord(value)) return refusal("invalid_source", where);
  for (const key of Object.keys(value))
    if (!(ARTBOARD_SOURCE_KEYS as readonly string[]).includes(key))
      return refusal("invalid_source", `${where}.${key}`, { property: key });
  for (const key of ["artifactId", "revisionId"] as const)
    if (typeof value[key] !== "string" || !CANONICAL_UUID.test(value[key]))
      return refusal("invalid_source", `${where}.${key}`, { property: key });
  if (!isArtboardMode(value.mode)) return refusal("invalid_source", `${where}.mode`, { property: "mode" });
  return null;
}

export function readArtboardSource(value: unknown): SceneResult<ArtboardSource> {
  const element = sourceRefusal(value, "source");
  if (element !== null) return element;
  const record = value as Record<string, unknown>;
  return {
    ok: true,
    value: {
      artifactId: record.artifactId as string,
      revisionId: record.revisionId as string,
      mode: record.mode as ArtboardMode,
    },
  };
}

function pagesRefusal(value: unknown, ids: Set<string>): SceneRefusal | null {
  if (!Array.isArray(value)) return refusal("malformed_scene", "pages");
  if (value.length > SCENE_MAX_PAGES) return refusal("page_limit", "pages", { limit: SCENE_MAX_PAGES });
  for (let index = 0; index < value.length; index += 1) {
    const at = `pages[${index}]`;
    const page = value[index];
    if (!isRecord(page)) return refusal("malformed_scene", at);
    if (!isId(page.id)) return refusal("malformed_scene", `${at}.id`);
    if (ids.has(page.id)) return refusal("duplicate_id", `${at}.id`, { id: page.id });
    ids.add(page.id);
    if (!isId(page.name)) return refusal("malformed_scene", `${at}.name`);
  }
  return null;
}

function guidesRefusal(value: unknown): SceneRefusal | null {
  if (!isRecord(value)) return refusal("invalid_guides", "guides");
  if (!SCENE_GUIDE_KINDS.includes(value.kind as SceneGuideKind))
    return refusal("invalid_guides", "guides.kind", { property: "kind" });
  if (!Number.isSafeInteger(value.count) || (value.count as number) < 1 || (value.count as number) > SCENE_MAX_GUIDES)
    return refusal("invalid_guides", "guides.count", { property: "count", limit: SCENE_MAX_GUIDES });
  for (const key of ["gutter", "margin"] as const)
    if (value[key] !== undefined && !(finite(value[key]) && (value[key] as number) >= 0))
      return refusal("invalid_guides", `guides.${key}`, { property: key });
  if (value.color !== undefined && typeof value.color !== "string")
    return refusal("invalid_guides", "guides.color", { property: "color" });
  return null;
}

function pageRefusal(value: unknown, where: string, pages: ReadonlySet<string>): SceneRefusal | null {
  if (value === undefined) return null;
  if (!isId(value)) return refusal("unknown_page", where);
  if (!pages.has(value)) return refusal("unknown_page", where, { property: value });
  return null;
}

function annotationRefusal(
  value: unknown,
  where: string,
  frames: ReadonlySet<string>,
): SceneRefusal | null {
  if (!isRecord(value)) return refusal("invalid_annotation", where);
  if (!SCENE_ANNOTATION_KINDS.includes(value.kind as SceneAnnotationKind))
    return refusal("invalid_annotation", `${where}.kind`, { property: "kind" });
  const targets = value.targets;
  if (targets !== undefined) {
    if (!Array.isArray(targets) || targets.length > SCENE_MAX_FRAMES)
      return refusal("invalid_annotation", `${where}.targets`, { property: "targets" });
    const seen = new Set<string>();
    for (const target of targets) {
      if (!isId(target) || !frames.has(target))
        return refusal("invalid_annotation", `${where}.targets`, {
          property: typeof target === "string" ? target : undefined,
        });
      if (seen.has(target)) return refusal("invalid_annotation", `${where}.targets`, { property: target });
      seen.add(target);
    }
  }
  if (value.kind === "title" && (targets === undefined || targets.length < SCENE_TITLE_MIN_FRAMES))
    return refusal("invalid_annotation", `${where}.targets`, { property: "targets" });
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
  const pageIds = new Set<string>();
  const frameIds = new Set<string>();
  let nodeCount = 0;
  if (input.pages !== undefined) {
    const pages = pagesRefusal(input.pages, ids);
    if (pages !== null) return pages;
    for (const page of input.pages as ScenePage[]) pageIds.add(page.id);
  }
  if (input.guides !== undefined) {
    const guides = guidesRefusal(input.guides);
    if (guides !== null) return guides;
  }
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
    frameIds.add(frame.id);
    const page = pageRefusal(frame.page, `${at}.page`, pageIds);
    if (page !== null) return page;
    if (frame.locked !== undefined && typeof frame.locked !== "boolean")
      return refusal("malformed_scene", `${at}.locked`);
    for (const key of GEOMETRY_KEYS) if (!finite(frame[key])) return refusal("non_finite_number", `${at}.${key}`);
    if ((frame.w as number) <= 0 || (frame.h as number) <= 0)
      return refusal("malformed_scene", (frame.w as number) <= 0 ? `${at}.w` : `${at}.h`);
    if (!Array.isArray(frame.nodes)) return refusal("malformed_scene", `${at}.nodes`);
    if (frame.source !== undefined) {
      const sourceElement = sourceRefusal(frame.source, `${at}.source`);
      if (sourceElement !== null) return sourceElement;
      if (frame.nodes.length > 0)
        return refusal("invalid_source", `${at}.nodes`, { property: "nodes", frameId: frame.id as string });
    }

    for (let position = 0; position < frame.nodes.length; position += 1) {
      const where = `${at}.nodes[${position}]`;
      nodeCount += 1;
      if (nodeCount > SCENE_MAX_NODES)
        return refusal("node_limit", where, { limit: SCENE_MAX_NODES, frameId: frame.id });
      const shared = sharedNodeRefusal(frame.nodes[position], where, ids);
      if (shared !== null) return shared;
      const node = frame.nodes[position] as Record<string, unknown>;
      if (node.annotation !== undefined) return refusal("invalid_annotation", `${where}.annotation`);
      const shape = nodeShapeRefusal(node, where);
      if (shape !== null) return shape;
    }
  }

  if (input.nodes !== undefined) {
    if (!Array.isArray(input.nodes)) return refusal("malformed_scene", "nodes");
    for (let index = 0; index < input.nodes.length; index += 1) {
      const where = `nodes[${index}]`;
      nodeCount += 1;
      if (nodeCount > SCENE_MAX_NODES) return refusal("node_limit", where, { limit: SCENE_MAX_NODES });
      const shared = sharedNodeRefusal(input.nodes[index], where, ids);
      if (shared !== null) return shared;
      const node = input.nodes[index] as Record<string, unknown>;
      const shape = nodeShapeRefusal(node, where);
      if (shape !== null) return shape;
      const page = pageRefusal(node.page, `${where}.page`, pageIds);
      if (page !== null) return page;
      if (node.annotation !== undefined) {
        const annotation = annotationRefusal(node.annotation, `${where}.annotation`, frameIds);
        if (annotation !== null) return annotation;
      }
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

const sceneValue = (scene: Scene): Record<string, unknown> => {
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(scene)) copy[key] = entry;
  if (Array.isArray(copy.nodes) && copy.nodes.length === 0) delete copy.nodes;
  return copy;
};

export const canonicalScene = (scene: Scene): string => JSON.stringify(canonicalValue(sceneValue(scene)));

export const sceneBytes = (scene: Scene): Uint8Array => new TextEncoder().encode(canonicalScene(scene));

export function sceneIndex(scene: Scene): SceneNodeIndex {
  const index: SceneNodeIndex = {};
  for (const frame of scene.frames)
    for (const node of frame.nodes)
      index[node.id] = { frameId: frame.id, type: node.type, x: node.x, y: node.y, w: node.w, h: node.h };
  return index;
}

export function sceneBlockIndex(scene: Scene): SceneBlockIndex {
  const index: SceneBlockIndex = {};
  for (const frame of scene.frames)
    index[frame.id] = { frameId: frame.id, name: frame.name, nodeCount: frame.nodes.length };
  return Object.assign(index, sceneIndex(scene));
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

export type SurfacePlacement = { frameId: string; x: number; y: number };
export type SurfaceOrigin = { x: number; y: number };
export type SurfaceLayout = {
  placements: SurfacePlacement[];
  width: number;
  height: number;
  origin: SurfaceOrigin;
};

type SurfaceBox = { frameId: string; x: number; y: number; w: number; h: number };
type SurfaceArea = { x: number; y: number; w: number; h: number };

const SURFACE_GAP = 40;

const surfaceBox = (frame: SceneFrame): SurfaceBox => ({
  frameId: frame.id,
  x: finite(frame.x) ? frame.x : 0,
  y: finite(frame.y) ? frame.y : 0,
  w: finite(frame.w) && frame.w > 0 ? frame.w : 1,
  h: finite(frame.h) && frame.h > 0 ? frame.h : 1,
});

const surfaceNodeArea = (node: SceneNode): SurfaceArea => ({
  x: finite(node.x) ? node.x : 0,
  y: finite(node.y) ? node.y : 0,
  w: finite(node.w) && node.w > 0 ? node.w : 0,
  h: finite(node.h) && node.h > 0 ? node.h : 0,
});

const surfaceColumn = (boxes: SurfaceBox[]): SurfaceBox[] => {
  let top = 0;
  return boxes.map((box) => {
    const stacked = { ...box, x: 0, y: top };
    top += box.h + SURFACE_GAP;
    return stacked;
  });
};

export function surfaceLayout(frames: SceneFrame[], nodes: readonly SceneNode[] = []): SurfaceLayout {
  const boxes = frames.map(surfaceBox);
  const unstored = boxes.length > 1 && boxes.every((box) => box.x === boxes[0]?.x && box.y === boxes[0]?.y);
  const placed = unstored ? surfaceColumn(boxes) : boxes;
  const areas: SurfaceArea[] = [...placed, ...nodes.map(surfaceNodeArea)];
  if (areas.length === 0) return { placements: [], width: 0, height: 0, origin: { x: 0, y: 0 } };
  const left = Math.min(...areas.map((area) => area.x));
  const top = Math.min(...areas.map((area) => area.y));
  const right = Math.max(...areas.map((area) => area.x + area.w));
  const bottom = Math.max(...areas.map((area) => area.y + area.h));
  return {
    placements: placed.map((box) => ({ frameId: box.frameId, x: box.x - left, y: box.y - top })),
    width: right - left,
    height: bottom - top,
    origin: { x: left, y: top },
  };
}
