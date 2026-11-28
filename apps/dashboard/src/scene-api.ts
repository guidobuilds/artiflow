import {
  validateScene,
  type RectNode,
  type Scene,
  type SceneFrame,
  type SceneNode,
  type TextNode,
  type TextStyle,
} from "@artiflow/domain/scene";

import { manageRequest, type LocationTarget } from "./auth-client.ts";

export type SceneDraft = {
  artifactId: string;
  seq: number;
  publishedSeq: number;
  revisionId: string;
  scene: Scene;
};

export type SavedScene = {
  artifactId: string;
  seq: number;
  publishedSeq: number;
  frozen: boolean;
  applied: number;
  revisionId: string;
};

const MIN_NODE_SIZE = 4;
const MAX_FONT_SIZE = 400;
const MIN_FONT_SIZE = 4;
const MIN_FONT_WEIGHT = 100;
const MAX_FONT_WEIGHT = 900;
const FIT_RATIO = 0.86;
const MIN_SCALE = 0.02;
const MAX_SCALE = 12;

const path = (id: string) => `/api/artifacts/${encodeURIComponent(id)}/scene`;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const named = (value: unknown): value is string => typeof value === "string" && value !== "";
const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const rounded = (value: number): number => (Number.isFinite(value) ? Math.round(value) : 0);

export function parseSceneDraft(body: unknown): SceneDraft | null {
  if (!record(body) || body.kind !== "canvas") return null;
  if (!named(body.artifactId) || !named(body.revisionId)) return null;
  if (!whole(body.seq) || !whole(body.publishedSeq)) return null;
  const checked = validateScene(body.scene);
  if (!checked.ok) return null;
  return {
    artifactId: body.artifactId,
    seq: body.seq,
    publishedSeq: body.publishedSeq,
    revisionId: body.revisionId,
    scene: checked.value,
  };
}

export function parseSavedScene(body: unknown): SavedScene | null {
  if (!record(body)) return null;
  if (!named(body.artifactId) || !named(body.revisionId)) return null;
  if (!whole(body.seq) || !whole(body.publishedSeq) || !whole(body.applied)) return null;
  if (typeof body.frozen !== "boolean") return null;
  return {
    artifactId: body.artifactId,
    seq: body.seq,
    publishedSeq: body.publishedSeq,
    frozen: body.frozen,
    applied: body.applied,
    revisionId: body.revisionId,
  };
}

export const getScene = (id: string) => manageRequest<SceneDraft>(path(id), "GET", parseSceneDraft);

export const saveScene = (id: string, scene: Scene, expectedSeq: number) =>
  manageRequest<SavedScene>(path(id), "PUT", parseSavedScene, { scene, expectedSeq });

export async function openCanvas(artifact: { id: string; viewerHref: string }, target: LocationTarget): Promise<void> {
  const draft = await getScene(artifact.id);
  target.assign(draft.ok ? `/canvas/${encodeURIComponent(artifact.id)}` : artifact.viewerHref);
}

export type LocatedNode = { frame: SceneFrame | null; node: SceneNode };

export const frameIsLocked = (frame: SceneFrame | null): boolean => frame !== null && frame.locked === true;

export const lockedArtboardHolds = (scene: Scene, nodeId: string): boolean => {
  const located = locateNode(scene, nodeId);
  return located !== null && frameIsLocked(located.frame);
};

export function locateNode(scene: Scene, nodeId: string): LocatedNode | null {
  for (const frame of scene.frames) {
    const node = frame.nodes.find((candidate) => candidate.id === nodeId);
    if (node !== undefined) return { frame, node };
  }
  const loose = scene.nodes?.find((candidate) => candidate.id === nodeId);
  return loose === undefined ? null : { frame: null, node: loose };
}

const containerNodes = (scene: Scene, frame: SceneFrame | null): SceneNode[] =>
  frame === null ? (scene.nodes ?? []) : (scene.frames.find((candidate) => candidate.id === frame.id)?.nodes ?? []);

function withContainerNodes(scene: Scene, frame: SceneFrame | null, nodes: SceneNode[]): Scene {
  if (frame === null) return { ...scene, nodes };
  return {
    ...scene,
    frames: scene.frames.map((candidate) => (candidate.id === frame.id ? { ...candidate, nodes } : candidate)),
  };
}

function replaceNode(scene: Scene, frame: SceneFrame | null, node: SceneNode): Scene {
  const nodes = containerNodes(scene, frame).map((current) => (current.id === node.id ? node : current));
  return withContainerNodes(scene, frame, nodes);
}

