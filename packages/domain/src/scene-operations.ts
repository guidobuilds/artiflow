import {
  canonicalScene,
  readArtboardSource,
  validateScene,
  type ArtboardSource,
  type Scene,
  type SceneAnnotation,
  type SceneFrame,
  type SceneNode,
  type ScenePage,
  type SceneRefusalDetail,
  type SceneRefusalReason,
} from "./scene.ts";

export type SceneOperationRefusalReason =
  | "empty_operations"
  | "unknown_operation"
  | "invalid_arguments"
  | "unknown_frame"
  | "unknown_node"
  | "unknown_page"
  | "page_not_empty"
  | "frame_locked"
  | "non_positive_size"
  | SceneRefusalReason;

export type SceneOperationDetail = SceneRefusalDetail & { path?: string };

export type SceneOperationRefusal = {
  ok: false;
  reason: SceneOperationRefusalReason;
  opIndex: number;
  detail: SceneOperationDetail;
};

export type SceneNodeBox = { id: string; frameId: string; x: number; y: number; w: number; h: number };
export type SceneViolation = { reason: SceneRefusalReason; path: string; detail: SceneRefusalDetail };

export type SceneOperationOutcome = {
  formatVersion: number;
  scene: Scene;
  applied: number;
  boxes: SceneNodeBox[];
  violations: SceneViolation[];
};

export type SceneOperationsResult = { ok: true; value: SceneOperationOutcome } | SceneOperationRefusal;

export type SceneFramePatch = {
  name?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  source?: ArtboardSource | null;
  page?: string | null;
  locked?: boolean;
} & { readonly [property: string]: unknown };

export type ScenePagePatch = { name?: string } & { readonly [property: string]: unknown };

export type SceneNodePatch = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  type?: string;
  fill?: string;
  radius?: number;
  text?: string;
  assetId?: string;
  d?: string;
  stroke?: string;
  strokeWidth?: number;
  style?: { readonly [property: string]: unknown };
  page?: string | null;
  annotation?: SceneAnnotation | null;
} & { readonly [property: string]: unknown };

export type SceneOperation =
  | { op: "add_frame"; frame: SceneFrame }
  | { op: "update_frame"; id: string; props: SceneFramePatch }
  | { op: "remove_frame"; id: string }
  | { op: "add_node"; frameId: string; node: SceneNode }
  | { op: "update_node"; id: string; props: SceneNodePatch }
  | { op: "move_node"; id: string; x: number; y: number; w?: number; h?: number }
  | { op: "reorder_node"; id: string; index: number }
  | { op: "remove_node"; id: string }
  | { op: "add_canvas_node"; node: SceneNode }
  | { op: "update_canvas_node"; id: string; props: SceneNodePatch }
  | { op: "move_canvas_node"; id: string; x: number; y: number; w?: number; h?: number }
  | { op: "reorder_canvas_node"; id: string; index: number }
  | { op: "remove_canvas_node"; id: string }
  | { op: "add_page"; page: ScenePage }
  | { op: "update_page"; id: string; props: ScenePagePatch }
  | { op: "remove_page"; id: string }
  | { op: "reorder_page"; id: string; index: number }
  | { op: "replace_scene"; scene: Scene };

const GEOMETRY_KEYS = ["x", "y", "w", "h"] as const;
type GeometryKey = (typeof GEOMETRY_KEYS)[number];

type GeometryIssue = { reason: "non_finite_number" | "non_positive_size"; property: GeometryKey };
type Step =
  { ok: true; touched: string[] } | { ok: false; reason: SceneOperationRefusalReason; detail: SceneOperationDetail };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const identifier = (value: unknown): string | undefined => (isId(value) ? value : undefined);

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = clone(entry);
  return copy as T;
}

const refusal = (reason: SceneOperationRefusalReason, opIndex: number, detail: SceneOperationDetail = {}) => ({
  ok: false as const,
  reason,
  opIndex,
  detail,
});

const stepRefusal = (reason: SceneOperationRefusalReason, detail: SceneOperationDetail = {}): Step => ({
  ok: false,
  reason,
  detail,
});

const inspectGeometry = (record: Record<string, unknown>): GeometryIssue | null => {
  for (const key of GEOMETRY_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return { reason: "non_finite_number", property: key };
    if ((key === "w" || key === "h") && value <= 0) return { reason: "non_positive_size", property: key };
  }
  return null;
};

const frameOf = (scene: Scene, id: unknown): SceneFrame | undefined => scene.frames.find((frame) => frame.id === id);

