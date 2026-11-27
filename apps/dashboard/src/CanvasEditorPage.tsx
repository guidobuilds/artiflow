import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button.tsx";
import { Icon, IconAction } from "@/components/ui/icon.tsx";
import { Logo } from "@/components/ui/logo.tsx";
import { TextLink } from "@/components/ui/text-link.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { canonicalScene, type Scene, type SceneFrame, type SceneNode, type TextNode } from "@artiflow/domain/scene";
import { getArtifactDetail } from "./editor-api.ts";
import { queryKeys } from "./query/keys.ts";
import {
  addRectNode,
  addTextNode,
  bringToFront,
  fitScale,
  getScene,
  insideBounds,
  layerRows,
  moveFrame,
  moveNode,
  moveNodes,
  nudgeSelection,
  removeNode,
  reorderNodeTo,
  resizeNode,
  saveScene,
  selectNodesInRect,
  selectionBounds,
  sendToBack,
  surfaceLayout,
  updateTextNode,
  zoomBy,
  type SceneDraft,
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

const nodeStyle = (node: SceneNode): CSSProperties => {
  const box: CSSProperties = { left: node.x, top: node.y, width: node.w, height: node.h };
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
  const [layersOpen, setLayersOpen] = useState(false);
  const detail = useQuery({
    queryKey: queryKeys.artifact.detail(initial.artifactId),
    queryFn: () => getArtifactDetail(initial.artifactId),
  });
  const revisionNumber =
    detail.data?.ok && detail.data.value.revision !== null ? detail.data.value.revision.revisionNumber : null;
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
  const frames = scene.frames;
  const frame: SceneFrame | null = frames.find((entry) => entry.id === activeFrame) ?? frames[0] ?? null;
  const layout = surfaceLayout(frames);
  const fitZoom = fitScale({ w: layout.width, h: layout.height }, viewport);
  const scale = frame === null ? 1 : fitted ? fitZoom : zoom;
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
    selected.length === 1 ? (frame?.nodes.find((node) => node.id === selected[0]) ?? null) : null;
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
      if (frames.length === 0) return;
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
  }, [frames.length, zoomAt, view.x, view.y]);

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
      if (event.key === "Escape") {
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
    if (readOnly || event.button !== 0 || frame === null) return;
    const rows = layerRows(frame);
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
    if (!dragged || frame === null) {
      setSelected([]);
      return;
    }
    const unit = scale === 0 ? 1 : scale;
    const bounds = stage.current?.getBoundingClientRect();
    const at = placementOf(frame.id);
    const left = (Math.min(start.clientX, event.clientX) - (bounds?.left ?? 0) - view.x) / unit - at.x;
    const top = (Math.min(start.clientY, event.clientY) - (bounds?.top ?? 0) - view.y) / unit - at.y;
    setSelected(
      selectNodesInRect(frame, {
        x: left,
        y: top,
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
  const inspectorOpen = selectedNode?.type === "text";

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

  return (
    <section aria-labelledby="editor-title" className="document-editor canvas-editor">
      <header className="editor-topbar">
        <a className="editor-topbar-back" href="/library" aria-label="Back to library">
          <Icon name="left" />
        </a>
        <div className="editor-topbar-brand">
          <Logo withWordmark={false} aria-hidden="true" />
          <span>artiflow</span>
        </div>
        <div className="editor-topbar-title">
          <h1 id="editor-title">{frame?.name ?? "Untitled canvas"}</h1>
          {revisionNumber === null ? null : <span className="editor-topbar-version">v{revisionNumber}</span>}
        </div>
        <span role="status" aria-live="polite" className="editor-save-state" data-state={state.status}>
          <span aria-hidden="true">•</span>
          {labels[state.status]}
        </span>
        <nav aria-label="Canvas actions" className="editor-topbar-actions">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Toggle layers"
            aria-pressed={layersOpen}
            onClick={() => setLayersOpen((open) => !open)}
          >
            <Icon name="list" className="size-3.5" />
            Layers
          </Button>
          <Button size="sm" disabled={readOnly} onClick={() => add("text")}>
            <Icon name="plus" className="size-3.5" />
            Add text
          </Button>
          <Button size="sm" disabled={readOnly} onClick={() => add("rect")}>
            <Icon name="plus" className="size-3.5" />
            Add rectangle
          </Button>
          <IconAction
            icon="trash"
            label="Delete selection"
            disabled={readOnly || selected.length === 0}
            onClick={removeSelected}
          />
        </nav>
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
      <div
        className={`canvas-workspace${inspectorOpen ? " canvas-inspector-open" : ""}${layersOpen ? " canvas-layers-open" : ""}`}
      >
        <div className="canvas-stage-wrap" ref={stage}>
          <div
            className="canvas-stage"
            onPointerDown={startStageGesture}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            onPointerCancel={onStagePointerCancel}
          >
            {frame === null ? (
              <p className="canvas-empty" role="status">
                This canvas has no frames yet.
              </p>
            ) : (
              <div
                className="canvas-surface"
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${scale})` }}
              >
                {frames.map((entry) => {
                  const at = placementOf(entry.id);
                  const active = entry.id === frame.id;
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
                      {entry.nodes.map((node) => (
                        <div
                          key={node.id}
                          role="button"
                          tabIndex={active ? 0 : -1}
                          aria-label={nodeLabel(node)}
                          aria-pressed={isSelected(node.id)}
                          className={`canvas-node canvas-node-${node.type} ${isSelected(node.id) ? "canvas-node-selected" : ""}`}
                          style={nodeStyle(node)}
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
                          {node.type === "image" ? (
                            <span className="canvas-image-label">Image · {node.assetId.slice(0, 12)}</span>
                          ) : null}
                          {node.type === "path" ? (
                            <svg
                              aria-hidden="true"
                              width="100%"
                              height="100%"
                              viewBox={`0 0 ${node.w} ${node.h}`}
                              fill="none"
                            >
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
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {marquee === null ? null : (
            <div
              aria-hidden="true"
              className="canvas-marquee"
              style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
            />
          )}
          {selected.length > 1 ? (
            <div role="group" aria-label="Selection actions" className="canvas-selection-bar">
              <span aria-live="polite">{selected.length} selected</span>
              <Button
                size="sm"
                aria-label="Bring selection to front"
                disabled={readOnly}
                onClick={bringSelectedToFront}
              >
                Front
              </Button>
              <Button size="sm" aria-label="Send selection to back" disabled={readOnly} onClick={sendSelectedToBack}>
                Back
              </Button>
              <Button
                size="sm"
                variant="danger-ghost"
                aria-label="Delete selection"
                disabled={readOnly}
                onClick={removeSelected}
              >
                Delete
              </Button>
            </div>
          ) : null}
          <div role="group" aria-label="Canvas zoom" className="canvas-zoom">
            <IconAction icon="min" label="Zoom out" onClick={() => zoomAt(viewport.w / 2, viewport.h / 2, 0.8)} />
            <output aria-label="Zoom level">{zoomLevel}%</output>
            <IconAction icon="plus" label="Zoom in" onClick={() => zoomAt(viewport.w / 2, viewport.h / 2, 1.25)} />
            <Button
              size="sm"
              variant="ghost"
              aria-label="Fit surface"
              aria-pressed={fitted}
              onClick={() => setFitted(true)}
            >
              Fit
            </Button>
          </div>
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
        {layersOpen ? (
          <aside aria-label="Layers" className="canvas-layers">
            <h2 className="caps mb-3">Layers</h2>
            {layerRowList.length === 0 ? (
              <p className="canvas-layers-empty">This frame has no nodes yet.</p>
            ) : (
              <div className="canvas-layers-list">
                {layerRowList.map((row) => (
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
                    {row.label}
                  </div>
                ))}
              </div>
            )}
          </aside>
        ) : null}
      </div>
      <nav className="canvas-frames" aria-label="Frames">
        {frames.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-target={entry.id}
            aria-current={entry.id === frame?.id ? "true" : undefined}
            onClick={() => showFrame(entry.id)}
          >
            {entry.name}
          </button>
        ))}
      </nav>
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
