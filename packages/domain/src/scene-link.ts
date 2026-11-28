import { ARTBOARD_VIEWPORT_WIDTHS, type ArtboardViewportWidth, type Scene } from "./scene.ts";

export const SCENE_VIEWS = ["canvas", "focus", "play"] as const;
export type SceneView = (typeof SCENE_VIEWS)[number];

export const DEFAULT_ARTBOARD_VIEWPORT: ArtboardViewportWidth = 1280;
export const SCENE_LINK_FRAME_MAX_LENGTH = 200;

export type SceneMalformedTargets = { readonly frame: boolean; readonly page: boolean };

export type SceneLink = {
  readonly view: SceneView;
  readonly frameId: string | null;
  readonly width: ArtboardViewportWidth | null;
  readonly page: string | null;
  readonly malformed?: SceneMalformedTargets;
};

export type SceneViewPlan =
  | { readonly kind: "canvas"; readonly frameId: string | null; readonly page: string | null }
  | { readonly kind: "focus"; readonly frameId: string; readonly width: ArtboardViewportWidth }
  | { readonly kind: "play"; readonly frameId: string; readonly width: ArtboardViewportWidth };

export const CANVAS_PLAN: SceneViewPlan = { kind: "canvas", frameId: null, page: null };

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
};

const isView = (value: string | null): value is SceneView =>
  value !== null && (SCENE_VIEWS as readonly string[]).includes(value);

const targetOf = (value: string | null): { id: string | null; malformed: boolean } => {
  if (value === null || value.trim() === "") return { id: null, malformed: false };
  if (value.length > SCENE_LINK_FRAME_MAX_LENGTH || hasControlCharacter(value)) return { id: null, malformed: true };
  return { id: value, malformed: false };
};

const widthOf = (value: string | null): ArtboardViewportWidth | null => {
  if (value === null) return null;
  const found = ARTBOARD_VIEWPORT_WIDTHS.find((candidate) => String(candidate) === value);
  return found ?? null;
};

export const parseSceneLink = (params: { get(name: string): string | null }): SceneLink => {
  const view = params.get("view");
  const frame = targetOf(params.get("frame"));
  const page = targetOf(params.get("page"));
  const malformed = { frame: frame.malformed, page: page.malformed };
  return {
    view: isView(view) ? view : "canvas",
    frameId: frame.id,
    width: widthOf(params.get("width")),
    page: page.id,
    ...(malformed.frame || malformed.page ? { malformed } : {}),
  };
};

export const sceneViewHref = (path: string, link: SceneLink): string => {
  const query = new URLSearchParams();
  if (link.frameId !== null) query.set("frame", link.frameId);
  if (link.view !== "canvas") query.set("view", link.view);
  if (link.view !== "canvas" && link.width !== null) query.set("width", String(link.width));
  if (link.page !== null) query.set("page", link.page);
  const search = query.toString();
  return search === "" ? path : `${path}?${search}`;
};

export type SceneLinkGap = "artboard" | "page";

export const sceneLinkGap = (
  scene: Pick<Scene, "frames"> & { pages?: readonly { id: string }[] },
  link: SceneLink,
): SceneLinkGap | null => {
  if (link.malformed?.frame === true) return "artboard";
  if (link.malformed?.page === true) return "page";
  if (link.frameId !== null && !scene.frames.some((frame) => frame.id === link.frameId)) return "artboard";
  if (link.page !== null && !(scene.pages ?? []).some((page) => page.id === link.page)) return "page";
  return null;
};

export const planSceneView = (scene: Pick<Scene, "frames">, link: SceneLink): SceneViewPlan => {
  const frame = link.frameId === null ? undefined : scene.frames.find((entry) => entry.id === link.frameId);
  if (frame === undefined) return { kind: "canvas", frameId: null, page: link.page };
  if (link.view === "canvas") return { kind: "canvas", frameId: frame.id, page: link.page };
  if (link.view === "play" && frame.source === undefined) return { kind: "canvas", frameId: frame.id, page: link.page };
  return { kind: link.view, frameId: frame.id, width: link.width ?? DEFAULT_ARTBOARD_VIEWPORT };
};
