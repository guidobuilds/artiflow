import {
  validateScene,
  type RectNode,
  type Scene,
  type SceneFrame,
  type SceneNode,
  type TextNode,
  type TextStyle,
} from "@artiflow/domain/scene";

import { manageRequest, type LocationTarget, type ManageResult } from "./auth-client.ts";

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

type Located = { frame: SceneFrame; node: SceneNode };

function locate(scene: Scene, nodeId: string): Located | null {
  for (const frame of scene.frames) {
    const node = frame.nodes.find((candidate) => candidate.id === nodeId);
    if (node !== undefined) return { frame, node };
  }
  return null;
}

function replaceNode(scene: Scene, frameId: string, node: SceneNode): Scene {
  return {
    ...scene,
    frames: scene.frames.map((frame) =>
      frame.id === frameId
        ? { ...frame, nodes: frame.nodes.map((current) => (current.id === node.id ? node : current)) }
        : frame,
    ),
  };
}

function insideFrame(frame: SceneFrame, node: SceneNode): SceneNode {
  const w = Math.max(MIN_NODE_SIZE, Math.min(rounded(node.w), Math.max(MIN_NODE_SIZE, frame.w)));
  const h = Math.max(MIN_NODE_SIZE, Math.min(rounded(node.h), Math.max(MIN_NODE_SIZE, frame.h)));
  const x = clamp(rounded(node.x), 0, Math.max(0, frame.w - w));
  const y = clamp(rounded(node.y), 0, Math.max(0, frame.h - h));
  return { ...node, x, y, w, h };
}

export function moveNode(scene: Scene, nodeId: string, dx: number, dy: number): Scene {
  const located = locate(scene, nodeId);
  if (located === null) return scene;
  const { frame, node } = located;
  const moved = insideFrame(frame, { ...node, x: node.x + rounded(dx), y: node.y + rounded(dy) });
  return replaceNode(scene, frame.id, moved);
}

export function resizeNode(scene: Scene, nodeId: string, w: number, h: number): Scene {
  const located = locate(scene, nodeId);
  if (located === null) return scene;
  const { frame, node } = located;
  const width = clamp(rounded(w), MIN_NODE_SIZE, Math.max(MIN_NODE_SIZE, frame.w - node.x));
  const height = clamp(rounded(h), MIN_NODE_SIZE, Math.max(MIN_NODE_SIZE, frame.h - node.y));
  return replaceNode(scene, frame.id, { ...node, w: width, h: height });
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
  const located = locate(scene, nodeId);
  if (located === null) return scene;
  return {
    ...scene,
    frames: scene.frames.map((frame) =>
      frame.id === located.frame.id
        ? { ...frame, nodes: frame.nodes.filter((candidate) => candidate.id !== nodeId) }
        : frame,
    ),
  };
}

export function updateTextNode(
  scene: Scene,
  nodeId: string,
  patch: { text?: string; style?: Partial<TextStyle> },
): Scene {
  const located = locate(scene, nodeId);
  if (located === null || located.node.type !== "text") return scene;
  const current = located.node;
  const style: TextStyle = { ...(current.style ?? {}) };
  if (patch.style?.fontSize !== undefined)
    style.fontSize = clamp(rounded(patch.style.fontSize), MIN_FONT_SIZE, MAX_FONT_SIZE);
  if (patch.style?.fontWeight !== undefined)
    style.fontWeight = clamp(rounded(patch.style.fontWeight), MIN_FONT_WEIGHT, MAX_FONT_WEIGHT);
  if (patch.style?.color !== undefined && patch.style.color.trim() !== "") style.color = patch.style.color.trim();
  if (patch.style?.align !== undefined) style.align = patch.style.align;
  const text = patch.text ?? current.text;
  return replaceNode(scene, located.frame.id, { ...current, text, style });
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
