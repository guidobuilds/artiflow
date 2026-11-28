import { z } from "zod";

import { rendersScene } from "@artiflow/domain/kinds";
import {
  NODE_TYPES,
  SCENE_MAX_FRAMES,
  SCENE_MAX_NODES,
  readScene,
  sceneOutline,
  sceneSubtree,
  type Scene,
  type SceneNode,
  type SceneOutlineEntry,
} from "@artiflow/domain/scene";
import type { SceneNodeBox, SceneOperation, SceneViolation } from "@artiflow/domain/scene-operations";
import type { McpBackend, McpDocumentAuthorKind } from "./ports.ts";

export const MAX_SCENE_READ_NODES = 200;
export const MAX_SCENE_READ_BYTES = 65_536;
export const MAX_SCENE_APPLY_OPS = 50;

const sceneId = z.string().min(1).max(200);
const sceneNode = z.looseObject({
  id: sceneId,
  type: z.enum(NODE_TYPES),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
const sceneFrame = z.looseObject({
  id: sceneId,
  name: z.string().min(1).max(200),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  nodes: z.array(sceneNode).max(SCENE_MAX_NODES),
});
const sceneDocument = z.looseObject({
  formatVersion: z.number().int().min(1),
  frames: z.array(sceneFrame).max(SCENE_MAX_FRAMES),
});
const sceneFramePatch = z.looseObject({
  name: z.string().min(1).max(200).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
});
const sceneNodePatch = z.looseObject({
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  type: z.string().min(1).optional(),
  fill: z.string().min(1).optional(),
  radius: z.number().min(0).optional(),
  text: z.string().optional(),
  assetId: z.string().min(1).optional(),
  d: z.string().min(1).optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
  style: z.record(z.string(), z.unknown()).optional(),
});

export const sceneOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_frame"), frame: sceneFrame }),
  z.object({ op: z.literal("update_frame"), id: sceneId, props: sceneFramePatch }),
  z.object({ op: z.literal("remove_frame"), id: sceneId }),
  z.object({ op: z.literal("add_node"), frameId: sceneId, node: sceneNode }),
  z.object({ op: z.literal("update_node"), id: sceneId, props: sceneNodePatch }),
  z.object({
    op: z.literal("move_node"),
    id: sceneId,
    x: z.number(),
    y: z.number(),
    w: z.number().optional(),
    h: z.number().optional(),
  }),
  z.object({ op: z.literal("reorder_node"), id: sceneId, index: z.number().int().min(0) }),
  z.object({ op: z.literal("remove_node"), id: sceneId }),
  z.object({ op: z.literal("add_canvas_node"), node: sceneNode }),
  z.object({ op: z.literal("update_canvas_node"), id: sceneId, props: sceneNodePatch }),
  z.object({
    op: z.literal("move_canvas_node"),
    id: sceneId,
    x: z.number(),
    y: z.number(),
    w: z.number().optional(),
    h: z.number().optional(),
  }),
  z.object({ op: z.literal("reorder_canvas_node"), id: sceneId, index: z.number().int().min(0) }),
  z.object({ op: z.literal("remove_canvas_node"), id: sceneId }),
  z.object({ op: z.literal("replace_scene"), scene: sceneDocument }),
]);

const sceneArtifactId = z.string().min(1).max(100);

export const sceneOutlineInput = z.object({ artifactId: sceneArtifactId });

export const sceneReadInput = z.object({
  artifactId: sceneArtifactId,
  frameId: z.string().min(1).max(200).optional(),
  nodeIds: z.array(z.string().min(1).max(200)).min(1).max(MAX_SCENE_READ_NODES).optional(),
});

export const sceneApplyInput = z.object({
  artifactId: sceneArtifactId,
  baseSeq: z.number().int().min(0),
  idempotencyKey: z.string().min(1).max(100),
  ops: z.array(sceneOp).min(1).max(MAX_SCENE_APPLY_OPS),
});

export type SceneJsonObject = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
};