const nodeOf = (scene: Scene, id: unknown): { frame: SceneFrame; position: number; node: SceneNode } | null => {
  for (const frame of scene.frames)
    for (const [position, node] of frame.nodes.entries()) if (node.id === id) return { frame, position, node };
  return null;
};

const nodeIdsOf = (frame: SceneFrame): string[] =>
  (Array.isArray(frame.nodes) ? frame.nodes : []).flatMap((node) => (isRecord(node) && isId(node.id) ? [node.id] : []));

const canvasNodesOf = (scene: Scene): SceneNode[] => (Array.isArray(scene.nodes) ? scene.nodes : []);

const canvasNodeOf = (scene: Scene, id: unknown): { position: number; node: SceneNode } | null => {
  const nodes = canvasNodesOf(scene);
  const position = nodes.findIndex((node) => node.id === id);
  return position < 0 ? null : { position, node: nodes[position] as SceneNode };
};

const canvasNodeIds = (scene: Scene): string[] =>
  canvasNodesOf(scene).flatMap((node) => (isRecord(node) && isId(node.id) ? [node.id] : []));

const canvasNodesById = (scene: Scene): Map<string, SceneNode> =>
  new Map(canvasNodesOf(scene).map((node) => [node.id, node]));

const pagesOf = (scene: Scene): ScenePage[] => (Array.isArray(scene.pages) ? scene.pages : []);

const pageOf = (scene: Scene, id: unknown): ScenePage | undefined => pagesOf(scene).find((page) => page.id === id);

const pageHasContent = (scene: Scene, id: string): boolean =>
  scene.frames.some((frame) => frame.page === id) || canvasNodesOf(scene).some((node) => node.page === id);

const pageHoldsImplicitContent = (scene: Scene, id: string): boolean =>
  pagesOf(scene)[0]?.id === id &&
  (scene.frames.some((frame) => frame.page === undefined) ||
    canvasNodesOf(scene).some((node) => node.page === undefined));

const touchesGeometry = (record: Record<string, unknown>): boolean => GEOMETRY_KEYS.some((key) => key in record);

const sortedValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortedValue(value[key]);
  return sorted;
};

const lockedFrameShape = (frame: SceneFrame): Record<string, unknown> => ({
  id: frame.id,
  name: frame.name,
  x: frame.x,
  y: frame.y,
  w: frame.w,
  h: frame.h,
  source: frame.source ?? null,
  nodes: frame.nodes.map((node) => ({ id: node.id, type: node.type, x: node.x, y: node.y, w: node.w, h: node.h })),
});

const frameBody = (frame: SceneFrame): string => JSON.stringify(sortedValue(lockedFrameShape(frame)));

const lockedFrameViolation = (
  locked: readonly SceneFrame[],
  after: Scene,
): { frameId: string; frame: SceneFrame } | null => {
  for (const frame of locked) {
    const current = after.frames.find((entry) => entry.id === frame.id);
    if (current === undefined || frameBody(frame) !== frameBody(current)) return { frameId: frame.id, frame };
  }
  return null;
};

const frameOperationIndex = (
  operations: readonly SceneOperation[],
  frameId: string,
  nodeIds: ReadonlySet<string>,
): number => {
  const index = operations.findIndex((operation) => {
    if (operation.op === "replace_scene") return true;
    const record = operation as unknown as Record<string, unknown>;
    const frame = record.frame;
    if (record.op === "add_frame") return isRecord(frame) && frame.id === frameId;
    if (typeof record.id === "string" && (record.id === frameId || nodeIds.has(record.id))) return true;
    return record.frameId === frameId;
  });
  return index < 0 ? operations.length - 1 : index;
};

function addFrame(draft: Scene, raw: Record<string, unknown>): Step {
  const frame = raw.frame;
  if (!isRecord(frame)) return stepRefusal("invalid_arguments", { property: "frame" });
  if (!isId(frame.id)) return stepRefusal("invalid_arguments", { property: "id" });
  const issue = inspectGeometry(frame);
  if (issue !== null) return stepRefusal(issue.reason, { property: issue.property, id: frame.id });
  if (frame.source !== undefined) {
    const source = readArtboardSource(frame.source);
    if (!source.ok) return stepRefusal("invalid_source", { ...source.detail, path: "frame.source" });
    if (Array.isArray(frame.nodes) && frame.nodes.length > 0)
      return stepRefusal("invalid_source", { property: "nodes", id: frame.id });
  }
  const added = clone(frame) as unknown as SceneFrame;
  draft.frames.push(added);
  return { ok: true, touched: nodeIdsOf(added) };
}

