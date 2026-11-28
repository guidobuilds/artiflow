import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button.tsx";
import { Icon, IconAction } from "@/components/ui/icon.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Logo } from "@/components/ui/logo.tsx";
import { Menu, MenuHead, MenuItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import DeleteModal from "./DeleteModal.tsx";
import { ArtboardCard, ArtboardUpdateAction } from "./artboard-frame.tsx";
import ShareModal from "./ShareModal.tsx";
import { invalidateLibrary, libraryOwnedQuery } from "./query/library.ts";
import {
  canonicalScene,
  type Scene,
  type SceneFrame,
  type SceneGuideKind,
  type SceneNode,
  type TextNode,
} from "@artiflow/domain/scene";
import { getArtifactDetail } from "./editor-api.ts";
import { queryKeys } from "./query/keys.ts";
import {
  DEFAULT_SCENE_GUIDES,
  addRectNode,
  addScenePage,
  addTextNode,
  assignFramePage,
  assignNotePage,
  bringToFront,
  fitScale,
  frameIsLocked,
  getScene,
  guideLines,
  insideBounds,
  layerRows,
  locateNode,
  moveFrame,
  moveNode,
  moveNodes,
  nudgeSelection,
  removeNode,
  removeScenePage,
  renameScenePage,
  reorderNodeTo,
  reorderScenePage,
  resizeNode,
  saveScene,
  scenePageContent,
  scenePageOf,
  scenePages,
  setFrameLocked,
  setSceneGuides,
  selectNodesInRect,
  selectionBounds,
  sendToBack,
  surfaceLayout,
  updateTextNode,
  zoomBy,
  type SceneDraft,
  type SceneRect,
} from "./scene-api.ts";
import { SceneAutosave, type SceneSaveState, type SceneSaveStatus } from "./scene-autosave.ts";

const labels: Record<SceneSaveStatus, string> = {
  saved: "Saved",
  saving: "Saving",
  unsaved: "Unsaved",
  conflict: "Conflict",
  readonly: "Read-only",
  error: "Unsaved",
  restoring: "Loading",
};

type Mode = "move" | "width" | "height" | "both";

type Drag = {
  nodeId: string;
  ids: string[];
  mode: Mode | "group";
  startX: number;
  startY: number;
  snapshot: Scene;
  origin: { x: number; y: number; w: number; h: number };
};

type SelectionBox = { x: number; y: number; w: number; h: number };

type FrameDrag = {
  frameId: string;
  pointerId: number;
  startX: number;
  startY: number;
  unit: number;
  snapshot: Scene;
};

type LayerDrag = {
  id: string;
  pointerId: number;
  startY: number;
  rowHeight: number;
  index: number;
  count: number;
  snapshot: Scene;
};

type TextEdit = { id: string; snapshot: Scene };

type Point = { x: number; y: number };

type PanDrag = { pointerId: number; startX: number; startY: number; origin: Point };

const MARQUEE_THRESHOLD = 4;
const DRAG_THRESHOLD = 2;
const LAYER_THRESHOLD = 4;
const WHEEL_ZOOM_STEP = 400;
const FLOATING_INSET = 56;

export const HISTORY_LIMIT = 50;

export const commitHistory = (undo: Scene[], redo: Scene[], before: Scene): { undo: Scene[]; redo: Scene[] } => ({
  undo: [...undo, before].slice(-HISTORY_LIMIT),
  redo: [],
});

export const undoHistory = (
  undo: Scene[],
  redo: Scene[],
  current: Scene,
): { undo: Scene[]; redo: Scene[]; scene: Scene } | null => {
  const before = undo.at(-1);
  if (before === undefined) return null;
  return { undo: undo.slice(0, -1), redo: [...redo, current].slice(-HISTORY_LIMIT), scene: before };
};

export const redoHistory = (
  undo: Scene[],
  redo: Scene[],
  current: Scene,
): { undo: Scene[]; redo: Scene[]; scene: Scene } | null => {
  const after = redo.at(-1);
  if (after === undefined) return null;
  return { undo: [...undo, current].slice(-HISTORY_LIMIT), redo: redo.slice(0, -1), scene: after };
};

const withoutNodes = (scene: Scene, ids: string[]): Scene => ids.reduce((next, id) => removeNode(next, id), scene);

const wheelPan = (deltaX: number, deltaY: number, shiftKey: boolean): Point =>
  shiftKey ? { x: -deltaY, y: 0 } : { x: -deltaX, y: -deltaY };

const NO_OFFSET: Point = { x: 0, y: 0 };

const nodeStyle = (node: SceneNode, offset: Point = NO_OFFSET): CSSProperties => {
  const box: CSSProperties = { left: node.x - offset.x, top: node.y - offset.y, width: node.w, height: node.h };
  if (node.type === "rect") return { ...box, background: node.fill, borderRadius: node.radius ?? 0 };
  if (node.type === "text") {
    const style = node.style ?? {};
    return {
      ...box,
      fontSize: style.fontSize ?? 16,
      fontWeight: style.fontWeight ?? 400,
      color: style.color ?? "#111111",
      textAlign: style.align ?? "left",
    };
  }
  return box;
};

const sceneSaver = (artifactId: string) => (scene: Scene, expectedSeq: number) =>
  saveScene(artifactId, scene, expectedSeq);

const nodeLabel = (node: SceneNode): string => {
  if (node.type === "text") return `Text node: ${node.text.slice(0, 60)}`;
  if (node.type === "rect") return "Rectangle node";
  if (node.type === "image") return "Image node";
  return "Path node";
};

export default function CanvasEditorPage({ artifactId }: { artifactId: string }) {
  const scene = useQuery({ queryKey: queryKeys.artifact.scene(artifactId), queryFn: () => getScene(artifactId) });
  const draft = scene.data?.ok ? scene.data.value : null;
  const error =
    scene.data && !scene.data.ok
      ? scene.data.code === "wrong_kind"
        ? "This artifact is not a canvas, so it has no canvas editor."
        : scene.data.code === "forbidden"
          ? "Read-only: this canvas is not available for editing."
          : "Could not load this canvas."
      : "";
  return (
    <TooltipProvider>
      <div className="min-w-0 flex-1">
        {draft ? (
          <CanvasEditor key={artifactId} initial={draft} />
        ) : (
          <section className="p-7" aria-busy={!error}>
            <TextLink href="/library">Back to library</TextLink>
            <p role={error ? "alert" : "status"} className="mt-6">
              {error || "Loading canvas…"}
            </p>
            {error ? <TextLink href={`/artifact/${encodeURIComponent(artifactId)}`}>Open viewer</TextLink> : null}
          </section>
        )}
      </div>
    </TooltipProvider>
  );
}

function CanvasEditor({ initial }: { initial: SceneDraft }) {
  const session = useRef<SceneAutosave | null>(null);
  const [state, setState] = useState<SceneSaveState>(() => ({
    revisionId: initial.revisionId,
    seq: initial.seq,
    publishedSeq: initial.publishedSeq,
    scene: initial.scene,
    status: "saved",
    dirty: false,
  }));
  const [selected, setSelected] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<SelectionBox | null>(null);
  const [activeFrame, setActiveFrame] = useState<string | null>(initial.scene.frames[0]?.id ?? null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [fitted, setFitted] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [framesOpen, setFramesOpen] = useState(false);
  const [activePage, setActivePage] = useState<string | null>(null);
  const [guidesVisible, setGuidesVisible] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [panel, setPanel] = useState<"share" | "delete" | null>(null);
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: queryKeys.artifact.detail(initial.artifactId),
    queryFn: () => getArtifactDetail(initial.artifactId),
  });
  const library = useQuery({ ...libraryOwnedQuery, refetchInterval: false });
  const revisionNumber =
    detail.data?.ok && detail.data.value.revision !== null ? detail.data.value.revision.revisionNumber : null;
  const documentTitle = (detail.data?.ok ? detail.data.value.title : null) ?? "Untitled design";
  const owned = library.data?.ok === true && library.data.value.some((entry) => entry.id === initial.artifactId);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frameDrag = useRef<FrameDrag | null>(null);
  const frameDragged = useRef(false);
  const marqueeStart = useRef<{ clientX: number; clientY: number } | null>(null);
  const marqueeDragged = useRef(false);
  const nodeDragged = useRef(false);
  const layerDrag = useRef<LayerDrag | null>(null);
  const layerDragged = useRef(false);
  const panDrag = useRef<PanDrag | null>(null);
  const spaceHeld = useRef(false);
  const undoStack = useRef<Scene[]>([]);
  const redoStack = useRef<Scene[]>([]);
  const textEdit = useRef<TextEdit | null>(null);

  useEffect(() => {
    const controller = new SceneAutosave(initial, sceneSaver(initial.artifactId), setState, () => {});
    session.current = controller;
    setState(controller.state);
    return () => {
      controller.dispose();
      session.current = null;
    };
  }, [initial]);

  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const measure = () => setViewport({ w: element.clientWidth, h: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!session.current?.state.dirty && session.current?.state.status !== "restoring") return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const scene = state.scene;
  const pages = scenePages(scene);
  const page = scenePageOf(scene, activePage);
  const pageContent = scenePageContent(scene, page?.id);
  const frames = pages.length === 0 ? scene.frames : pageContent.frames;
  const looseNodes = scene.nodes ?? [];
  const visibleNotes = pages.length === 0 ? looseNodes : pageContent.notes;
  const frame: SceneFrame | null = frames.find((entry) => entry.id === activeFrame) ?? frames[0] ?? null;
  const layout = surfaceLayout(frames, visibleNotes);
  const hasSurface = frames.length > 0 || visibleNotes.length > 0;
  const fitZoom = fitScale(
    { w: layout.width, h: layout.height },
    { w: viewport.w, h: Math.max(0, viewport.h - FLOATING_INSET * 2) },
  );
  const scale = hasSurface ? (fitted ? fitZoom : zoom) : 1;
  const fitPan = {
    x: Math.round((viewport.w - layout.width * fitZoom) / 2),
    y: Math.round((viewport.h - layout.height * fitZoom) / 2),
  };
  const view = fitted ? fitPan : pan;
  const placementOf = (id: string) =>
    layout.placements.find((entry) => entry.frameId === id) ?? { frameId: id, x: 0, y: 0 };
  const readOnly =
    state.status === "readonly" ||
    state.status === "conflict" ||
    state.status === "restoring" ||
    state.code === "reload_required";
  const selectedNode: SceneNode | null =
    selected.length === 1 ? (locateNode(scene, selected[0] ?? "")?.node ?? null) : null;
  const busy = state.status === "saving" || state.status === "restoring";
  const isSelected = (id: string) => selected.includes(id);
  const framePoint = (clientX: number, clientY: number, frameId: string): Point => {
    const bounds = stage.current?.getBoundingClientRect();
    const unit = scale === 0 ? 1 : scale;
    const at = placementOf(frameId);
    return {
      x: (clientX - (bounds?.left ?? 0) - view.x) / unit - at.x,
      y: (clientY - (bounds?.top ?? 0) - view.y) / unit - at.y,
    };
  };
  const marqueeSelection = (rect: SceneRect): string[] => {
    const offset = layout.origin;
    const loose = selectNodesInRect(visibleNotes, {
      x: rect.x + offset.x,
      y: rect.y + offset.y,
      w: rect.w,
      h: rect.h,
    });
    if (frame === null) return loose;
    const at = placementOf(frame.id);
    const inside = selectNodesInRect(frame, { x: rect.x - at.x, y: rect.y - at.y, w: rect.w, h: rect.h });
    return [...inside, ...loose];
  };

  const zoomAt = useCallback(
    (screenX: number, screenY: number, factor: number) => {
      const next = zoomBy(scale, factor);
      if (next === scale) return;
      const unit = scale === 0 ? 1 : scale;
      const originX = (screenX - view.x) / unit;
      const originY = (screenY - view.y) / unit;
      setFitted(false);
      setZoom(next);
      setPan({ x: screenX - originX * next, y: screenY - originY * next });
    },
    [scale, view.x, view.y],
  );

  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!hasSurface) return;
      if (event.target instanceof Element && event.target.closest(".canvas-frames-panel, .canvas-shortcuts")) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const bounds = element.getBoundingClientRect();
        zoomAt(event.clientX - bounds.left, event.clientY - bounds.top, Math.exp(-event.deltaY / WHEEL_ZOOM_STEP));
        return;
      }
      event.preventDefault();
      const moved = wheelPan(event.deltaX, event.deltaY, event.shiftKey);
      setFitted(false);
      setPan({ x: view.x + moved.x, y: view.y + moved.y });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [hasSurface, zoomAt, view.x, view.y]);

  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]") !== null;
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space" && !typing(event.target)) spaceHeld.current = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeld.current = false;
    };
    const blur = () => {
      spaceHeld.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const update = useCallback((next: Scene) => {
    session.current?.change(next);
  }, []);

  const showPage = (id: string) => {
    setActivePage(id);
    setSelected([]);
    const target = scene.frames.find((entry) => (entry.page ?? pages[0]?.id) === id);
    setActiveFrame(target?.id ?? null);
  };

  const createPage = () => {
    const id = `page-${crypto.randomUUID()}`;
    const next = addScenePage(scene, { id, name: `Page ${pages.length + 1}` });
    if (next === scene) return;
    editScene(next);
    setActivePage(id);
  };

  const renamePage = (name: string) => {
    if (page === null) return;
    const next = renameScenePage(scene, page.id, name);
    if (next !== scene) editScene(next);
  };

  const movePage = (delta: number) => {
    if (page === null) return;
    const index = pages.findIndex((entry) => entry.id === page.id);
    const next = reorderScenePage(scene, page.id, index + delta);
    if (next !== scene) editScene(next);
  };

  const dropPage = () => {
    if (page === null) return;
    const next = removeScenePage(scene, page.id);
    if (next === scene) return;
    editScene(next);
    setActivePage(null);
  };

  const assignSelectionToPage = (id: string) => {
    let next = scene;
    const target = id === "" ? null : id;
    if (frame !== null) next = assignFramePage(next, frame.id, target);
    for (const nodeId of selected)
      if (locateNode(scene, nodeId)?.frame === null) next = assignNotePage(next, nodeId, target);
    if (next !== scene) editScene(next);
  };

  const toggleFrameLock = () => {
    if (frame === null) return;
    editScene(setFrameLocked(scene, frame.id, !frameIsLocked(frame)));
  };

  const chooseGuides = (kind: string) => {
    editScene(setSceneGuides(scene, kind === "" ? null : { ...DEFAULT_SCENE_GUIDES, kind: kind as SceneGuideKind }));
    setGuidesVisible(kind !== "");
  };

  const commitEdit = useCallback((before: Scene) => {
    const next = commitHistory(undoStack.current, redoStack.current, before);
    undoStack.current = next.undo;
    redoStack.current = next.redo;
  }, []);

  const editScene = useCallback(
    (next: Scene) => {
      const current = session.current?.state.scene ?? scene;
      if (next !== current) commitEdit(current);
      update(next);
    },
    [commitEdit, scene, update],
  );

  const endTextEdit = useCallback(() => {
    const pending = textEdit.current;
    textEdit.current = null;
    if (pending === null) return;
    const current = session.current?.state.scene ?? scene;
    if (canonicalScene(pending.snapshot) === canonicalScene(current)) return;
    commitEdit(pending.snapshot);
  }, [commitEdit, scene]);

  const trackTextEdit = useCallback(() => {
    if (selectedNode === null) return;
    const pending = textEdit.current;
    if (pending !== null && pending.id !== selectedNode.id) endTextEdit();
    if (textEdit.current === null)
      textEdit.current = { id: selectedNode.id, snapshot: session.current?.state.scene ?? scene };
  }, [endTextEdit, scene, selectedNode]);

  const undo = useCallback(() => {
    if (readOnly) return;
    endTextEdit();
    const step = undoHistory(undoStack.current, redoStack.current, session.current?.state.scene ?? scene);
    if (step === null) return;
    undoStack.current = step.undo;
    redoStack.current = step.redo;
    update(step.scene);
  }, [endTextEdit, readOnly, scene, update]);

  const redo = useCallback(() => {
    if (readOnly) return;
    endTextEdit();
    const step = redoHistory(undoStack.current, redoStack.current, session.current?.state.scene ?? scene);
    if (step === null) return;
    undoStack.current = step.undo;
    redoStack.current = step.redo;
    update(step.scene);
  }, [endTextEdit, readOnly, scene, update]);

  const toggle = (id: string) => {
    setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  };

  const add = (kind: "text" | "rect") => {
    if (frame === null || readOnly) return;
    const id = crypto.randomUUID();
    editScene(kind === "text" ? addTextNode(scene, frame.id, id) : addRectNode(scene, frame.id, id));
    setSelected([id]);
  };

  const removeSelected = () => {
    if (selected.length === 0 || readOnly) return;
    editScene(withoutNodes(session.current?.state.scene ?? scene, selected));
    setSelected([]);
  };

  const bringSelectedToFront = () => {
    if (selected.length === 0 || readOnly) return;
    editScene(bringToFront(session.current?.state.scene ?? scene, selected));
  };

  const sendSelectedToBack = () => {
    if (selected.length === 0 || readOnly) return;
    editScene(sendToBack(session.current?.state.scene ?? scene, selected));
  };

  const showFrame = (id: string) => {
    endTextEdit();
    setActiveFrame(id);
    setSelected([]);
  };

  const stepFrame = useCallback(
    (delta: number) => {
      if (frames.length === 0) return;
      const at = Math.max(
        0,
        frames.findIndex((entry) => entry.id === activeFrame),
      );
      const next = frames[Math.min(frames.length - 1, Math.max(0, at + delta))];
      if (next !== undefined) {
        endTextEdit();
        setActiveFrame(next.id);
        setSelected([]);
      }
    },
    [frames, activeFrame, endTextEdit],
  );

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey) {
        if ((event.key === "z" || event.key === "Z") && !event.altKey && !readOnly) {
          event.preventDefault();
          if (event.shiftKey) redo();
          else undo();
        }
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]")) return;
      if (event.altKey) {
        const step = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
        if (step === 0 || selected.length === 0 || readOnly) return;
        event.preventDefault();
        editScene(nudgeSelection(session.current?.state.scene ?? scene, selected, step));
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selected.length === 0 || readOnly) return;
        event.preventDefault();
        editScene(withoutNodes(session.current?.state.scene ?? scene, selected));
        setSelected([]);
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        setHelpOpen((open) => !open);
        return;
      }
      if (event.key === "Escape") {
        setHelpOpen(false);
        endTextEdit();
        marqueeStart.current = null;
        marqueeDragged.current = false;
        setMarquee(null);
        setSelected([]);
        return;
      }
      const delta =
        event.key === "ArrowRight" || event.key === "PageDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "PageUp"
            ? -1
            : 0;
      if (delta === 0) return;
      event.preventDefault();
      stepFrame(delta);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [selected, readOnly, scene, stepFrame, editScene, endTextEdit, redo, undo]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>, node: SceneNode, mode: Mode) => {
    if (readOnly || event.button !== 0) return;
    event.stopPropagation();
    nodeDragged.current = false;
    endTextEdit();
    if (event.shiftKey) {
      event.preventDefault();
      return;
    }
    const group = mode === "move" && isSelected(node.id) && selected.length > 1;
    if (!group) setSelected([node.id]);
    drag.current = {
      nodeId: node.id,
      ids: group ? selected : [node.id],
      mode: group ? "group" : mode,
      startX: event.clientX,
      startY: event.clientY,
      snapshot: session.current?.state.scene ?? scene,
      origin: { x: node.x, y: node.y, w: node.w, h: node.h },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (current === null) return;
    const unit = scale === 0 ? 1 : scale;
    const dx = (event.clientX - current.startX) / unit;
    const dy = (event.clientY - current.startY) / unit;
    nodeDragged.current = nodeDragged.current || Math.abs(dx) >= DRAG_THRESHOLD || Math.abs(dy) >= DRAG_THRESHOLD;
    if (current.mode === "group") {
      if (!nodeDragged.current) return;
      update(moveNodes(current.snapshot, current.ids, dx, dy));
      return;
    }
    const next =
      current.mode === "move"
        ? moveNode(current.snapshot, current.nodeId, dx, dy)
        : resizeNode(
            current.snapshot,
            current.nodeId,
            current.mode === "height" ? current.origin.w : current.origin.w + dx,
            current.mode === "width" ? current.origin.h : current.origin.h + dy,
          );
    update(next);
  };
  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (current === null) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!nodeDragged.current) return;
    if (canonicalScene(current.snapshot) === canonicalScene(session.current?.state.scene ?? scene)) return;
    commitEdit(current.snapshot);
  };
  const layerDropIndex = (pending: LayerDrag, clientY: number): number => {
    const steps = Math.round((clientY - pending.startY) / pending.rowHeight);
    const row = Math.min(pending.count - 1, Math.max(0, pending.index + steps));
    return pending.count - 1 - row;
  };
  const startLayerDrag = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (readOnly || event.button !== 0) return;
    const container = locateNode(scene, id)?.frame;
    if (container === undefined) return;
    const rows = layerRows(container ?? { nodes: visibleNotes });
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return;
    event.stopPropagation();
    layerDragged.current = false;
    layerDrag.current = {
      id,
      pointerId: event.pointerId,
      startY: event.clientY,
      rowHeight: Math.max(1, event.currentTarget.getBoundingClientRect().height),
      index,
      count: rows.length,
      snapshot: session.current?.state.scene ?? scene,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onLayerDragMove = (event: ReactPointerEvent<HTMLElement>) => {
    const pending = layerDrag.current;
    if (pending === null || pending.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientY - pending.startY) >= LAYER_THRESHOLD) layerDragged.current = true;
  };
  const endLayerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const pending = layerDrag.current;
    if (pending === null) return;
    layerDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!layerDragged.current) return;
    const current = session.current?.state.scene ?? scene;
    const next = reorderNodeTo(current, pending.id, layerDropIndex(pending, event.clientY));
    if (next === current) return;
    commitEdit(pending.snapshot);
    update(next);
  };
  const cancelLayerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    layerDrag.current = null;
    layerDragged.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    panDrag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: view };
    setFitted(false);
    setPan(view);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPanMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = panDrag.current;
    if (pending === null || pending.pointerId !== event.pointerId) return;
    setPan({
      x: pending.origin.x + (event.clientX - pending.startX),
      y: pending.origin.y + (event.clientY - pending.startY),
    });
  };
  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panDrag.current === null) return;
    panDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const startStageGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 1 || (event.button === 0 && spaceHeld.current)) {
      event.preventDefault();
      startPan(event);
      return;
    }
    if (!readOnly && frame !== null && startGroupDrag(event, frame)) {
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    startMarquee(event);
  };
  const onStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current !== null) {
      onPointerMove(event);
      return;
    }
    if (panDrag.current !== null) {
      onPanMove(event);
      return;
    }
    onMarqueeMove(event);
  };
  const onStagePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current !== null) {
      endDrag(event);
      return;
    }
    if (panDrag.current !== null) {
      endPan(event);
      return;
    }
    endMarquee(event);
  };
  const onStagePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current !== null) {
      drag.current = null;
      nodeDragged.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (panDrag.current !== null) {
      endPan(event);
      return;
    }
    cancelMarquee(event);
  };
  const startMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    marqueeStart.current = { clientX: event.clientX, clientY: event.clientY };
    marqueeDragged.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onMarqueeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = marqueeStart.current;
    if (start === null) return;
    const w = Math.abs(event.clientX - start.clientX);
    const h = Math.abs(event.clientY - start.clientY);
    if (!marqueeDragged.current && w < MARQUEE_THRESHOLD && h < MARQUEE_THRESHOLD) return;
    marqueeDragged.current = true;
    const bounds = stage.current?.getBoundingClientRect();
    setMarquee({
      x: Math.min(start.clientX, event.clientX) - (bounds?.left ?? 0),
      y: Math.min(start.clientY, event.clientY) - (bounds?.top ?? 0),
      w,
      h,
    });
  };
  const endMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    endTextEdit();
    const start = marqueeStart.current;
    const dragged = marqueeDragged.current;
    marqueeStart.current = null;
    marqueeDragged.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setMarquee(null);
    if (start === null) return;
    if (!dragged) {
      setSelected([]);
      return;
    }
    const unit = scale === 0 ? 1 : scale;
    const bounds = stage.current?.getBoundingClientRect();
    setSelected(
      marqueeSelection({
        x: (Math.min(start.clientX, event.clientX) - (bounds?.left ?? 0) - view.x) / unit,
        y: (Math.min(start.clientY, event.clientY) - (bounds?.top ?? 0) - view.y) / unit,
        w: Math.abs(event.clientX - start.clientX) / unit,
        h: Math.abs(event.clientY - start.clientY) / unit,
      }),
    );
  };
  const cancelMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    marqueeStart.current = null;
    marqueeDragged.current = false;
    setMarquee(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const startGroupDrag = (event: ReactPointerEvent<HTMLDivElement>, entry: SceneFrame): boolean => {
    if (entry.id !== frame?.id || selected.length < 2) return false;
    const bounds = selectionBounds(entry, selected);
    const point = framePoint(event.clientX, event.clientY, entry.id);
    if (bounds === null || !insideBounds(bounds, point)) return false;
    endTextEdit();
    nodeDragged.current = false;
    drag.current = {
      nodeId: selected[0] ?? "",
      ids: selected,
      mode: "group",
      startX: event.clientX,
      startY: event.clientY,
      snapshot: session.current?.state.scene ?? scene,
      origin: bounds,
    };
    return true;
  };
  const startFrameDrag = (event: ReactPointerEvent<HTMLDivElement>, entry: SceneFrame) => {
    if (readOnly || event.button !== 0 || spaceHeld.current) return;
    event.stopPropagation();
    frameDragged.current = false;
    if (startGroupDrag(event, entry)) {
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    showFrame(entry.id);
    frameDrag.current = {
      frameId: entry.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      unit: scale === 0 ? 1 : scale,
      snapshot: session.current?.state.scene ?? scene,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onFrameDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = frameDrag.current;
    if (pending === null || pending.pointerId !== event.pointerId) return;
    const dx = (event.clientX - pending.startX) / pending.unit;
    const dy = (event.clientY - pending.startY) / pending.unit;
    if (!frameDragged.current) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      frameDragged.current = true;
      setZoom(scale);
      setFitted(false);
      setPan(view);
    }
    update(moveFrame(pending.snapshot, layout.placements, pending.frameId, dx, dy));
  };
  const endFrameDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = frameDrag.current;
    if (pending === null) return;
    frameDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!frameDragged.current) return;
    if (canonicalScene(pending.snapshot) === canonicalScene(session.current?.state.scene ?? scene)) return;
    commitEdit(pending.snapshot);
  };
  const cancelFrameDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    frameDrag.current = null;
    frameDragged.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onFramePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current !== null) {
      onPointerMove(event);
      return;
    }
    onFrameDragMove(event);
  };
  const onFramePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current !== null) {
      endDrag(event);
      return;
    }
    endFrameDrag(event);
  };
  const onFramePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current !== null) {
      drag.current = null;
      nodeDragged.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    cancelFrameDrag(event);
  };

  const reload = async () => {
    const controller = session.current;
    if (controller === null || busy) return;
    if (controller.state.dirty && !window.confirm("Reload from server and discard your unsaved local edits?")) return;
    if (!controller.beginReload()) return;
    const result = await getScene(initial.artifactId);
    if (session.current !== controller) return;
    if (!result.ok) {
      controller.reject(result.code);
      return;
    }
    controller.replace(result.value);
    setActiveFrame(result.value.scene.frames[0]?.id ?? null);
    setSelected([]);
    undoStack.current = [];
    redoStack.current = [];
    textEdit.current = null;
  };
  const retry = () => session.current?.retry();
  const zoomLevel = Math.round(scale * 100);
  const layerRowList = frame === null ? [] : layerRows(frame);
  const looseRowList = layerRows({ nodes: visibleNotes });
  const inspectorOpen = selectedNode?.type === "text";
  const frameIndex = frame === null ? -1 : frames.findIndex((entry) => entry.id === frame.id);
  const nodeTypeOf = (id: string): SceneNode["type"] | null => locateNode(scene, id)?.node.type ?? null;
  const viewerHref = `/artifact/${encodeURIComponent(initial.artifactId)}`;

  const layerRow = (row: { id: string; label: string }) => {
    const type = nodeTypeOf(row.id);
    return (
      <div
        key={row.id}
        role="button"
        tabIndex={0}
        aria-selected={isSelected(row.id)}
        className={`canvas-layer-row${isSelected(row.id) ? " canvas-layer-row-selected" : ""}`}
        onPointerDown={(event) => startLayerDrag(event, row.id)}
        onPointerMove={onLayerDragMove}
        onPointerUp={endLayerDrag}
        onPointerCancel={cancelLayerDrag}
        onClick={(event) => {
          if (layerDragged.current) return;
          if (event.shiftKey) {
            toggle(row.id);
            return;
          }
          setSelected([row.id]);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (event.shiftKey) {
            toggle(row.id);
            return;
          }
          setSelected([row.id]);
        }}
      >
        <Icon name={type === "text" ? "text" : type === "image" ? "image" : "rect"} className="size-3.5" />
        <span>{row.label}</span>
      </div>
    );
  };

  const handles = (node: SceneNode) =>
    selectedNode?.id === node.id ? (
      <>
        <span
          aria-hidden="true"
          data-handle="width"
          className="canvas-handle canvas-handle-width"
          onPointerDown={(event) => startDrag(event, node, "width")}
        />
        <span
          aria-hidden="true"
          data-handle="height"
          className="canvas-handle canvas-handle-height"
          onPointerDown={(event) => startDrag(event, node, "height")}
        />
        <span
          aria-hidden="true"
          data-handle="both"
          className="canvas-handle canvas-handle-corner"
          onPointerDown={(event) => startDrag(event, node, "both")}
        />
      </>
    ) : null;

  const nodeMarkup = (node: SceneNode, active: boolean, offset: Point = NO_OFFSET) => (
    <div
      key={node.id}
      role="button"
      tabIndex={active ? 0 : -1}
      aria-label={nodeLabel(node)}
      aria-pressed={isSelected(node.id)}
      className={`canvas-node canvas-node-${node.type} ${isSelected(node.id) ? "canvas-node-selected" : ""}`}
      style={nodeStyle(node, offset)}
      onPointerDown={(event) => startDrag(event, node, "move")}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(event) => {
        event.stopPropagation();
        if (nodeDragged.current) return;
        if (event.shiftKey) {
          toggle(node.id);
          return;
        }
        setSelected([node.id]);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (event.shiftKey) {
          toggle(node.id);
          return;
        }
        setSelected([node.id]);
      }}
    >
      {node.type === "text" ? node.text : null}
      {node.type === "image" ? <span className="canvas-image-label">Image · {node.assetId.slice(0, 12)}</span> : null}
      {node.type === "path" ? (
        <svg aria-hidden="true" width="100%" height="100%" viewBox={`0 0 ${node.w} ${node.h}`} fill="none">
          <path
            d={node.d}
            fill={node.fill ?? "none"}
            stroke={node.stroke ?? "none"}
            strokeWidth={node.strokeWidth ?? 0}
          />
        </svg>
      ) : null}
      {handles(node)}
    </div>
  );

  return (
    <section aria-labelledby="editor-title" className="document-editor canvas-editor">
      <header className="canvas-topbar">
        <Tooltip disableHoverableContent>
          <TooltipTrigger asChild>
            <a className="canvas-topbar-home" href="/library" aria-label="Back to library">
              <Logo withWordmark={false} aria-hidden="true" />
            </a>
          </TooltipTrigger>
          <TooltipContent>Back to library</TooltipContent>
        </Tooltip>
        <h1 className="canvas-topbar-title">
          <Menu
            label="Document"
            width={260}
            trigger={
              <button type="button" className="canvas-topbar-doc">
                <span id="editor-title">{documentTitle}</span>
                <Icon name="chev" className="size-3.5" />
              </button>
            }
          >
            <MenuHead>{revisionNumber === null ? "Unpublished" : `Version ${revisionNumber}`}</MenuHead>
            {owned ? (
              <MenuItem icon="link" onClick={() => setPanel("share")}>
                Share…
              </MenuItem>
            ) : null}
            <MenuItem icon="ext" onClick={() => window.location.assign(viewerHref)}>
              Open in viewer
            </MenuItem>
            <MenuItem
              icon="refresh"
              disabled={busy}
              onClick={() => {
                void reload();
              }}
            >
              Reload from server
            </MenuItem>
            {owned ? (
              <>
                <MenuSeparator />
                <MenuItem icon="trash" danger onClick={() => setPanel("delete")}>
                  Delete…
                </MenuItem>
              </>
            ) : null}
          </Menu>
        </h1>
        <span role="status" aria-live="polite" className="canvas-save-state" data-state={state.status}>
          <span aria-hidden="true" className="canvas-save-dot" />
          {labels[state.status]}
        </span>
        {detail.data === undefined ? null : (
          <span
            className="text-[12px] text-fg-subtle"
            data-publication={state.seq > state.publishedSeq ? "unpublished" : "published"}
            title={
              state.seq > state.publishedSeq
                ? "The viewer keeps showing the published version until this draft is published."
                : "The viewer shows this version."
            }
          >
            {revisionNumber === null
              ? "Not published yet"
              : state.seq > state.publishedSeq
                ? `Unpublished changes · published v${revisionNumber}`
                : `Published · v${revisionNumber}`}
          </span>
        )}
        {owned ? (
          <button type="button" className="canvas-topbar-share" onClick={() => setPanel("share")}>
            Share
          </button>
        ) : null}
      </header>
      {state.status === "conflict" ? (
        <div role="alert" className="editor-notice">
          <p>
            Someone saved a newer version. Your local edits are kept here. Copy them before reloading; neither version
            will be overwritten.
          </p>
          <IconAction
            icon="refresh"
            label="Reload from server (discard local edits)"
            onClick={() => {
              void reload();
            }}
          />
        </div>
      ) : null}
      {state.status === "readonly" ? (
        <div role="status" className="editor-notice">
          <p>Read-only: you do not have editing permission. Autosave is stopped.</p>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div role="alert" className="editor-notice">
          <p>
            {state.code === "too_large"
              ? "This canvas is too large to save (maximum 16 MiB). Remove nodes, then retry."
              : state.code === "reload_required"
                ? "The current version could not be loaded. Reload before editing again."
                : "The save was not confirmed. Your local work remains here. Retry, or reload to check the server version."}
          </p>
          {state.code === "reload_required" ? null : <IconAction icon="refresh" label="Retry save" onClick={retry} />}
          <IconAction
            icon="refresh"
            label="Reload from server"
            onClick={() => {
              void reload();
            }}
          />
        </div>
      ) : null}
      <div className={`canvas-workspace${inspectorOpen ? " canvas-inspector-open" : ""}`}>
        <div className="canvas-stage-wrap" ref={stage}>
          <nav aria-label="Design pages" className="canvas-pages">
            {pages.length === 0 ? null : (
              <>
                {pages.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="canvas-page-button"
                    aria-current={entry.id === page?.id ? "true" : undefined}
                    onClick={() => showPage(entry.id)}
                  >
                    {entry.name}
                  </button>
                ))}
                <button type="button" className="canvas-page-action" onClick={createPage} disabled={readOnly}>
                  + Page
                </button>
                {page === null ? null : (
                  <>
                    <label className="canvas-page-field">
                      Page name
                      <input
                        value={page.name}
                        aria-label="Page name"
                        disabled={readOnly}
                        onChange={(event) => renamePage(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="canvas-page-action"
                      aria-label="Move page left"
                      disabled={readOnly}
                      onClick={() => movePage(-1)}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="canvas-page-action"
                      aria-label="Move page right"
                      disabled={readOnly}
                      onClick={() => movePage(1)}
                    >
                      →
                    </button>
                    <button
                      type="button"
                      className="canvas-page-action"
                      aria-label="Remove page"
                      disabled={readOnly}
                      onClick={dropPage}
                    >
                      ×
                    </button>
                    <label className="canvas-page-field">
                      Move selection to
                      <select
                        value={frame?.page ?? page.id}
                        aria-label="Move selection to page"
                        disabled={readOnly}
                        onChange={(event) => assignSelectionToPage(event.target.value)}
                      >
                        {pages.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </>
            )}
            {pages.length === 0 ? (
              <button type="button" className="canvas-page-action" onClick={createPage} disabled={readOnly}>
                Organize in pages
              </button>
            ) : null}
            <span aria-hidden="true" className="canvas-pill-separator" />
            <button
              type="button"
              className="canvas-page-action"
              aria-pressed={frame !== null && frameIsLocked(frame)}
              disabled={readOnly || frame === null}
              onClick={toggleFrameLock}
            >
              {frame !== null && frameIsLocked(frame) ? "Unlock" : "Lock"}
            </button>
            <select
              className="canvas-page-select"
              aria-label="Alignment guides"
              value={scene.guides?.kind ?? ""}
              disabled={readOnly}
              onChange={(event) => chooseGuides(event.target.value)}
            >
              <option value="">No guides</option>
              <option value="columns">Columns</option>
              <option value="rows">Rows</option>
              <option value="grid">Grid</option>
            </select>
            {scene.guides === undefined ? null : (
              <button
                type="button"
                className="canvas-page-action"
                aria-pressed={guidesVisible}
                onClick={() => setGuidesVisible((visible) => !visible)}
              >
                Guides
              </button>
            )}
          </nav>
          <div
            className="canvas-stage"
            onPointerDown={startStageGesture}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            onPointerCancel={onStagePointerCancel}
          >
            {hasSurface ? (
              <div
                className="canvas-surface"
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${scale})` }}
              >
                {guidesVisible && scene.guides !== undefined ? (
                  <div
                    aria-hidden="true"
                    className="canvas-guides"
                    data-guides-kind={scene.guides.kind}
                    style={{ width: layout.width, height: layout.height }}
                  >
                    {guideLines(scene.guides, { w: layout.width, h: layout.height }).map((line, index) => (
                      <span
                        key={index}
                        style={{ left: line.x, top: line.y, width: line.w, height: line.h }}
                      />
                    ))}
                  </div>
                ) : null}
                {frames.map((entry) => {
                  const at = placementOf(entry.id);
                  const active = entry.id === frame?.id;
                  return (
                    <div
                      key={entry.id}
                      className={`canvas-frame${active ? " canvas-frame-active" : ""}`}
                      data-frame-id={entry.id}
                      style={{ left: at.x, top: at.y, width: entry.w, height: entry.h }}
                      onPointerDown={(event) => startFrameDrag(event, entry)}
                      onPointerMove={onFramePointerMove}
                      onPointerUp={onFramePointerUp}
                      onPointerCancel={onFramePointerCancel}
                    >
                      {frameIsLocked(entry) ? <span className="canvas-frame-lock">Locked</span> : null}
                      {entry.source === undefined ? (
                        entry.nodes.map((node) => nodeMarkup(node, active))
                      ) : (
                        <ArtboardCard designId={initial.artifactId} frame={entry} />
                      )}
                    </div>
                  );
                })}
                {visibleNotes.map((node) => nodeMarkup(node, true, layout.origin))}
              </div>
            ) : (
              <p className="canvas-empty" role="status">
                This canvas has no frames yet.
              </p>
            )}
          </div>
          {marquee === null ? null : (
            <div
              aria-hidden="true"
              className="canvas-marquee"
              style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
            />
          )}
          <nav aria-label="Frames" className="canvas-frames-panel" data-open={framesOpen}>
            <button
              type="button"
              className="canvas-frames-toggle"
              aria-expanded={framesOpen}
              aria-label={
                frame === null
                  ? "Frames and layers"
                  : `Frames and layers: ${frame.name}, ${frameIndex + 1} of ${frames.length}`
              }
              onClick={() => setFramesOpen((open) => !open)}
            >
              <Icon name="layers" className="size-3.5" />
              <span className="canvas-frames-current">{framesOpen ? "Frames" : (frame?.name ?? "No frames")}</span>
              <span className="canvas-frames-count">
                {framesOpen || frame === null ? frames.length : `${frameIndex + 1}/${frames.length}`}
              </span>
              <Icon name="chev" className="canvas-frames-chev size-3.5" />
            </button>
            {framesOpen ? (
              <div className="canvas-frames-body">
                <ol className="canvas-frames-list">
                  {frames.map((entry, index) => {
                    const current = entry.id === frame?.id;
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          className="canvas-frame-row"
                          data-target={entry.id}
                          aria-current={current ? "true" : undefined}
                          onClick={() => showFrame(entry.id)}
                        >
                          <span className="canvas-frame-index">{index + 1}</span>
                          <span className="canvas-frame-name">{entry.name}</span>
                          <span className="canvas-frame-size">
                            {entry.w}×{entry.h}
                          </span>
                        </button>
                        {entry.source === undefined ? null : (
                          <ArtboardUpdateAction
                            designId={initial.artifactId}
                            frame={entry}
                            disabled={readOnly}

                          />
                        )}
                        {current ? (
                          <div role="group" aria-label="Layers" className="canvas-layers-list">
                            {layerRowList.length === 0 ? (
                              <p className="canvas-layers-empty">This frame has no nodes yet.</p>
                            ) : (
                              layerRowList.map(layerRow)
                            )}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
                {looseRowList.length === 0 ? null : (
                  <div role="group" aria-label="Canvas layers" className="canvas-layers-list canvas-layers-loose">
                    <p className="canvas-layers-heading">Canvas</p>
                    {looseRowList.map(layerRow)}
                  </div>
                )}
                <p className="canvas-frames-hint">Drag to reorder · Alt+↑/↓ moves the selection</p>
              </div>
            ) : null}
          </nav>
          <div role="toolbar" aria-label="Edit" className="canvas-pill">
            <IconAction
              icon="text"
              label="Add text"
              disabled={readOnly || frame === null}
              onClick={() => add("text")}
            />
            <IconAction
              icon="rect"
              label="Add rectangle"
              disabled={readOnly || frame === null}
              onClick={() => add("rect")}
            />
            <span aria-hidden="true" className="canvas-pill-separator" />
            {selected.length > 1 ? (
              <>
                <span aria-live="polite" className="canvas-pill-count">
                  {selected.length} selected
                </span>
                <IconAction
                  icon="front"
                  label="Bring selection to front"
                  disabled={readOnly}
                  onClick={bringSelectedToFront}
                />
                <IconAction
                  icon="back"
                  label="Send selection to back"
                  disabled={readOnly}
                  onClick={sendSelectedToBack}
                />
              </>
            ) : null}
            <IconAction
              icon="trash"
              label="Delete selection"
              className="canvas-pill-danger"
              disabled={readOnly || selected.length === 0}
              onClick={removeSelected}
            />
          </div>
          <div role="group" aria-label="Canvas zoom" className="canvas-zoom">
            <IconAction icon="min" label="Zoom out" onClick={() => zoomAt(viewport.w / 2, viewport.h / 2, 0.8)} />
            <output aria-label="Zoom level">{zoomLevel}%</output>
            <IconAction icon="plus" label="Zoom in" onClick={() => zoomAt(viewport.w / 2, viewport.h / 2, 1.25)} />
            <IconAction icon="max" label="Fit surface" aria-pressed={fitted} onClick={() => setFitted(true)} />
          </div>
          {helpOpen ? <ShortcutsPanel onClose={() => setHelpOpen(false)} /> : null}
          <button
            type="button"
            className="canvas-help"
            aria-label="Keyboard shortcuts"
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((open) => !open)}
          >
            ?
          </button>
        </div>
        {selectedNode?.type === "text" ? (
          <TextInspector
            node={selectedNode}
            disabled={readOnly}
            onChange={(patch) => {
              trackTextEdit();
              update(updateTextNode(session.current?.state.scene ?? scene, selectedNode.id, patch));
            }}
            onEndEdit={endTextEdit}
            onRemove={removeSelected}
          />
        ) : null}
      </div>
      {panel === "share" ? (
        <ShareModal artifactId={initial.artifactId} title={documentTitle} onClose={() => setPanel(null)} />
      ) : null}
      {panel === "delete" ? (
        <DeleteModal
          artifact={{ id: initial.artifactId, title: documentTitle, kind: "canvas" }}
          onDeleted={() => {
            void invalidateLibrary(client);
            window.location.assign("/library");
          }}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </section>
  );
}

const SHORTCUTS: { group: string; rows: [string, string][] }[] = [
  {
    group: "Edit",
    rows: [
      ["Undo", "Ctrl/⌘ Z"],
      ["Redo", "Ctrl/⌘ ⇧ Z"],
      ["Delete selection", "Del / ⌫"],
      ["Deselect", "Esc"],
      ["Move layer up / down", "Alt ↑ / Alt ↓"],
      ["Add to selection", "⇧ Click"],
    ],
  },
  {
    group: "Navigate",
    rows: [
      ["Previous / next frame", "← / →"],
      ["Previous / next frame", "PgUp / PgDn"],
      ["Pan", "Wheel · ⇧ Wheel"],
      ["Pan by dragging", "Space + drag"],
      ["Pan by dragging", "Middle button"],
      ["Zoom", "Ctrl/⌘ + Wheel"],
      ["Show shortcuts", "?"],
    ],
  },
];

function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  return (
    <section role="dialog" aria-label="Keyboard shortcuts" className="canvas-shortcuts">
      <div className="canvas-shortcuts-head">
        <h2>Keyboard shortcuts</h2>
        <IconAction icon="x" label="Close shortcuts" onClick={onClose} />
      </div>
      {SHORTCUTS.map((section) => (
        <div key={section.group} className="canvas-shortcuts-group">
          <h3 className="caps">{section.group}</h3>
          <dl>
            {section.rows.map(([label, keys]) => (
              <div key={`${label}-${keys}`}>
                <dt>{label}</dt>
                <dd>
                  <Kbd>{keys}</Kbd>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </section>
  );
}

function TextInspector({
  node,
  disabled,
  onChange,
  onEndEdit,
  onRemove,
}: {
  node: TextNode;
  disabled: boolean;
  onChange: (patch: { text?: string; style?: { fontSize?: number; fontWeight?: number; color?: string } }) => void;
  onEndEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <aside
      aria-label="Text properties"
      className="canvas-inspector"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        onEndEdit();
      }}
    >
      <h2 className="caps mb-3">Text</h2>
      <label className="canvas-field">
        <span>Content</span>
        <textarea
          aria-label="Text content"
          rows={3}
          disabled={disabled}
          value={node.text}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      </label>
      <label className="canvas-field">
        <span>Font size</span>
        <input
          type="number"
          aria-label="Font size"
          min={4}
          max={400}
          step={1}
          disabled={disabled}
          value={node.style?.fontSize ?? 16}
          onChange={(event) => onChange({ style: { fontSize: Number(event.target.value) } })}
        />
      </label>
      <label className="canvas-field">
        <span>Font weight</span>
        <input
          type="number"
          aria-label="Font weight"
          min={100}
          max={900}
          step={100}
          disabled={disabled}
          value={node.style?.fontWeight ?? 400}
          onChange={(event) => onChange({ style: { fontWeight: Number(event.target.value) } })}
        />
      </label>
      <label className="canvas-field">
        <span>Colour</span>
        <input
          type="color"
          aria-label="Text colour"
          disabled={disabled}
          value={node.style?.color ?? "#111111"}
          onChange={(event) => onChange({ style: { color: event.target.value } })}
        />
      </label>
      <Button variant="danger-ghost" size="sm" disabled={disabled} onClick={onRemove}>
        <Icon name="trash" className="size-3.5" />
        Delete node
      </Button>
    </aside>
  );
}
