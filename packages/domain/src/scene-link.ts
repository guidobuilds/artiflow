import { ARTBOARD_VIEWPORT_WIDTHS, type ArtboardViewportWidth, type Scene } from "./scene.ts";

export const SCENE_VIEWS = ["canvas", "focus", "play"] as const;
export type SceneView = (typeof SCENE_VIEWS)[number];

export const DEFAULT_ARTBOARD_VIEWPORT: ArtboardViewportWidth = 1280;
export const SCENE_LINK_FRAME_MAX_LENGTH = 200;

export type SceneLink = {
  readonly view: SceneView;
  readonly frameId: string | null;
  readonly width: ArtboardViewportWidth | null;
};

export type SceneViewPlan =
  | { readonly kind: "canvas"; readonly frameId: string | null }
  | { readonly kind: "focus"; readonly frameId: string; readonly width: ArtboardViewportWidth }
  | { readonly kind: "play"; readonly frameId: string; readonly width: ArtboardViewportWidth };

export const CANVAS_PLAN: SceneViewPlan = { kind: "canvas", frameId: null };

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
};

const isView = (value: string | null): value is SceneView =>
  value !== null && (SCENE_VIEWS as readonly string[]).includes(value);

const frameIdOf = (value: string | null): string | null => {
  if (value === null) return null;
  if (value.trim() === "" || value.length > SCENE_LINK_FRAME_MAX_LENGTH) return null;
  return hasControlCharacter(value) ? null : value;
};

const widthOf = (value: string | null): ArtboardViewportWidth | null => {
  if (value === null) return null;
  const found = ARTBOARD_VIEWPORT_WIDTHS.find((candidate) => String(candidate) === value);
  return found ?? null;
};

export const parseSceneLink = (params: { get(name: string): string | null }): SceneLink => {
  const view = params.get("view");
  return {
    view: isView(view) ? view : "canvas",
    frameId: frameIdOf(params.get("frame")),
    width: widthOf(params.get("width")),
  };
};

export const sceneViewHref = (path: string, link: SceneLink): string => {
  const query = new URLSearchParams();
  if (link.frameId !== null) query.set("frame", link.frameId);
  if (link.view !== "canvas") query.set("view", link.view);
  if (link.view !== "canvas" && link.width !== null) query.set("width", String(link.width));
  const search = query.toString();
  return search === "" ? path : `${path}?${search}`;
};

export const planSceneView = (scene: Pick<Scene, "frames">, link: SceneLink): SceneViewPlan => {
  const frame = link.frameId === null ? undefined : scene.frames.find((entry) => entry.id === link.frameId);
  if (frame === undefined) return CANVAS_PLAN;
  if (link.view === "canvas") return { kind: "canvas", frameId: frame.id };
  if (link.view === "play" && frame.source === undefined) return { kind: "canvas", frameId: frame.id };
  return { kind: link.view, frameId: frame.id, width: link.width ?? DEFAULT_ARTBOARD_VIEWPORT };
};