function frameSourceRefusal(props: Record<string, unknown>, frame: SceneFrame): SceneOperationDetail | null {
  if (!("source" in props)) return null;
  if (props.source === null) return null;
  const source = readArtboardSource(props.source);
  if (!source.ok) return { ...source.detail, path: "props.source" };
  if (frame.nodes.length > 0) return { property: "nodes", id: frame.id };
  return null;
}

function updateFrame(draft: Scene, raw: Record<string, unknown>): Step {
  const frame = frameOf(draft, raw.id);
  if (!frame) return stepRefusal("unknown_frame", { id: identifier(raw.id) });
  const props = raw.props;
  if (!isRecord(props)) return stepRefusal("invalid_arguments", { property: "props", id: frame.id });
  for (const key of ["id", "nodes"])
    if (key in props) return stepRefusal("invalid_arguments", { property: key, id: frame.id });
  const issue = inspectGeometry(props);
  if (issue !== null) return stepRefusal(issue.reason, { property: issue.property, id: frame.id });
  if (frame.locked === true && touchesGeometry(props)) return stepRefusal("frame_locked", { id: frame.id });
  const sourceIssue = frameSourceRefusal(props, frame);
  if (sourceIssue !== null) return stepRefusal("invalid_source", sourceIssue);
  const rest = clone(props) as Record<string, unknown>;
  delete rest.source;
  delete rest.page;
  Object.assign(frame, rest);
  if ("page" in props) {
    if (props.page === null) delete frame.page;
    else frame.page = props.page as string;
  }
  if ("source" in props) {
    if (props.source === null) delete frame.source;
    else frame.source = readArtboardSource(props.source).ok ? (props.source as ArtboardSource) : undefined;
  }
  return { ok: true, touched: nodeIdsOf(frame) };
}

function removeFrame(draft: Scene, raw: Record<string, unknown>): Step {
  const position = draft.frames.findIndex((frame) => frame.id === raw.id);
  if (position < 0) return stepRefusal("unknown_frame", { id: identifier(raw.id) });
  const frame = draft.frames[position] as SceneFrame;
  if (frame.locked === true) return stepRefusal("frame_locked", { id: frame.id });
  draft.frames.splice(position, 1);
  return { ok: true, touched: [] };
}

function addNode(draft: Scene, raw: Record<string, unknown>): Step {
  const frame = frameOf(draft, raw.frameId);
  if (!frame) return stepRefusal("unknown_frame", { frameId: identifier(raw.frameId) });
  const node = raw.node;
  if (!isRecord(node)) return stepRefusal("invalid_arguments", { property: "node", frameId: frame.id });
  if (!isId(node.id)) return stepRefusal("invalid_arguments", { property: "id", frameId: frame.id });
  const issue = inspectGeometry(node);
  if (issue !== null) return stepRefusal(issue.reason, { property: issue.property, id: node.id, frameId: frame.id });
  frame.nodes.push(clone(node) as unknown as SceneNode);
  return { ok: true, touched: [node.id] };
}

function updateNode(draft: Scene, raw: Record<string, unknown>): Step {
  const found = nodeOf(draft, raw.id);
  if (!found) return stepRefusal("unknown_node", { id: identifier(raw.id) });
  const props = raw.props;
  if (!isRecord(props)) return stepRefusal("invalid_arguments", { property: "props", id: found.node.id });
  if ("id" in props) return stepRefusal("invalid_arguments", { property: "id", id: found.node.id });
  const issue = inspectGeometry(props);
  if (issue !== null)
    return stepRefusal(issue.reason, { property: issue.property, id: found.node.id, frameId: found.frame.id });
  if (found.frame.locked === true && touchesGeometry(props))
    return stepRefusal("frame_locked", { id: found.node.id, frameId: found.frame.id });
  Object.assign(found.node, clone(props));
  return { ok: true, touched: [found.node.id] };
}

function moveNode(draft: Scene, raw: Record<string, unknown>): Step {
  const found = nodeOf(draft, raw.id);
  if (!found) return stepRefusal("unknown_node", { id: identifier(raw.id) });
  const detail = { id: found.node.id, frameId: found.frame.id };
  if (found.frame.locked === true) return stepRefusal("frame_locked", { id: found.node.id, frameId: found.frame.id });
  if (raw.x === undefined || raw.y === undefined)
    return stepRefusal("invalid_arguments", { property: raw.x === undefined ? "x" : "y", ...detail });
  const issue = inspectGeometry(raw);
  if (issue !== null) return stepRefusal(issue.reason, { property: issue.property, ...detail });
  found.node.x = raw.x as number;
  found.node.y = raw.y as number;
  if (raw.w !== undefined) found.node.w = raw.w as number;
  if (raw.h !== undefined) found.node.h = raw.h as number;
  return { ok: true, touched: [found.node.id] };
}

