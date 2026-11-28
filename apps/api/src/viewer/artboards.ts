import type { Scene } from "@artiflow/domain/scene";
import type { SceneOperation } from "@artiflow/domain/scene-operations";

import type { SceneArtboardContent, SceneArtboards } from "./views/scene.ts";

export const ARTBOARD_MAX_INLINE_BYTES = 1024 * 1024;

export type SourceArtifactRow = {
  readonly artifactId: string;
  readonly kind: string;
  readonly deletedAt: Date | null;
  readonly revisionId: string | null;
  readonly revisionNumber: number | null;
  readonly sizeBytes: number | null;
  readonly storageKey: string | null;
  readonly sha256: string | null;
};

export type ArtboardReadDeps = {
  readonly origin: string | null;
  readonly maxBytes?: number;
  readonly sourceOf: (artifactId: string, revisionId: string) => Promise<SourceArtifactRow | null>;
  readonly bytesOf: (row: SourceArtifactRow) => Promise<Uint8Array | null>;
};

const unavailable = (
  reason: Extract<SceneArtboardContent, { kind: "unavailable" }>["reason"],
): SceneArtboardContent => ({ kind: "unavailable", reason });

const statusOf = async (
  source: { readonly artifactId: string; readonly revisionId: string },
  deps: ArtboardReadDeps,
): Promise<SceneArtboardContent> => {
  const row = await deps.sourceOf(source.artifactId, source.revisionId);
  if (row === null) return unavailable("forbidden");
  if (row.deletedAt !== null) return unavailable("missing");
  if (row.kind !== "html") return unavailable("not_html");
  if (row.revisionId !== source.revisionId || row.sizeBytes === null || row.storageKey === null)
    return unavailable("missing");
  if (row.sizeBytes > (deps.maxBytes ?? ARTBOARD_MAX_INLINE_BYTES)) return unavailable("too_large");
  const bytes = await deps.bytesOf(row);
  if (bytes === null) return unavailable("missing");
  return {
    kind: "ready",
    html: new TextDecoder().decode(bytes),
    revisionNumber: row.revisionNumber,
    origin: deps.origin,
  };
};

export async function resolveSceneArtboards(
  scene: Scene,
  viewerId: string | null,
  deps: ArtboardReadDeps,
): Promise<SceneArtboards> {
  const resolved: Record<string, SceneArtboardContent> = {};
  const cache = new Map<string, Promise<SceneArtboardContent>>();
  for (const frame of scene.frames) {
    const source = frame.source;
    if (source === undefined) continue;
    if (viewerId === null) {
      resolved[frame.id] = unavailable("forbidden");
      continue;
    }
    const key = `${source.artifactId}:${source.revisionId}`;
    const pending = cache.get(key) ?? statusOf(source, deps);
    cache.set(key, pending);
    resolved[frame.id] = await pending;
  }
  return resolved;
}

export type ArtboardRefreshPlan =
  | { readonly kind: "noop"; readonly revisionId: string; readonly revisionNumber: number }
  | { readonly kind: "update"; readonly op: SceneOperation; readonly revisionNumber: number }
  | { readonly kind: "refused"; readonly error: "unknown_frame" | "not_an_artboard" };

export function refreshArtboardPlan(input: {
  readonly draft: Scene;
  readonly frameId: string;
  readonly currentRevisionId: string;
  readonly currentRevisionNumber: number;
}): ArtboardRefreshPlan {
  const frame = input.draft.frames.find((entry) => entry.id === input.frameId);
  if (frame === undefined) return { kind: "refused", error: "unknown_frame" };
  const source = frame.source;
  if (source === undefined) return { kind: "refused", error: "not_an_artboard" };
  if (source.revisionId === input.currentRevisionId)
    return { kind: "noop", revisionId: input.currentRevisionId, revisionNumber: input.currentRevisionNumber };
  return {
    kind: "update",
    revisionNumber: input.currentRevisionNumber,
    op: {
      op: "update_frame",
      id: frame.id,
      props: {
        source: { artifactId: source.artifactId, revisionId: input.currentRevisionId, mode: source.mode },
      },
    },
  };
}