const sizedNode = (node: SceneNode): SceneNode => ({
  ...node,
  x: rounded(node.x),
  y: rounded(node.y),
  w: Math.max(MIN_NODE_SIZE, rounded(node.w)),
  h: Math.max(MIN_NODE_SIZE, rounded(node.h)),
});

function insideFrame(frame: SceneFrame, node: SceneNode): SceneNode {
  const sized = sizedNode(node);
  const w = Math.min(sized.w, Math.max(MIN_NODE_SIZE, frame.w));
  const h = Math.min(sized.h, Math.max(MIN_NODE_SIZE, frame.h));
  const x = clamp(sized.x, 0, Math.max(0, frame.w - w));
  const y = clamp(sized.y, 0, Math.max(0, frame.h - h));
  return { ...sized, x, y, w, h };
}

export type SceneRect = { x: number; y: number; w: number; h: number };

const finite = (value: number): boolean => Number.isFinite(value);

const isFrame = (source: SceneFrame | readonly SceneNode[]): source is SceneFrame => !Array.isArray(source);

const nodesOf = (source: SceneFrame | readonly SceneNode[]): readonly SceneNode[] =>
  isFrame(source) ? source.nodes : source;

export function selectionBounds(source: SceneFrame | readonly SceneNode[], ids: readonly string[]): SceneRect | null {
  const chosen = nodesOf(source).filter((node) => ids.includes(node.id));
  if (chosen.length === 0) return null;
  const left = Math.min(...chosen.map((node) => node.x));
  const top = Math.min(...chosen.map((node) => node.y));
  const right = Math.max(...chosen.map((node) => node.x + node.w));
  const bottom = Math.max(...chosen.map((node) => node.y + node.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function insideBounds(bounds: SceneRect, point: { x: number; y: number }): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.w && point.y >= bounds.y && point.y <= bounds.y + bounds.h;
}

export function selectNodesInRect(source: SceneFrame | readonly SceneNode[], rect: SceneRect): string[] {
  if (!finite(rect.x) || !finite(rect.y) || !finite(rect.w) || !finite(rect.h)) return [];
  const left = Math.min(rect.x, rect.x + rect.w);
  const right = Math.max(rect.x, rect.x + rect.w);
  const top = Math.min(rect.y, rect.y + rect.h);
  const bottom = Math.max(rect.y, rect.y + rect.h);
  return nodesOf(source)
    .filter((node) => node.x <= right && left <= node.x + node.w && node.y <= bottom && top <= node.y + node.h)
    .map((node) => node.id);
}

export function moveFrame(
  scene: Scene,
  placements: readonly { frameId: string; x: number; y: number }[],
  frameId: string,
  dx: number,
  dy: number,
): Scene {
  const target = scene.frames.find((frame) => frame.id === frameId);
  if (target === undefined || frameIsLocked(target)) return scene;
  const placed = new Map(placements.map((placement) => [placement.frameId, placement]));
  const offsetX = rounded(dx);
  const offsetY = rounded(dy);
  let changed = false;
  const frames = scene.frames.map((frame) => {
    const at = placed.get(frame.id);
    const x = (at === undefined ? frame.x : at.x) + (frame.id === frameId ? offsetX : 0);
    const y = (at === undefined ? frame.y : at.y) + (frame.id === frameId ? offsetY : 0);
    if (x === frame.x && y === frame.y) return frame;
    changed = true;
    return { ...frame, x, y };
  });
  return changed ? { ...scene, frames } : scene;
}

export function moveNode(scene: Scene, nodeId: string, dx: number, dy: number): Scene {
  const located = locateNode(scene, nodeId);
  if (located === null || frameIsLocked(located.frame)) return scene;
  const { frame, node } = located;
  const moved = sizedNode({ ...node, x: node.x + rounded(dx), y: node.y + rounded(dy) });
  return replaceNode(scene, frame, moved);
}

export function moveNodes(scene: Scene, ids: string[], dx: number, dy: number): Scene {
  const start = ids.map((id) => locateNode(scene, id)).find((located) => located !== null);
  if (start === undefined || frameIsLocked(start.frame)) return scene;
  const seen = new Set<string>();
  const group = containerNodes(scene, start.frame).filter((node) => {
    if (!ids.includes(node.id) || seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
  if (group.length === 0) return scene;
  const moveX = rounded(dx);
  const moveY = rounded(dy);
  const moved = group.map((node) => sizedNode({ ...node, x: node.x + moveX, y: node.y + moveY }));
  return moved.reduce((next, node) => replaceNode(next, start.frame, node), scene);
}

export function resizeNode(scene: Scene, nodeId: string, w: number, h: number): Scene {
  const located = locateNode(scene, nodeId);
  if (located === null || frameIsLocked(located.frame)) return scene;
  const { frame, node } = located;
  const width = Math.max(MIN_NODE_SIZE, rounded(w));
  const height = Math.max(MIN_NODE_SIZE, rounded(h));
  return replaceNode(scene, frame, { ...node, w: width, h: height });
}

export function addNode(scene: Scene, frameId: string, node: SceneNode): Scene {
  const frame = scene.frames.find((candidate) => candidate.id === frameId);
  if (frame === undefined) return scene;
  if (scene.frames.some((candidate) => candidate.nodes.some((existing) => existing.id === node.id))) return scene;
  return {
    ...scene,
    frames: scene.frames.map((candidate) =>
      candidate.id === frameId ? { ...candidate, nodes: [...candidate.nodes, insideFrame(frame, node)] } : candidate,
    ),
  };
}

export function removeNode(scene: Scene, nodeId: string): Scene {
  const located = locateNode(scene, nodeId);
  if (located === null || frameIsLocked(located.frame)) return scene;
  return withContainerNodes(
    scene,
    located.frame,
    containerNodes(scene, located.frame).filter((candidate) => candidate.id !== nodeId),
  );
}

const reordered = (nodes: SceneNode[], wanted: Set<string>, front: boolean): SceneNode[] => {
  const chosen = nodes.filter((node) => wanted.has(node.id));
  if (chosen.length === 0) return nodes;
  const rest = nodes.filter((node) => !wanted.has(node.id));
  const next = front ? [...rest, ...chosen] : [...chosen, ...rest];
  return next.every((node, at) => node.id === nodes[at]?.id) ? nodes : next;
};

function reorderNodes(scene: Scene, ids: string[], front: boolean): Scene {
  if (ids.length === 0) return scene;
  const wanted = new Set(ids);
  let changed = false;
  const frames = scene.frames.map((frame) => {
    const nodes = reordered(frame.nodes, wanted, front);
    if (nodes === frame.nodes) return frame;
    changed = true;
    return { ...frame, nodes };
  });
  const loose = scene.nodes === undefined ? undefined : reordered(scene.nodes, wanted, front);
  const looseChanged = loose !== undefined && loose !== scene.nodes;
  if (!changed && !looseChanged) return scene;
  return looseChanged ? { ...scene, frames, nodes: loose } : { ...scene, frames };
}

export const bringToFront = (scene: Scene, ids: string[]): Scene => reorderNodes(scene, ids, true);

export const sendToBack = (scene: Scene, ids: string[]): Scene => reorderNodes(scene, ids, false);

export function reorderNodeTo(scene: Scene, id: string, index: number): Scene {
  const located = locateNode(scene, id);
  if (located === null || !Number.isFinite(index)) return scene;
  const nodes = containerNodes(scene, located.frame);
  const from = nodes.findIndex((node) => node.id === id);
  const to = clamp(rounded(index), 0, nodes.length - 1);
  if (from < 0 || from === to) return scene;
  const next = [...nodes];
  next.splice(from, 1);
  next.splice(to, 0, located.node);
  return withContainerNodes(scene, located.frame, next);
}

export function nudgeSelection(scene: Scene, ids: string[], delta: number): Scene {
  if (ids.length === 0) return scene;
  const start = ids.map((id) => locateNode(scene, id)).find((located) => located !== null);
  if (start === undefined) return scene;
  const step = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  if (step === 0) return scene;
  const nodes = containerNodes(scene, start.frame);
  const wanted = new Set(ids);
  const chosen = nodes.filter((node) => wanted.has(node.id));
  if (chosen.length === 0) return scene;
  const first = nodes.findIndex((node) => wanted.has(node.id));
  const last = nodes.findLastIndex((node) => wanted.has(node.id));
  if (step > 0 && last >= nodes.length - 1) return scene;
  if (step < 0 && first <= 0) return scene;
  const rest = nodes.filter((node) => !wanted.has(node.id));
  rest.splice(first + step, 0, ...chosen);
  return withContainerNodes(scene, start.frame, rest);
}

const LAYER_SNIPPET_LENGTH = 40;

const layerTypeName = (node: SceneNode): string => {
  if (node.type === "rect") return "Rectangle";
  if (node.type === "image") return "Image";
  return "Path";
};

const layerSnippet = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed === "") return "Text";
  return trimmed.length > LAYER_SNIPPET_LENGTH ? `${trimmed.slice(0, LAYER_SNIPPET_LENGTH)}…` : trimmed;
};

export function layerRows(container: { nodes: readonly SceneNode[] }): { id: string; label: string }[] {
  const ordinals = new Map<SceneNode["type"], number>();
  const rows = container.nodes.map((node) => {
    const ordinal = (ordinals.get(node.type) ?? 0) + 1;
    ordinals.set(node.type, ordinal);
    const label = node.type === "text" ? layerSnippet(node.text) : `${layerTypeName(node)} ${ordinal}`;
    return { id: node.id, label };
  });
  return rows.reverse();
}

export function updateTextNode(
  scene: Scene,
  nodeId: string,
  patch: { text?: string; style?: Partial<TextStyle> },
): Scene {
  const located = locateNode(scene, nodeId);
  if (located === null || located.node.type !== "text") return scene;
  const current = located.node;
  const style: TextStyle = { ...current.style };
  if (patch.style?.fontSize !== undefined)
    style.fontSize = clamp(rounded(patch.style.fontSize), MIN_FONT_SIZE, MAX_FONT_SIZE);
  if (patch.style?.fontWeight !== undefined)
    style.fontWeight = clamp(rounded(patch.style.fontWeight), MIN_FONT_WEIGHT, MAX_FONT_WEIGHT);
  if (patch.style?.color !== undefined && patch.style.color.trim() !== "") style.color = patch.style.color.trim();
  if (patch.style?.align !== undefined) style.align = patch.style.align;
  const text = patch.text ?? current.text;
  return replaceNode(scene, located.frame, { ...current, text, style });
}

const placedWithin = (scene: Scene, frameId: string, offset: number): { x: number; y: number } => {
  const frame = scene.frames.find((candidate) => candidate.id === frameId);
  const room = (frame?.nodes.length ?? 0) % 5;
  return { x: 24 + offset + room * 16, y: 24 + offset + room * 16 };
};

export function textNode(id: string, x: number, y: number): TextNode {
  return {
    id,
    type: "text",
    x,
    y,
    w: 240,
    h: 64,
    text: "Text",
    style: { fontSize: 24, fontWeight: 600, color: "#111111" },
  };
}

export function rectNode(id: string, x: number, y: number): RectNode {
  return { id, type: "rect", x, y, w: 200, h: 120, fill: "#e5e7eb" };
}

export function addTextNode(scene: Scene, frameId: string, id: string): Scene {
  const at = placedWithin(scene, frameId, 0);
  return addNode(scene, frameId, textNode(id, at.x, at.y));
}

export function addRectNode(scene: Scene, frameId: string, id: string): Scene {
  const at = placedWithin(scene, frameId, 96);
  return addNode(scene, frameId, rectNode(id, at.x, at.y));
}

export function fitScale(frame: { w: number; h: number }, viewport: { w: number; h: number }): number {
  const width = Number.isFinite(viewport.w) ? Math.max(0, viewport.w) : 0;
  const height = Number.isFinite(viewport.h) ? Math.max(0, viewport.h) : 0;
  const w = Number.isFinite(frame.w) && frame.w > 0 ? frame.w : 0;
  const h = Number.isFinite(frame.h) && frame.h > 0 ? frame.h : 0;
  if (w === 0 || h === 0) return MIN_SCALE;
  return clamp(Math.min(width / w, height / h) * FIT_RATIO, MIN_SCALE, MAX_SCALE);
}

export const zoomBy = (scale: number, factor: number): number =>
  clamp(Number.isFinite(scale * factor) ? scale * factor : scale, MIN_SCALE, MAX_SCALE);

export { surfaceLayout, type SurfaceLayout, type SurfacePlacement } from "@artiflow/domain/scene";

export {
  DEFAULT_SCENE_GUIDES,
  addScenePage,
  assignFramePage,
  assignNotePage,
  guideLines,
  pageHasContent,
  removeScenePage,
  renameScenePage,
  reorderScenePage,
  scenePageContent,
  scenePageOf,
  scenePages,
  setFrameLocked,
  setSceneGuides,
  type GuideLine,
  type ScenePageContent,
  type ScenePageEntry,
} from "@artiflow/domain/scene-pages";