function reorderNode(draft: Scene, raw: Record<string, unknown>): Step {
  const found = nodeOf(draft, raw.id);
  if (!found) return stepRefusal("unknown_node", { id: identifier(raw.id) });
  const detail = { id: found.node.id, frameId: found.frame.id };
  const index = raw.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > found.frame.nodes.length - 1)
    return stepRefusal("invalid_arguments", { property: "index", ...detail });
  found.frame.nodes.splice(found.position, 1);
  found.frame.nodes.splice(index, 0, found.node);
  return { ok: true, touched: [] };
}

function removeNode(draft: Scene, raw: Record<string, unknown>): Step {
  const found = nodeOf(draft, raw.id);
  if (!found) return stepRefusal("unknown_node", { id: identifier(raw.id) });
  if (found.frame.locked === true)
    return stepRefusal("frame_locked", { id: found.node.id, frameId: found.frame.id });
  found.frame.nodes.splice(found.position, 1);
  return { ok: true, touched: [] };
}

function addCanvasNode(draft: Scene, raw: Record<string, unknown>): Step {
  const node = raw.node;
  if (!isRecord(node)) return stepRefusal("invalid_arguments", { property: "node" });
  if (!isId(node.id)) return stepRefusal("invalid_arguments", { property: "id" });
  const issue = inspectGeometry(node);
  if (issue !== null) return stepRefusal(issue.reason, { property: issue.property, id: node.id });
  if (!Array.isArray(draft.nodes)) draft.nodes = [];
  draft.nodes.push(clone(node) as unknown as SceneNode);
  return { ok: true, touched: [node.id] };
}

function updateCanvasNode(draft: Scene, raw: Record<string, unknown>): Step {
  const found = canvasNodeOf(draft, raw.id);
  if (!found) return stepRefusal("unknown_node", { id: identifier(raw.id) });
  const props = raw.props;
  if (!isRecord(props)) return stepRefusal("invalid_arguments", { property: "props", id: found.node.id });
  if ("id" in props) return stepRefusal("invalid_arguments", { property: "id", id: found.node.id });
  const issue = inspectGeometry(props);
  if (issue !== null) return stepRefusal(issue.reason, { property: issue.property, id: found.node.id });
  const rest = clone(props) as Record<string, unknown>;
  delete rest.page;
  delete rest.annotation;
  Object.assign(found.node, rest);
  if ("page" in props) {
    if (props.page === null) delete (found.node as { page?: string }).page;
    else (found.node as { page?: string }).page = props.page as string;
  }
  if ("annotation" in props) {
    const canvasNode = found.node as { annotation?: SceneAnnotation };
    if (props.annotation === null) delete canvasNode.annotation;
    else canvasNode.annotation = props.annotation as SceneAnnotation;
  }
  return { ok: true, touched: [found.node.id] };
}

function moveCanvasNode(draft: Scene, raw: Record<string, unknown>): Step {
  const found = canvasNodeOf(draft, raw.id);
  if (!found) return stepRefusal("unknown_node", { id: identifier(raw.id) });
  const detail = { id: found.node.id };
  if (raw.x === undefined || raw.y === undefined)
    return stepRefusal("invalid_arguments", { property: raw.x === undefined ? "x" : "y", ...detail });
  const issue = inspectGeometry(raw);
  if (issue !== null) return stepRefusal(issue.reason, { property: issue.property, ...detail });
  found.node.x = raw.x as number;
  found.node.y = raw.y as number;
  if (raw.w !== undefined) found.node.w = raw.w as number;
  if (raw.h !== undefined) found.node.h = raw.h as number;
  return { ok: true, touched: [found.node.id] };
}

function reorderCanvasNode(draft: Scene, raw: Record<string, unknown>): Step {
  const found = canvasNodeOf(draft, raw.id);
  if (!found) return stepRefusal("unknown_node", { id: identifier(raw.id) });
  const detail = { id: found.node.id };
  const index = raw.index;
  const nodes = canvasNodesOf(draft);
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > nodes.length - 1)
    return stepRefusal("invalid_arguments", { property: "index", ...detail });
  nodes.splice(found.position, 1);
  nodes.splice(index, 0, found.node);
  return { ok: true, touched: [] };
}

