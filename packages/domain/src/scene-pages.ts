import { SCENE_MAX_GUIDES, type Scene, type SceneCanvasNode, type SceneFrame, type SceneGuides, type ScenePage } from "./scene.ts";

export type ScenePageEntry = { id: string; name: string };

export type ScenePageContent = {
  page: ScenePage | null;
  frames: SceneFrame[];
  notes: SceneCanvasNode[];
  missing: boolean;
};

export type ScenePageSelection = { page: ScenePage | null; missing: boolean };

export const scenePages = (scene: Pick<Scene, "pages">): ScenePage[] =>
  Array.isArray(scene.pages) ? scene.pages : [];

export const requestedScenePage = (
  scene: Pick<Scene, "pages">,
  requested?: string | null,
): ScenePageSelection => {
  const pages = scenePages(scene);
  if (pages.length === 0) return { page: null, missing: false };
  if (requested === undefined || requested === null) return { page: pages[0] ?? null, missing: false };
  const found = pages.find((page) => page.id === requested);
  return found === undefined ? { page: null, missing: true } : { page: found, missing: false };
};

export const scenePageOf = (scene: Pick<Scene, "pages">, requested?: string | null): ScenePage | null => {
  const pages = scenePages(scene);
  if (pages.length === 0) return null;
  if (requested !== undefined && requested !== null) {
    const found = pages.find((page) => page.id === requested);
    if (found !== undefined) return found;
  }
  return pages[0] ?? null;
};

const firstPageId = (scene: Pick<Scene, "pages">): string | null => scenePages(scene)[0]?.id ?? null;

export const scenePageContent = (
  scene: Pick<Scene, "pages" | "frames" | "nodes">,
  requested?: string | null,
): ScenePageContent => {
  const pages = scenePages(scene);
  const notes = Array.isArray(scene.nodes) ? scene.nodes : [];
  if (pages.length === 0) return { page: null, frames: [...scene.frames], notes: [...notes], missing: false };
  const selection = requestedScenePage(scene, requested);
  if (selection.missing) return { page: null, frames: [], notes: [], missing: true };
  const page = selection.page;
  if (page === null) return { page: null, frames: [...scene.frames], notes: [...notes], missing: false };
  const home = firstPageId(scene);
  return {
    page,
    frames: scene.frames.filter((frame) => (frame.page ?? home) === page.id),
    notes: notes.filter((node) => (node.page ?? home) === page.id),
    missing: false,
  };
};

export const scenePageOfFrame = (scene: Pick<Scene, "pages">, frame: SceneFrame): string | null =>
  scenePages(scene).length === 0 ? null : (frame.page ?? firstPageId(scene));

export type GuideLine = { x: number; y: number; w: number; h: number };

const DEFAULT_MARGIN = 0;
const DEFAULT_GUTTER = 0;

export const guideLines = (guides: SceneGuides, size: { w: number; h: number }): GuideLine[] => {
  if (!(size.w > 0) || !(size.h > 0)) return [];
  const count = Math.max(1, Math.min(SCENE_MAX_GUIDES, Math.trunc(guides.count)));
  const margin = guides.margin !== undefined && guides.margin >= 0 ? guides.margin : DEFAULT_MARGIN;
  const gutter = guides.gutter !== undefined && guides.gutter >= 0 ? guides.gutter : DEFAULT_GUTTER;
  const lines: GuideLine[] = [];
  const columns = (): void => {
    const usable = Math.max(0, size.w - margin * 2 - gutter * (count - 1));
    const width = usable / count;
    for (let index = 0; index < count; index += 1)
      lines.push({ x: margin + index * (width + gutter), y: 0, w: width, h: size.h });
  };
  const rows = (): void => {
    const usable = Math.max(0, size.h - margin * 2 - gutter * (count - 1));
    const height = usable / count;
    for (let index = 0; index < count; index += 1)
      lines.push({ x: 0, y: margin + index * (height + gutter), w: size.w, h: height });
  };
  if (guides.kind === "columns") columns();
  else if (guides.kind === "rows") rows();
  else {
    columns();
    rows();
  }
  return lines;
};


const pagesWith = (scene: Scene, pages: ScenePage[]): Scene => {
  const next: Scene = { ...scene };
  if (pages.length === 0) delete next.pages;
  else next.pages = pages;
  return next;
};

export function addScenePage(scene: Scene, page: ScenePage): Scene {
  if (scene.frames.some((frame) => frame.id === page.id)) return scene;
  if ((scene.nodes ?? []).some((node) => node.id === page.id)) return scene;
  if (scenePages(scene).some((entry) => entry.id === page.id)) return scene;
  return pagesWith(scene, [...scenePages(scene), page]);
}

export function renameScenePage(scene: Scene, id: string, name: string): Scene {
  const pages = scenePages(scene);
  if (!pages.some((page) => page.id === id) || name.trim() === "") return scene;
  return pagesWith(
    scene,
    pages.map((page) => (page.id === id ? { ...page, name } : page)),
  );
}

export function reorderScenePage(scene: Scene, id: string, index: number): Scene {
  const pages = scenePages(scene);
  const from = pages.findIndex((page) => page.id === id);
  if (from < 0 || !Number.isInteger(index) || index < 0 || index >= pages.length || index === from) return scene;
  const next = [...pages];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return scene;
  next.splice(index, 0, moved);
  return pagesWith(scene, next);
}

export const pageHasContent = (scene: Pick<Scene, "frames" | "nodes">, id: string): boolean =>
  scene.frames.some((frame) => frame.page === id) || (scene.nodes ?? []).some((node) => node.page === id);

export function removeScenePage(scene: Scene, id: string): Scene {
  if (pageHasContent(scene, id)) return scene;
  const implicit = scenePages(scene)[0]?.id === id;
  if (implicit && (scene.frames.some((frame) => frame.page === undefined) || (scene.nodes ?? []).some((node) => node.page === undefined)))
    return scene;
  const pages = scenePages(scene);
  if (!pages.some((page) => page.id === id)) return scene;
  return pagesWith(
    scene,
    pages.filter((page) => page.id !== id),
  );
}

export const assignFramePage = (scene: Scene, frameId: string, pageId: string | null): Scene => {
  if (pageId !== null && !scenePages(scene).some((page) => page.id === pageId)) return scene;
  return {
    ...scene,
    frames: scene.frames.map((frame) => {
      if (frame.id !== frameId) return frame;
      const next: SceneFrame = { ...frame };
      if (pageId === null) delete next.page;
      else next.page = pageId;
      return next;
    }),
  };
};

export const assignNotePage = (scene: Scene, nodeId: string, pageId: string | null): Scene => {
  if (pageId !== null && !scenePages(scene).some((page) => page.id === pageId)) return scene;
  const notes = scene.nodes ?? [];
  return {
    ...scene,
    nodes: notes.map((node) => {
      if (node.id !== nodeId) return node;
      const next: SceneCanvasNode = { ...node };
      if (pageId === null) delete next.page;
      else next.page = pageId;
      return next;
    }),
  };
};

export const setFrameLocked = (scene: Scene, frameId: string, locked: boolean): Scene => ({
  ...scene,
  frames: scene.frames.map((frame) => (frame.id === frameId ? { ...frame, locked } : frame)),
});

export const setSceneGuides = (scene: Scene, guides: SceneGuides | null): Scene => {
  const next: Scene = { ...scene };
  if (guides === null) delete next.guides;
  else next.guides = guides;
  return next;
};

export const DEFAULT_SCENE_GUIDES: SceneGuides = { kind: "columns", count: 3, gutter: 24, margin: 24 };