const objectFragmentOf = (schema: z.ZodType): SceneJsonObject => {
  const generated = z.toJSONSchema(schema, { io: "input" }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return { type: "object", properties: generated.properties ?? {}, required: generated.required ?? [] };
};

export const sceneOutlineInputSchema = objectFragmentOf(sceneOutlineInput);
export const sceneReadInputSchema = objectFragmentOf(sceneReadInput);
export const sceneApplyInputSchema = objectFragmentOf(sceneApplyInput);

export type SceneRefusalBody = { error: string; message: string } & Record<string, unknown>;

export type SceneOutcome<T> = { ok: true; value: T } | { ok: false; refusal: SceneRefusalBody };

export type SceneToolPorts = Pick<McpBackend, "selectReadRevision" | "documentDraft" | "sceneApply">;

export type LoadedScene = { revisionId: string; seq: number; scene: Scene };

type SceneFailure = {
  kind: string;
  reason: string;
  artifactKind?: string;
  currentSeq?: number;
  opIndex?: number;
};

const failureRefusal = (failure: SceneFailure, artifactId?: string): SceneRefusalBody => {
  const detail: Record<string, unknown> = artifactId === undefined ? {} : { artifactId };
  if (failure.artifactKind !== undefined) detail.kind = failure.artifactKind;
  if (failure.currentSeq !== undefined) detail.currentSeq = failure.currentSeq;
  if (failure.opIndex !== undefined) detail.opIndex = failure.opIndex;
  return {
    error: failure.kind === "operation_rejected" ? "invalid_operation" : failure.kind,
    message: failure.reason,
    ...detail,
  };
};

const sceneFailureRefusal = (failure: SceneFailure, artifactId: string): SceneRefusalBody =>
  failure.kind === "error"
    ? {
        error: "invalid_scene",
        message: failure.reason === "snapshot_is_not_valid_scene" ? "malformed_scene" : failure.reason,
        artifactId,
      }
    : failureRefusal(failure, artifactId);

export async function loadScene(
  ports: SceneToolPorts,
  ownerId: string,
  artifactId: string,
): Promise<SceneOutcome<LoadedScene>> {
  const row = await ports.selectReadRevision(undefined, ownerId, artifactId);
  if (!row) return { ok: false, refusal: { error: "not_found", message: "artifact_not_visible_to_owner", artifactId } };
  if (row.deletedAt) return { ok: false, refusal: { error: "gone", message: "artifact_deleted", artifactId } };
  if (!rendersScene(row.kind))
    return {
      ok: false,
      refusal: { error: "wrong_kind", message: "artifact_is_not_a_canvas", artifactId, kind: row.kind },
    };
  if (!row.id) return { ok: false, refusal: { error: "not_found", message: "revision_not_found", artifactId } };
  const draft = await ports.documentDraft(ownerId, artifactId);
  if (!draft.ok) return { ok: false, refusal: sceneFailureRefusal(draft, artifactId) };
  const parsed = readScene(draft.value.text);
  if (!parsed.ok)
    return {
      ok: false,
      refusal: { error: "invalid_scene", message: parsed.reason, artifactId, path: parsed.path },
    };
  return { ok: true, value: { revisionId: row.id, seq: draft.value.seq, scene: parsed.value } };
}

export async function sceneCurrentOf(
  ports: SceneToolPorts,
  ownerId: string,
  artifactId: string,
): Promise<Scene | null> {
  const loaded = await loadScene(ports, ownerId, artifactId);
  return loaded.ok ? loaded.value.scene : null;
}

export const sceneNodeCapRefusal = (
  artifactId: string,
  requestedNodes: number,
  frameId?: string,
): SceneRefusalBody => ({
  error: "too_large",
  message: "read_window_exceeds_the_node_cap",
  artifactId,
  ...(frameId === undefined ? {} : { frameId }),
  maxNodes: MAX_SCENE_READ_NODES,
  requestedNodes,
});

export type SceneOutlineValue = {
  artifactId: string;
  revisionId: string;
  seq: number;
  formatVersion: number;
  frameCount: number;
  looseNodeCount: number;
  frames: SceneOutlineEntry[];
};

export type SceneOutlineRequest = { artifactId: string; ownerId: string };

export async function sceneOutlineOf(
  ports: SceneToolPorts,
  input: SceneOutlineRequest,
): Promise<SceneOutcome<SceneOutlineValue>> {
  const loaded = await loadScene(ports, input.ownerId, input.artifactId);
  if (!loaded.ok) return loaded;
  const { revisionId, seq, scene } = loaded.value;
  const frames = sceneOutline(scene);
  return {
    ok: true,
    value: {
      artifactId: input.artifactId,
      revisionId,
      seq,
      formatVersion: scene.formatVersion,
      frameCount: frames.length,
      looseNodeCount: Array.isArray(scene.nodes) ? scene.nodes.length : 0,
      frames,
    },
  };
}

export type SceneFrameRead = {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bbox: SceneOutlineEntry["bbox"];
  nodeCount: number;
  nodes: SceneNode[];
};

export type SceneReadValue =
  | { artifactId: string; revisionId: string; seq: number; canvas: { nodeCount: number; nodes: SceneNode[] } }
  | { artifactId: string; revisionId: string; seq: number; frame: SceneFrameRead };

export type SceneReadRequest = {
  artifactId: string;
  ownerId: string;
  frameId?: string;
  nodeIds?: string[];
};

export async function sceneReadOf(
  ports: SceneToolPorts,
  input: SceneReadRequest,
): Promise<SceneOutcome<SceneReadValue>> {
  const loaded = await loadScene(ports, input.ownerId, input.artifactId);
  if (!loaded.ok) return loaded;
  const artifactId = input.artifactId;
  const { revisionId, seq, scene } = loaded.value;
  const wanted = input.nodeIds === undefined ? undefined : new Set(input.nodeIds);
  if (input.frameId === undefined) {
    const loose = Array.isArray(scene.nodes) ? scene.nodes : [];
    for (const id of wanted ?? [])
      if (!loose.some((node) => node.id === id))
        return { ok: false, refusal: { error: "unknown_node", message: "node_not_in_scene", artifactId, nodeId: id } };
    const canvasNodes = loose.filter((node) => wanted === undefined || wanted.has(node.id));
    if (canvasNodes.length > MAX_SCENE_READ_NODES)
      return { ok: false, refusal: sceneNodeCapRefusal(artifactId, canvasNodes.length) };
    const canvas = { nodeCount: canvasNodes.length, nodes: canvasNodes };
    const canvasBytes = new TextEncoder().encode(JSON.stringify(canvas)).length;
    if (canvasBytes > MAX_SCENE_READ_BYTES)
      return {
        ok: false,
        refusal: {
          error: "too_large",
          message: "read_window_exceeds_the_byte_cap",
          artifactId,
          maxBytes: MAX_SCENE_READ_BYTES,
          observedBytes: canvasBytes,
        },
      };
    return { ok: true, value: { artifactId, revisionId, seq, canvas } };
  }
  const frame = sceneSubtree(scene, input.frameId);
  const entry = sceneOutline(scene).find((candidate) => candidate.id === input.frameId);
  if (!frame || !entry)
    return {
      ok: false,
      refusal: { error: "unknown_frame", message: "frame_not_in_scene", artifactId, frameId: input.frameId },
    };
  for (const id of wanted ?? [])
    if (!frame.nodes.some((node) => node.id === id))
      return {
        ok: false,
        refusal: {
          error: "unknown_node",
          message: "node_not_in_frame",
          artifactId,
          frameId: input.frameId,
          nodeId: id,
        },
      };
  const nodes = frame.nodes.filter((node) => wanted === undefined || wanted.has(node.id));
  if (nodes.length > MAX_SCENE_READ_NODES)
    return { ok: false, refusal: sceneNodeCapRefusal(artifactId, nodes.length, input.frameId) };
  const projected = {
    id: frame.id,
    name: frame.name,
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: frame.h,
    bbox: entry.bbox,
    nodeCount: nodes.length,
    nodes,
  };
  const observedBytes = new TextEncoder().encode(JSON.stringify(projected)).length;
  if (observedBytes > MAX_SCENE_READ_BYTES)
    return {
      ok: false,
      refusal: {
        error: "too_large",
        message: "read_window_exceeds_the_byte_cap",
        artifactId,
        frameId: input.frameId,
        maxBytes: MAX_SCENE_READ_BYTES,
        observedBytes,
      },
    };
  return { ok: true, value: { artifactId, revisionId, seq, frame: projected } };
}

export type SceneActor = { ownerId: string; authorKind: McpDocumentAuthorKind; authorId: string };

export type SceneApplyValue = {
  artifactId: string;
  baseSeq: number;
  seq: number;
  applied: number;
  replayed: boolean;
  published: boolean;
  revisionId: string | null;
  boxes: SceneNodeBox[];
  violations: SceneViolation[];
};

export type SceneApplyCommand = {
  artifactId: string;
  baseSeq: number;
  idempotencyKey: string;
  ops: SceneOperation[];
};

export async function sceneApplyOf(
  ports: SceneToolPorts,
  actor: SceneActor,
  input: SceneApplyCommand,
): Promise<SceneOutcome<SceneApplyValue>> {
  const applied = await ports.sceneApply({
    artifactId: input.artifactId,
    ownerId: actor.ownerId,
    authorKind: actor.authorKind,
    authorId: actor.authorId,
    baseSeq: input.baseSeq,
    idempotencyKey: input.idempotencyKey,
    ops: input.ops,
  });
  if (!applied.ok) return { ok: false, refusal: failureRefusal(applied, input.artifactId) };
  return {
    ok: true,
    value: {
      artifactId: input.artifactId,
      baseSeq: input.baseSeq,
      seq: applied.value.seq,
      applied: applied.value.applied,
      replayed: applied.value.replayed,
      published: applied.value.published,
      revisionId: applied.value.revisionId,
      boxes: applied.value.boxes,
      violations: applied.value.violations,
    },
  };
}