function removeCanvasNode(draft: Scene, raw: Record<string, unknown>): Step {
  const found = canvasNodeOf(draft, raw.id);
  if (!found) return stepRefusal("unknown_node", { id: identifier(raw.id) });
  canvasNodesOf(draft).splice(found.position, 1);
  return { ok: true, touched: [] };
}

function addPage(draft: Scene, raw: Record<string, unknown>): Step {
  const page = raw.page;
  if (!isRecord(page)) return stepRefusal("invalid_arguments", { property: "page" });
  if (!isId(page.id)) return stepRefusal("invalid_arguments", { property: "id" });
  if (!isId(page.name)) return stepRefusal("invalid_arguments", { property: "name" });
  if (!Array.isArray(draft.pages)) draft.pages = [];
  draft.pages.push(clone(page) as unknown as ScenePage);
  return { ok: true, touched: [] };
}

function updatePage(draft: Scene, raw: Record<string, unknown>): Step {
  const page = pageOf(draft, raw.id);
  if (!page) return stepRefusal("unknown_page", { id: identifier(raw.id) });
  const props = raw.props;
  if (!isRecord(props)) return stepRefusal("invalid_arguments", { property: "props", id: page.id });
  if ("id" in props) return stepRefusal("invalid_arguments", { property: "id", id: page.id });
  if ("name" in props && !isId(props.name))
    return stepRefusal("invalid_arguments", { property: "name", id: page.id });
  Object.assign(page, clone(props));
  return { ok: true, touched: [] };
}

function removePage(draft: Scene, raw: Record<string, unknown>): Step {
  const position = pagesOf(draft).findIndex((page) => page.id === raw.id);
  if (position < 0) return stepRefusal("unknown_page", { id: identifier(raw.id) });
  const id = pagesOf(draft)[position]?.id as string;
  if (pageHasContent(draft, id) || pageHoldsImplicitContent(draft, id))
    return stepRefusal("page_not_empty", { id });
  draft.pages?.splice(position, 1);
  if (draft.pages !== undefined && draft.pages.length === 0) delete draft.pages;
  return { ok: true, touched: [] };
}

function reorderPage(draft: Scene, raw: Record<string, unknown>): Step {
  const pages = pagesOf(draft);
  const position = pages.findIndex((page) => page.id === raw.id);
  if (position < 0) return stepRefusal("unknown_page", { id: identifier(raw.id) });
  const index = raw.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > pages.length - 1)
    return stepRefusal("invalid_arguments", { property: "index", id: pages[position]?.id });
  const [moved] = pages.splice(position, 1);
  if (moved === undefined) return stepRefusal("unknown_page", { id: identifier(raw.id) });
  pages.splice(index, 0, moved);
  return { ok: true, touched: [] };
}

function replaceScene(draft: Scene, raw: Record<string, unknown>): Step {
  const scene = raw.scene;
  if (!isRecord(scene)) return stepRefusal("invalid_arguments", { property: "scene" });
  const checked = validateScene(scene);
  if (!checked.ok) return stepRefusal(checked.reason, { ...checked.detail, path: checked.path });
  for (const key of Object.keys(draft)) delete (draft as unknown as Record<string, unknown>)[key];
  Object.assign(draft, checked.value);
  return { ok: true, touched: draft.frames.flatMap(nodeIdsOf) };
}

function applyStep(draft: Scene, operation: unknown): Step {
  if (!isRecord(operation)) return stepRefusal("unknown_operation");
  const name = operation.op;
  if (typeof name !== "string") return stepRefusal("unknown_operation");
  switch (name) {
    case "add_frame":
      return addFrame(draft, operation);
    case "update_frame":
      return updateFrame(draft, operation);
    case "remove_frame":
      return removeFrame(draft, operation);
    case "add_node":
      return addNode(draft, operation);
    case "update_node":
      return updateNode(draft, operation);
    case "move_node":
      return moveNode(draft, operation);
    case "reorder_node":
      return reorderNode(draft, operation);
    case "remove_node":
      return removeNode(draft, operation);
    case "add_canvas_node":
      return addCanvasNode(draft, operation);
    case "update_canvas_node":
      return updateCanvasNode(draft, operation);
    case "move_canvas_node":
      return moveCanvasNode(draft, operation);
    case "reorder_canvas_node":
      return reorderCanvasNode(draft, operation);
    case "remove_canvas_node":
      return removeCanvasNode(draft, operation);
    case "add_page":
      return addPage(draft, operation);
    case "update_page":
      return updatePage(draft, operation);
    case "remove_page":
      return removePage(draft, operation);
    case "reorder_page":
      return reorderPage(draft, operation);
    case "replace_scene":
      return replaceScene(draft, operation);
    default:
      return stepRefusal("unknown_operation");
  }
}

function boxesOf(scene: Scene, touched: ReadonlySet<string>): SceneNodeBox[] {
  const boxes: SceneNodeBox[] = [];
  const seen = new Set<string>();
  for (const frame of scene.frames)
    for (const node of frame.nodes) {
      if (!touched.has(node.id) || seen.has(node.id)) continue;
      seen.add(node.id);
      boxes.push({
        id: node.id,
        frameId: frame.id,
        x: frame.x + node.x,
        y: frame.y + node.y,
        w: node.w,
        h: node.h,
      });
    }
  return boxes;
}

const NODE_PROPERTIES = ["type", "fill", "radius", "text", "assetId", "d", "stroke", "strokeWidth", "style"] as const;
const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

function framePatchOf(before: SceneFrame, after: SceneFrame): SceneFramePatch {
  const patch: Record<string, unknown> = {};
  if (before.name !== after.name) patch.name = after.name;
  if (before.x !== after.x) patch.x = after.x;
  if (before.y !== after.y) patch.y = after.y;
  if (before.w !== after.w) patch.w = after.w;
  if (before.h !== after.h) patch.h = after.h;
  if (!sameValue(before.source ?? null, after.source ?? null)) patch.source = after.source ?? null;
  if (before.page !== after.page) patch.page = after.page ?? null;
  if (before.locked !== after.locked) patch.locked = after.locked;
  return patch as SceneFramePatch;
}

function framePatches(before: SceneFrame, after: SceneFrame): { patch: SceneFramePatch; shrink: boolean }[] {
  const full = framePatchOf(before, after);
  const shrinks = (full.w !== undefined && full.w < before.w) || (full.h !== undefined && full.h < before.h);
  if (!shrinks) return Object.keys(full).length === 0 ? [] : [{ patch: full, shrink: false }];
  const grows: Record<string, unknown> = {};
  const shrunk: Record<string, unknown> = {};
  if (full.name !== undefined) grows.name = full.name;
  if (full.x !== undefined) grows.x = full.x;
  if (full.y !== undefined) grows.y = full.y;
  if (full.source !== undefined) grows.source = full.source;
  if (full.w !== undefined) (full.w > before.w ? grows : shrunk).w = full.w;
  if (full.h !== undefined) (full.h > before.h ? grows : shrunk).h = full.h;
  return [
    ...(Object.keys(grows).length === 0 ? [] : [{ patch: grows as SceneFramePatch, shrink: false }]),
    ...(Object.keys(shrunk).length === 0 ? [] : [{ patch: shrunk as SceneFramePatch, shrink: true }]),
  ];
}

function nodePatchOf(before: SceneNode, after: SceneNode, canvas = false): SceneNodePatch {
  const patch: Record<string, unknown> = {};
  if (canvas) {
    const previous = before as { page?: string; annotation?: SceneAnnotation };
    const seen = after as { page?: string; annotation?: SceneAnnotation };
    if (previous.page !== seen.page) patch.page = seen.page ?? null;
    if (!sameValue(previous.annotation ?? null, seen.annotation ?? null)) patch.annotation = seen.annotation ?? null;
  }
  if (before.x !== after.x) patch.x = after.x;
  if (before.y !== after.y) patch.y = after.y;
  if (before.w !== after.w) patch.w = after.w;
  if (before.h !== after.h) patch.h = after.h;
  const seen = after as unknown as Record<string, unknown>;
  const previous = before as unknown as Record<string, unknown>;
  for (const property of NODE_PROPERTIES)
    if (!sameValue(previous[property], seen[property]) && seen[property] !== undefined)
      patch[property] = seen[property];
  return patch as SceneNodePatch;
}

function nodeChangeOf(
  before: SceneNode,
  after: SceneNode,
  container: "frame" | "canvas" = "frame",
): SceneOperation | null {
  const patch = nodePatchOf(before, after, container === "canvas");
  const keys = Object.keys(patch);
  if (keys.length === 0) return null;
  if (!keys.every((key) => GEOMETRY_KEYS.includes(key as GeometryKey)))
    return container === "canvas"
      ? { op: "update_canvas_node", id: after.id, props: patch }
      : { op: "update_node", id: after.id, props: patch };
  const geometry = {
    id: after.id,
    x: after.x,
    y: after.y,
    ...(patch.w === undefined ? {} : { w: patch.w }),
    ...(patch.h === undefined ? {} : { h: patch.h }),
  };
  return container === "canvas" ? { op: "move_canvas_node", ...geometry } : { op: "move_node", ...geometry };
}

type PlacedNode = { frameId: string; node: SceneNode };

const placedNodes = (scene: Scene): Map<string, PlacedNode> => {
  const placed = new Map<string, PlacedNode>();
  for (const frame of scene.frames) for (const node of frame.nodes) placed.set(node.id, { frameId: frame.id, node });
  return placed;
};

function orderingOperations(before: Scene, after: Scene): SceneOperation[] {
  const frames = new Map(before.frames.map((frame) => [frame.id, frame]));
  const operations: SceneOperation[] = [];
  for (const frame of after.frames) {
    const source = frames.get(frame.id);
    if (!source) continue;
    const ids = nodeIdsOf(source);
    for (const [index, id] of nodeIdsOf(frame).entries()) {
      if (ids[index] === id) continue;
      const from = ids.indexOf(id);
      if (from < 0) continue;
      ids.splice(from, 1);
      ids.splice(index, 0, id);
      operations.push({ op: "reorder_node", id, index });
    }
  }
  return operations;
}

type PageOperations = { added: SceneOperation[]; changed: SceneOperation[]; ordered: SceneOperation[]; removed: SceneOperation[] };

function pageOperations(before: Scene, after: Scene): PageOperations {
  const beforePages = pagesOf(before);
  const afterPages = pagesOf(after);
  const beforeById = new Map(beforePages.map((page) => [page.id, page]));
  const afterById = new Map(afterPages.map((page) => [page.id, page]));
  const added: SceneOperation[] = afterPages
    .filter((page) => !beforeById.has(page.id))
    .map((page) => ({ op: "add_page", page }));
  const removed: SceneOperation[] = beforePages
    .filter((page) => !afterById.has(page.id))
    .map((page) => ({ op: "remove_page", id: page.id }));
  const changed: SceneOperation[] = afterPages.flatMap((page) => {
    const previous = beforeById.get(page.id);
    if (previous === undefined || previous.name === page.name) return [];
    return [{ op: "update_page", id: page.id, props: { name: page.name } }];
  });
  const ids = [...beforePages.map((page) => page.id), ...afterPages.filter((page) => !beforeById.has(page.id)).map((page) => page.id)];
  const ordered: SceneOperation[] = [];
  for (const [index, id] of afterPages.map((page) => page.id).entries()) {
    if (ids[index] === id) continue;
    const from = ids.indexOf(id);
    if (from < 0) continue;
    ids.splice(from, 1);
    ids.splice(index, 0, id);
    ordered.push({ op: "reorder_page", id, index });
  }
  return { added, changed, ordered, removed };
}

function canvasOrderingOperations(before: Scene, after: Scene): SceneOperation[] {
  const ids = canvasNodeIds(before);
  const operations: SceneOperation[] = [];
  for (const [index, id] of canvasNodeIds(after).entries()) {
    if (ids[index] === id) continue;
    const from = ids.indexOf(id);
    if (from < 0) continue;
    ids.splice(from, 1);
    ids.splice(index, 0, id);
    operations.push({ op: "reorder_canvas_node", id, index });
  }
  return operations;
}

export function diffSceneOperations(previous: Scene, next: Scene): SceneOperation[] {
  const whole: SceneOperation[] = [{ op: "replace_scene", scene: next }];
  if (canonicalScene(previous) === canonicalScene(next)) return [];
  const beforeFrames = new Map(previous.frames.map((frame) => [frame.id, frame]));
  const afterFrames = new Map(next.frames.map((frame) => [frame.id, frame]));
  const beforeNodes = placedNodes(previous);
  const afterNodes = placedNodes(next);
  const beforeCanvas = canvasNodesById(previous);
  const afterCanvas = canvasNodesById(next);
  const addedFrames: SceneOperation[] = [];
  const removedFrames: SceneOperation[] = [];
  const grownFrames: SceneOperation[] = [];
  const shrunkFrames: SceneOperation[] = [];
  const removedNodes: SceneOperation[] = [];
  const addedNodes: SceneOperation[] = [];
  const changedNodes: SceneOperation[] = [];
  const removedCanvasNodes: SceneOperation[] = [];
  const addedCanvasNodes: SceneOperation[] = [];
  const changedCanvasNodes: SceneOperation[] = [];
  for (const frame of previous.frames)
    if (!afterFrames.has(frame.id)) removedFrames.push({ op: "remove_frame", id: frame.id });
  for (const frame of next.frames) {
    const before = beforeFrames.get(frame.id);
    if (!before) {
      addedFrames.push({ op: "add_frame", frame });
      continue;
    }
    for (const entry of framePatches(before, frame)) {
      const operation: SceneOperation = { op: "update_frame", id: frame.id, props: entry.patch };
      (entry.shrink ? shrunkFrames : grownFrames).push(operation);
    }
  }
  for (const [id, placed] of beforeNodes) {
    const after = afterNodes.get(id);
    if (after && after.frameId === placed.frameId) {
      const change = nodeChangeOf(placed.node, after.node);
      if (change) changedNodes.push(change);
      continue;
    }
    if (afterFrames.has(placed.frameId)) removedNodes.push({ op: "remove_node", id });
  }
  for (const [id, placed] of afterNodes) {
    const before = beforeNodes.get(id);
    if (before && before.frameId === placed.frameId) continue;
    if (!beforeFrames.has(placed.frameId)) continue;
    addedNodes.push({ op: "add_node", frameId: placed.frameId, node: placed.node });
  }
  for (const [id, node] of beforeCanvas) {
    const after = afterCanvas.get(id);
    if (!after) {
      removedCanvasNodes.push({ op: "remove_canvas_node", id });
      continue;
    }
    const change = nodeChangeOf(node, after, "canvas");
    if (change) changedCanvasNodes.push(change);
  }
  for (const [id, node] of afterCanvas)
    if (!beforeCanvas.has(id)) addedCanvasNodes.push({ op: "add_canvas_node", node });
  const pages = pageOperations(previous, next);
  const base: SceneOperation[] = [
    ...pages.added,
    ...pages.changed,
    ...addedFrames,
    ...grownFrames,
    ...removedNodes,
    ...removedCanvasNodes,
    ...addedNodes,
    ...addedCanvasNodes,
    ...changedNodes,
    ...changedCanvasNodes,
    ...shrunkFrames,
    ...removedFrames,
  ];
  const interim = base.length === 0 ? null : applySceneOperations(previous, base);
  const ordering = (scene: Scene): SceneOperation[] => [
    ...orderingOperations(scene, next),
    ...canvasOrderingOperations(scene, next),
    ...pageOperations(scene, next).ordered,
    ...pages.removed,
  ];
  const ordered = interim === null ? ordering(previous) : interim.ok ? ordering(interim.value.scene) : [];
  const operations: SceneOperation[] = [...base, ...ordered];
  if (operations.length === 0) return whole;
  const replay = applySceneOperations(previous, operations);
  if (!replay.ok) return whole;
  return canonicalScene(replay.value.scene) === canonicalScene(next) ? operations : whole;
}

export function applySceneOperations(scene: Scene, operations: readonly SceneOperation[]): SceneOperationsResult {
  if (!Array.isArray(operations) || operations.length === 0) return refusal("empty_operations", -1);
  const start = validateScene(scene);
  if (!start.ok) return refusal(start.reason, -1, { ...start.detail, path: start.path });
  const draft = start.value;
  const lockedBefore = draft.frames.filter((frame) => frame.locked === true).map((frame) => clone(frame));
  const touched = new Set<string>();
  for (const [index, operation] of operations.entries()) {
    const step = applyStep(draft, operation);
    if (!step.ok) return refusal(step.reason, index, step.detail);
    for (const id of step.touched) touched.add(id);
    const checked = validateScene(draft);
    if (!checked.ok) return refusal(checked.reason, index, { ...checked.detail, path: checked.path });
  }
  const result = validateScene(draft);
  if (!result.ok) return refusal(result.reason, operations.length - 1, { ...result.detail, path: result.path });
  const locked = lockedFrameViolation(lockedBefore, result.value);
  if (locked !== null) {
    const after = result.value.frames.find((frame) => frame.id === locked.frameId);
    const nodeIds = new Set([
      ...locked.frame.nodes.map((node) => node.id),
      ...(after?.nodes ?? []).map((node) => node.id),
    ]);
    return refusal("frame_locked", frameOperationIndex(operations, locked.frameId, nodeIds), {
      id: locked.frameId,
    });
  }
  return {
    ok: true,
    value: {
      formatVersion: result.value.formatVersion,
      scene: result.value,
      applied: operations.length,
      boxes: boxesOf(result.value, touched),
      violations: [],
    },
  };
}
