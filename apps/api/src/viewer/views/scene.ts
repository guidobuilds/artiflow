import {
  ARTBOARD_VIEWPORT_WIDTHS,
  TEXT_ALIGNS,
  artboardViewportWidth,
  surfaceLayout,
  type ArtboardSource,
  type ArtboardViewportWidth,
  type ImageNode,
  type PathNode,
  type RectNode,
  type Scene,
  type SceneCanvasNode,
  type SceneFrame,
  type SceneNode,
  type TextNode,
} from "@artiflow/domain/scene";

import { isArtboardAnchor } from "@artiflow/domain/comment-anchors";
import { designRequestReference, designRequestStatus, designRequestStatusLabel } from "@artiflow/domain/design-request";
import { presentsSlides } from "@artiflow/domain/kinds";
import { guideLines, scenePageContent, scenePages } from "@artiflow/domain/scene-pages";
import { sceneViewHref, type SceneViewPlan } from "@artiflow/domain/scene-link";
import { artifactView, originOf, sceneDocumentCsp, withDocumentPolicy, type ArtifactPage } from "../artifact.ts";
import { escapeAttribute, escapeJsonText } from "../chrome/theme.ts";
import { sceneThreadPlacement, type SceneThreadOrphan, type SceneThreadPin } from "../comments-data.ts";
import type { DesignRequestShellConfig, ViewerModel } from "../model.ts";
import { artboardControllerScript } from "./artboard-controller.ts";
import { canvasControllerScript } from "./canvas-controller.ts";
import { designRequestControllerScript, SCENE_REQUEST_STORAGE_KEY } from "../design-request-controller.ts";
import { selectionBridgeScript } from "../selection-bridge-script.ts";
import { deckControllerScript } from "./deck-controller.ts";

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL_COLOR = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/+-]*\)$/;
const NAMED_COLOR = /^[a-zA-Z]{3,24}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

export type SceneImages = {
  origin: string;
  artifactId: string;
  digests: ReadonlySet<string>;
  token?: string;
};

const safeColor = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const candidate = value.trim();
  const safe = HEX_COLOR.test(candidate) || FUNCTIONAL_COLOR.test(candidate) || NAMED_COLOR.test(candidate);
  return safe ? candidate : null;
};

const num = (value: number): string => String(Math.round((Number.isFinite(value) ? value : 0) * 1000) / 1000);
const px = (value: number): string => `${num(value)}px`;

type NodeOffset = { x: number; y: number };

const NO_OFFSET: NodeOffset = { x: 0, y: 0 };

const geometry = (node: SceneNode, offset: NodeOffset = NO_OFFSET): string =>
  `left:${px(node.x - offset.x)};top:${px(node.y - offset.y)};width:${px(node.w)};height:${px(node.h)}`;

type NodeDecoration = { readonly className: string; readonly attributes: string };

const NO_DECORATION: NodeDecoration = { className: "", attributes: "" };

const decorated = (decoration: NodeDecoration): string =>
  decoration.className === "" ? "" : ` ${escapeAttribute(decoration.className)}"${decoration.attributes}`;

const renderRect = (node: RectNode, offset: NodeOffset = NO_OFFSET, decoration = NO_DECORATION): string => {
  const fill = safeColor(node.fill);
  const background = fill === null ? "" : `;background:${escapeAttribute(fill)}`;
  const radius =
    typeof node.radius === "number" && Number.isFinite(node.radius) && node.radius >= 0
      ? `;border-radius:${px(node.radius)}`
      : "";
  return `<div class="node node-rect${decorated(decoration)}" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node, offset)}${background}${radius}"></div>`;
};

const renderText = (node: TextNode, offset: NodeOffset = NO_OFFSET, decoration = NO_DECORATION): string => {
  const style = node.style ?? {};
  const size =
    typeof style.fontSize === "number" && Number.isFinite(style.fontSize) && style.fontSize > 0 ? style.fontSize : 16;
  const weight =
    typeof style.fontWeight === "number" &&
    Number.isInteger(style.fontWeight) &&
    style.fontWeight >= 1 &&
    style.fontWeight <= 1000
      ? style.fontWeight
      : 400;
  const color = safeColor(style.color) ?? "#111111";
  const align =
    typeof style.align === "string" && (TEXT_ALIGNS as readonly string[]).includes(style.align) ? style.align : "left";
  return `<div class="node node-text${decorated(decoration)}" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node, offset)};font-size:${px(size)};font-weight:${weight};color:${escapeAttribute(color)};text-align:${align}">${escapeAttribute(node.text)}</div>`;
};

const imageUrl = (node: ImageNode, images: SceneImages): string | null => {
  if (!HEX_SHA256.test(node.assetId) || !images.digests.has(node.assetId)) return null;
  const token = images.token === undefined ? "" : `?token=${encodeURIComponent(images.token)}`;
  return `${images.origin}/artifact/${encodeURIComponent(images.artifactId)}/asset/${node.assetId}${token}`;
};

const renderImage = (
  node: ImageNode,
  images?: SceneImages,
  offset: NodeOffset = NO_OFFSET,
  decoration = NO_DECORATION,
): string => {
  const url = images === undefined ? null : imageUrl(node, images);
  if (url === null)
    return `<div class="node node-image${decorated(decoration)}" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node, offset)}"><span class="node-image-label">Image</span><code class="node-image-id">${escapeAttribute(node.assetId)}</code></div>`;
  return `<img class="node node-image node-image-asset${decorated(decoration)}" data-node-id="${escapeAttribute(node.id)}" alt="${escapeAttribute(node.id)}" src="${escapeAttribute(url)}" style="${geometry(node, offset)};object-fit:contain">`;
};

const renderPath = (node: PathNode, offset: NodeOffset = NO_OFFSET, decoration = NO_DECORATION): string => {
  if (!(node.w > 0) || !(node.h > 0)) return "";
  const fill = safeColor(node.fill) ?? "none";
  const stroke = safeColor(node.stroke);
  const strokeWidth =
    typeof node.strokeWidth === "number" && Number.isFinite(node.strokeWidth) && node.strokeWidth > 0
      ? node.strokeWidth
      : 1;
  const strokeAttributes =
    stroke === null ? "" : ` stroke="${escapeAttribute(stroke)}" stroke-width="${num(strokeWidth)}"`;
  return `<svg class="node node-path${decorated(decoration)}" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node, offset)}" viewBox="0 0 ${num(node.w)} ${num(node.h)}" fill="none" aria-hidden="true"><path d="${escapeAttribute(node.d)}" fill="${escapeAttribute(fill)}"${strokeAttributes}/></svg>`;
};

const renderNode = (
  node: SceneNode,
  images?: SceneImages,
  offset: NodeOffset = NO_OFFSET,
  decoration = NO_DECORATION,
): string => {
  if (node.type === "rect") return renderRect(node, offset, decoration);
  if (node.type === "text") return renderText(node, offset, decoration);
  if (node.type === "image") return renderImage(node, images, offset, decoration);
  if (node.type === "path") return renderPath(node, offset, decoration);
  return "";
};

const renderPins = (pins: readonly SceneThreadPin[]): string =>
  pins
    .map(
      (pin) =>
        `<span class="scene-pin" tabindex="0" data-thread-id="${escapeAttribute(pin.id)}" data-node-id="${escapeAttribute(pin.nodeId)}" aria-label="Comment thread ${pin.number}" style="left:${px(pin.left)};top:${px(pin.top)}">${pin.number}</span>`,
    )
    .join("");

const renderOrphans = (orphans: readonly SceneThreadOrphan[]): string =>
  orphans.length === 0
    ? ""
    : `<aside class="scene-orphans" aria-label="Comment threads without a node">
<p class="scene-orphans-title">Threads without a node</p>
<ul>${orphans
        .map((orphan) => `<li>Thread ${orphan.number} points at something that no longer exists in this canvas.</li>`)
        .join("")}</ul>
</aside>`;

type FramePlacement = { x: number; y: number };

export type SceneArtboardUnavailableReason = "forbidden" | "missing" | "too_large" | "not_html";

export type SceneArtboardContent =
  | {
      readonly kind: "ready";
      readonly html: string;
      readonly revisionNumber: number | null;
      readonly origin: string | null;
    }
  | { readonly kind: "unavailable"; readonly reason: SceneArtboardUnavailableReason };

export type SceneArtboards = Readonly<Record<string, SceneArtboardContent>>;

const ARTBOARD_UNAVAILABLE_TEXT: Record<SceneArtboardUnavailableReason, string> = {
  forbidden: "This proposal is not available to you.",
  missing: "The linked page is no longer available.",
  too_large: "This proposal is too large to show here.",
  not_html: "The linked page is not an HTML page.",
};

const revisionLabel = (number: number | null, revisionId: string): string =>
  number === null ? revisionId.slice(0, 8) : `v${number}`;

const sourcePageOf = (content: Extract<SceneArtboardContent, { kind: "ready" }>, bridge = ""): string =>
  Buffer.from(`${withDocumentPolicy(content.html)}${bridge}`, "utf8").toString("base64");

type ArtboardBridge = { readonly nonce: string; readonly script: string };

const artboardThreadPins = (
  threads: readonly { id: string; anchor?: unknown }[],
  frame: SceneFrame,
): { id: string; number: number; selector: string; textHint: string; x: number; y: number }[] =>
  threads.flatMap((thread, index) => {
    const anchor = thread.anchor;
    if (!isArtboardAnchor(anchor) || anchor.boardId !== frame.id) return [];
    if (frame.source === undefined || frame.source.revisionId !== anchor.revisionId) return [];
    return [
      {
        id: thread.id,
        number: index + 1,
        selector: anchor.selector,
        textHint: anchor.textHint,
        x: anchor.x,
        y: anchor.y,
      },
    ];
  });

const artboardBridgeOf = (
  frame: SceneFrame,
  threads: readonly { id: string; anchor?: unknown }[],
  request: DesignRequestShellConfig | undefined,
): ArtboardBridge | undefined => {
  if (request === undefined) return undefined;
  const nonce = `${request.nonce}:${frame.id}`;
  return {
    nonce,
    script: selectionBridgeScript({
      nonce,
      pins: artboardThreadPins(threads, frame),
      allowSelect: request.canComment,
    }),
  };
};

export type SceneRenderView =
  | { readonly kind: "canvas" }
  | { readonly kind: "focus"; readonly width: ArtboardViewportWidth }
  | { readonly kind: "play"; readonly width: ArtboardViewportWidth };

export const CANVAS_RENDER_VIEW: SceneRenderView = { kind: "canvas" };

export const renderViewOf = (plan: SceneViewPlan): SceneRenderView | undefined =>
  plan.kind === "canvas" ? undefined : { kind: plan.kind, width: plan.width };

const DEFAULT_VIEWPORT: ArtboardViewportWidth = 1280;

const initialViewportOf = (
  frame: SceneFrame,
  mode: ArtboardSource["mode"],
  view: SceneRenderView,
): ArtboardViewportWidth => {
  if (view.kind !== "canvas") return view.width;
  if (mode === "fixed") return DEFAULT_VIEWPORT;
  return ARTBOARD_VIEWPORT_WIDTHS.find((width) => width === frame.w) ?? DEFAULT_VIEWPORT;
};

const renderViewportControls = (frame: SceneFrame, active: ArtboardViewportWidth, view: SceneRenderView): string =>
  `<span class="scene-artboard-bar" role="group" aria-label="Viewport width for ${escapeAttribute(frame.name)}">${ARTBOARD_VIEWPORT_WIDTHS.map(
    (width) =>
      `<button type="button" class="scene-artboard-width" data-artboard-width="${num(width)}" aria-pressed="${width === active ? "true" : "false"}">${num(width)}</button>`,
  ).join("")}<span class="scene-artboard-mode">Fluid</span>${renderBarActions(frame, view)}</span>`;

const renderBarActions = (frame: SceneFrame, view: SceneRenderView): string => {
  if (view.kind === "play") return "";
  const enter =
    view.kind === "canvas"
      ? `<button type="button" class="scene-artboard-enter" data-scene-enter="focus" data-scene-target="${escapeAttribute(frame.id)}">Focus</button><button type="button" class="scene-artboard-enter" data-scene-enter="play" data-scene-target="${escapeAttribute(frame.id)}">Play</button>`
      : "";
  return `${enter}<button type="button" class="scene-artboard-back" data-scene-exit="true">Back to canvas</button>`;
};

const artboardWidthOf = (
  frame: SceneFrame,
  source: ArtboardSource,
  content: SceneArtboardContent | undefined,
  view: SceneRenderView,
): number =>
  content === undefined || content.kind !== "ready"
    ? frame.w
    : artboardViewportWidth(source, initialViewportOf(frame, source.mode, view), frame.w);

const renderArtboard = (
  frame: SceneFrame,
  source: ArtboardSource,
  content: SceneArtboardContent | undefined,
  view: SceneRenderView,
  boxWidth: number,
  bridge?: ArtboardBridge | undefined,
): string => {
  const width = artboardWidthOf(frame, source, content, view);
  if (content === undefined || content.kind === "unavailable") {
    const reason = content === undefined ? "forbidden" : content.reason;
    return `<div class="scene-artboard scene-artboard-unavailable" role="status" style="width:${px(boxWidth)};height:${px(frame.h)}"><p>${ARTBOARD_UNAVAILABLE_TEXT[reason]}</p><span class="scene-artboard-name">${escapeAttribute(frame.name)}</span></div>`;
  }
  const bar =
    view.kind === "play"
      ? ""
      : source.mode === "fluid"
        ? renderViewportControls(frame, initialViewportOf(frame, source.mode, view), view)
        : `<span class="scene-artboard-bar" role="group" aria-label="Artboard ${escapeAttribute(frame.name)}"><span class="scene-artboard-mode">Fixed ${num(frame.w)}</span>${renderBarActions(frame, view)}</span>`;
  return `<div class="scene-artboard" style="width:${px(boxWidth)};height:${px(frame.h)}"><iframe class="scene-artboard-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeAttribute(frame.name)}" src="data:text/html;base64,${sourcePageOf(content, bridge?.script ?? "")}" style="width:${num(width)}px;height:100%"></iframe>${bar}</div>`;
};

const renderFrame = (
  frame: SceneFrame,
  visible: boolean,
  images?: SceneImages,
  pins: readonly SceneThreadPin[] = [],
  placement: FramePlacement | null = null,
  artboard?: SceneArtboardContent,
  view: SceneRenderView = CANVAS_RENDER_VIEW,
  active = false,
  bridge?: ArtboardBridge | undefined,
): string => {
  const source = frame.source;
  const framed = view.kind !== "canvas";
  const revisionName =
    source === undefined
      ? ""
      : ` · ${revisionLabel(artboard?.kind === "ready" ? artboard.revisionNumber : null, source.revisionId)}`;
  const label = `${frame.name}, ${num(frame.w)} by ${num(frame.h)}${source === undefined ? "" : `, ${source.mode} artboard`}`;
  const boxWidth =
    source === undefined || view.kind === "canvas" ? frame.w : artboardWidthOf(frame, source, artboard, view);
  const styleOf = (width: string): string =>
    placement === null
      ? width === ""
        ? ""
        : ` style="${width}"`
      : ` style="left:${px(placement.x)};top:${px(placement.y)}${width === "" ? "" : `;${width}`}"`;
  const placed = placement === null ? "" : ` data-frame-x="${num(placement.x)}" data-frame-y="${num(placement.y)}"`;
  const artboardAttribute = source === undefined ? "" : ' data-artboard="true"';
  const activeAttribute = active ? ' data-scene-active="true"' : "";
  const lock =
    frame.locked === true && view.kind !== "play" ? '<span class="scene-frame-lock">Locked</span>' : "";
  const name =
    view.kind === "play"
      ? ""
      : `<p class="scene-frame-name">${escapeAttribute(frame.name)}${lock}<span class="scene-frame-size">${num(frame.w)} × ${num(frame.h)}${revisionName}</span></p>`;
  const pinMarks = framed ? "" : renderPins(pins);
  return `<section class="scene-frame" id="frame-${escapeAttribute(frame.id)}" data-frame-id="${escapeAttribute(frame.id)}" data-frame-w="${num(frame.w)}" data-frame-h="${num(frame.h)}"${artboardAttribute}${activeAttribute}${placed}${styleOf(framed ? `width:${px(boxWidth)}` : "")}${visible ? "" : " hidden"} aria-label="${escapeAttribute(label)}">
${name}
<div class="scene-frame-body${source === undefined ? "" : " scene-artboard-host"}" style="width:${px(boxWidth)};height:${px(frame.h)}">${
    source === undefined
      ? `${frame.nodes.map((node) => renderNode(node, images)).join("")}${pinMarks}`
      : renderArtboard(frame, source, artboard, view, boxWidth, bridge)
  }</div>
</section>`;
};

const renderCounter = (selectedIndex: number, total: number): string =>
  `<p class="scene-counter" id="frame-counter" aria-live="polite">${selectedIndex + 1} / ${total}</p>`;

const renderIndex = (frames: readonly SceneFrame[], selectedId: string | null): string =>
  frames
    .map(
      (frame) =>
        `<button type="button" data-target="${escapeAttribute(frame.id)}"${frame.id === selectedId ? ' aria-current="true"' : ""}>${escapeAttribute(frame.name)}</button>`,
    )
    .join("");

const DOCUMENT_CSS = `:root{color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{display:flex;flex-direction:column;overflow:hidden;background:#141414;color:#f4f4f2;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.scene-stage{position:relative;flex:1;min-height:0;overflow:hidden;touch-action:none;background-color:#1b1b1b;background-image:radial-gradient(circle at 1px 1px,#2b2b2b 1px,transparent 0);background-size:24px 24px}
.scene-frame{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}
.scene-frame[hidden]{display:none}
.scene-frame-name{display:flex;gap:8px;align-items:baseline;margin:0 0 6px;color:#a7adb3;font-size:12px;font-weight:500;white-space:nowrap}
.scene-frame-size{color:#71787e;font:11px ui-monospace,SFMono-Regular,Consolas,monospace}
.scene-frame-body{position:relative;overflow:hidden;background:#ffffff;border-radius:2px;box-shadow:0 10px 34px rgba(0,0,0,.5)}
.node{position:absolute}
.node-text{overflow:hidden;line-height:1.25;white-space:pre-wrap;overflow-wrap:anywhere}
.node-image{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;overflow:hidden;border:1px dashed #b3b9bf;border-radius:4px;background:repeating-linear-gradient(45deg,#f5f6f7,#f5f6f7 6px,#eceef0 6px,#eceef0 12px);color:#5c636a}
.node-image-label{font-size:9px;letter-spacing:.08em;text-transform:uppercase}
.node-image-id{max-width:100%;overflow:hidden;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
.node-image-asset{display:block;border:0;border-radius:0;background:none;object-fit:contain}
.scene-tools{position:absolute;top:12px;right:12px;z-index:2;display:flex;gap:6px}
.scene-tools button{height:28px;padding:0 12px;border:1px solid #333333;border-radius:8px;background:#202020;color:#f4f4f2;font:500 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}
.scene-tools button:hover{background:#2c2c2c}
.scene-tools button:focus-visible{outline:2px solid #ff6a2b;outline-offset:2px}
.scene-index{flex:0 0 auto;display:flex;gap:6px;overflow-x:auto;padding:8px 10px;border-top:1px solid #2a2a2a;background:#101010}
.scene-index[hidden]{display:none}
.scene-index button{flex:none;max-width:220px;height:28px;padding:0 12px;overflow:hidden;border:1px solid #333333;border-radius:8px;background:#1b1b1b;color:#c3c8cd;font:500 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.scene-index button:hover{background:#262626;color:#ffffff}
.scene-index button[aria-current="true"]{border-color:#ff6a2b;background:#2a1a12;color:#ffffff}
.scene-index button:focus-visible{outline:2px solid #ff6a2b;outline-offset:2px}
.scene-empty{position:absolute;inset:0;display:grid;place-content:center;margin:0;color:#9aa0a6;font-size:14px;text-align:center}
.scene-pin{position:absolute;display:grid;place-content:center;width:20px;height:20px;border-radius:999px;background:#ff6a2b;color:#170b05;font:600 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace;box-shadow:0 2px 8px rgba(0,0,0,.4);transform:translate(-50%,-50%)}
.scene-pin:focus-visible{outline:2px solid #ffffff;outline-offset:2px}
.scene-orphans{flex:0 0 auto;max-height:26%;overflow:auto;padding:8px 10px;border-top:1px solid #2a2a2a;background:#101010;color:#c3c8cd;font-size:12px}
.scene-orphans-title{margin:0 0 4px;color:#ff8a55;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.scene-orphans ul{margin:0;padding-left:16px}
.scene-orphans li{margin:2px 0}
@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;animation-duration:.01ms!important}}`;

const ARTBOARD_CSS = `.scene-artboard-host{overflow:hidden}
.scene-artboard{position:relative;overflow:hidden;background:#ffffff}
.scene-artboard-frame{display:block;border:0;background:#ffffff;height:100%;pointer-events:none}
.scene-artboard-bar{position:absolute;top:6px;right:6px;z-index:2;display:inline-flex;gap:4px;align-items:center;padding:3px 4px 3px 8px;border-radius:8px;background:rgba(20,20,20,.82);color:#c3c8cd;font:500 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace}
.scene-artboard-bar button{height:22px;min-width:34px;padding:0 6px;border:1px solid #3a3a3a;border-radius:5px;background:#1b1b1b;color:#c3c8cd;font:500 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace;cursor:pointer}
.scene-artboard-bar button:hover{background:#262626;color:#ffffff}
.scene-artboard-bar button[aria-pressed="true"]{border-color:#ff6a2b;background:#2a1a12;color:#ffffff}
.scene-artboard-bar button:focus-visible{outline:2px solid #ff6a2b;outline-offset:1px}
.scene-artboard-mode{color:#8f969d}
.scene-artboard-unavailable{display:grid;place-content:center;gap:6px;height:100%;padding:16px;text-align:center;color:#6b7178;background:#f4f4f2;font-size:12px}
.scene-artboard-unavailable p{margin:0}
.scene-artboard-name{font:500 11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#8a9096}
body[data-scene-view="focus"] .scene-tools,body[data-scene-view="play"] .scene-tools,body[data-scene-view="focus"] .scene-index,body[data-scene-view="play"] .scene-index,body[data-scene-view="focus"] .scene-pin,body[data-scene-view="play"] .scene-pin{display:none}
body[data-scene-view="focus"] .scene-frame:not([data-scene-active="true"]),body[data-scene-view="play"] .scene-frame:not([data-scene-active="true"]){display:none}
body[data-scene-view="focus"] .scene-frame-body,body[data-scene-view="play"] .scene-frame-body{box-shadow:none;border-radius:0}
body[data-scene-view="focus"] .scene-artboard-frame,body[data-scene-view="play"] .scene-artboard-frame{pointer-events:auto}
body[data-scene-view="focus"] .scene-artboard-enter,body[data-scene-view="play"] .scene-artboard-enter{display:none}
.scene-artboard-back{display:none}
body[data-scene-view="focus"] .scene-artboard-back{display:inline-flex}
body[data-scene-view="play"] .scene-artboard-bar{display:none}
#stage[data-request-selecting="true"] .scene-artboard-frame{pointer-events:auto;cursor:crosshair}
.scene-request-start{position:fixed;left:12px;bottom:12px;z-index:3;height:30px;padding:0 12px;border:1px solid #333333;border-radius:8px;background:#202020;color:#f4f4f2;font:500 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}
.scene-request-start:hover{background:#2c2c2c}
.scene-request-start[aria-pressed="true"]{border-color:#ff6a2b;background:#2a1a12;color:#ffffff}
.scene-request-start:focus-visible{outline:2px solid #ff6a2b;outline-offset:2px}
.scene-request-draft:empty{display:none}
.scene-request-draft{position:fixed;left:12px;bottom:52px;z-index:3;width:min(340px,calc(100vw - 24px));padding:10px;border:1px solid #3a3a3a;border-radius:10px;background:rgba(20,20,20,.96);color:#f4f4f2;font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.scene-request-draft-title{margin:0 0 2px;font-weight:600}
.scene-request-draft-where{margin:0 0 8px;color:#8f969d;font:11px ui-monospace,SFMono-Regular,Consolas,monospace}
.scene-request-draft-label{display:block;margin:0 0 8px}
.scene-request-draft-label textarea{display:block;width:100%;margin-top:4px;padding:6px;border:1px solid #3a3a3a;border-radius:6px;background:#141414;color:#f4f4f2;font:12px/1.4 system-ui;resize:vertical}
.scene-request-draft-actions{display:flex;gap:6px;margin:0}
.scene-request-draft-actions button{height:26px;padding:0 10px;border:1px solid #3a3a3a;border-radius:6px;background:#262626;color:#f4f4f2;font:500 12px/1 system-ui;cursor:pointer}
.scene-request-draft-actions button:first-child{border-color:#ff6a2b;background:#2a1a12}
[data-request-state]{margin:8px 0 0;font-size:11px}
[data-request-state][data-tone="error"]{color:#ff8a55}
[data-request-state][data-tone="saved"]{color:#7fd18b}
.scene-requests{position:fixed;right:12px;top:52px;z-index:3;width:min(320px,calc(100vw - 24px));max-height:60vh;overflow:auto;padding:10px;border:1px solid #3a3a3a;border-radius:10px;background:rgba(20,20,20,.96);color:#f4f4f2;font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.scene-requests-title{margin:0 0 6px;color:#c3c8cd;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.scene-requests ul{margin:0;padding:0;list-style:none}
.scene-request{padding:8px 0;border-top:1px solid #2a2a2a}
.scene-request:first-child{border-top:0}
.scene-request-head{display:flex;gap:6px;align-items:baseline;margin:0 0 4px}
.scene-request-number{display:grid;place-content:center;min-width:18px;height:18px;border-radius:999px;background:#ff6a2b;color:#170b05;font:600 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace}
.scene-request-artboard{font-weight:600}
.scene-request-status{margin-left:auto;padding:1px 6px;border:1px solid #3a3a3a;border-radius:999px;color:#c3c8cd;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
.scene-request-status[data-status="pending"]{border-color:#8f969d;color:#c3c8cd}
.scene-request-status[data-status="target_changed"],.scene-request-status[data-status="unavailable"]{border-color:#ff6a2b;color:#ff8a55}
.scene-request-body{margin:0 0 6px;white-space:pre-wrap}
.scene-request-unavailable{margin:0 0 6px;color:#ff8a55}
.scene-request-reference{display:block;margin:0 0 6px;color:#8f969d;font-size:11px}
.scene-request-reference textarea{display:block;width:100%;margin-top:4px;padding:6px;border:1px solid #3a3a3a;border-radius:6px;background:#141414;color:#c3c8cd;font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical}
.scene-request-show{height:24px;padding:0 8px;border:1px solid #3a3a3a;border-radius:6px;background:#262626;color:#f4f4f2;font:500 11px/1 system-ui;cursor:pointer}
body[data-scene-view="play"] .scene-request-start,body[data-scene-view="play"] .scene-request-draft,body[data-scene-view="play"] .scene-requests{display:none}
.scene-play-exit{position:fixed;top:12px;right:12px;z-index:3;height:30px;padding:0 12px;border:1px solid #333333;border-radius:8px;background:#202020;color:#f4f4f2;font:500 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}
.scene-play-exit:hover{background:#2c2c2c}
.scene-play-exit:focus-visible{outline:2px solid #ff6a2b;outline-offset:2px}`;

const PAGES_CSS = `.scene-frame-lock{margin-left:6px;padding:1px 5px;border:1px solid #3a3a3a;border-radius:999px;color:#c3c8cd;font:500 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace;text-transform:uppercase;letter-spacing:.04em}
.scene-pages{flex:0 0 auto;display:flex;gap:6px;overflow-x:auto;padding:8px 10px;border-top:1px solid #2a2a2a;background:#141414}
.scene-page{flex:none;height:26px;padding:0 10px;border:1px solid #333333;border-radius:6px;color:#c3c8cd;font:500 12px/26px system-ui,-apple-system,"Segoe UI",sans-serif;text-decoration:none}
.scene-page:hover{background:#262626;color:#ffffff}
.scene-page[aria-current="page"]{border-color:#ff6a2b;background:#2a1a12;color:#ffffff}
.scene-page:focus-visible{outline:2px solid #ff6a2b;outline-offset:1px}
.scene-guides{position:absolute;inset:0;display:none;pointer-events:none}
.scene-guides span{position:absolute;background:rgba(255,106,43,.08);box-shadow:inset 0 0 0 1px rgba(255,106,43,.35)}
.scene-stage[data-guides="on"] .scene-guides{display:block}
body[data-scene-view="focus"] .scene-guides,body[data-scene-view="play"] .scene-guides{display:none!important}`;

const SLIDES_CSS = `.scene-slides{background-image:none}
.scene-counter{margin:0;display:grid;place-content:center;height:28px;padding:0 12px;border:1px solid #333333;border-radius:8px;background:#202020;color:#c3c8cd;font:500 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace}`;

const SURFACE_CSS = `.scene-surface{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}
.scene-frame-body{overflow:visible}`;

const BASE_DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export type SceneRequestThread = {
  readonly id: string;
  readonly anchor?: unknown;
  readonly body?: string;
  readonly resolvedAt?: string | null;
};

export function renderSceneDocument(
  scene: Scene,
  frameId?: string,
  images?: SceneImages,
  threads: readonly SceneRequestThread[] = [],
  kind = "canvas",
  artboards: SceneArtboards = {},
  view: SceneRenderView = CANVAS_RENDER_VIEW,
  request?: DesignRequestShellConfig | undefined,
  pageId?: string | null,
): string {
  const slides = presentsSlides(kind);
  const framed = view.kind !== "canvas" && !slides;
  const pages = slides ? [] : scenePages(scene);
  const pageContent = scenePageContent(scene, pageId ?? null);
  const paged = !framed && pages.length > 0;
  const pageFrames = paged ? pageContent.frames : scene.frames;
  const pageNotes = paged ? pageContent.notes : (scene.nodes ?? []);
  const activePage = paged ? pageContent.page : null;
  const renderView: SceneRenderView = framed ? view : CANVAS_RENDER_VIEW;
  const origin = images === undefined ? null : originOf(images.origin);
  const source = images !== undefined && origin !== null ? { ...images, origin } : undefined;
  let policy = source === undefined ? BASE_DOCUMENT_CSP : sceneDocumentCsp(source.origin);
  const looseNodes = pageNotes;
  const empty = pageFrames.length === 0 && (slides || looseNodes.length === 0);
  const title = (paged ? activePage?.name : undefined) ?? pageFrames[0]?.name ?? (slides ? "Deck" : "Design");
  const selected = pageFrames.find((frame) => frame.id === frameId) ?? pageFrames[0];
  const selectedId = selected === undefined ? null : selected.id;
  const selectedIndex = selected === undefined ? 0 : pageFrames.indexOf(selected);
  const placement = sceneThreadPlacement(scene, threads);
  const orphans = renderOrphans(placement.orphans);
  const pinsOf = (id: string): SceneThreadPin[] => placement.pins.filter((pin) => pin.frameId === id);
  const surface = slides ? null : surfaceLayout(pageFrames, looseNodes);
  const surfaceOrigin = surface === null ? NO_OFFSET : surface.origin;
  const artboardOf = (frame: SceneFrame): SceneArtboardContent | undefined => {
    if (frame.source === undefined) return undefined;
    return Object.hasOwn(artboards, frame.id) ? artboards[frame.id] : undefined;
  };
  const hasArtboards = pageFrames.some((frame) => frame.source !== undefined);
  if (hasArtboards) policy = `${policy}; frame-src data:`;
  const requestPanelVisible = !slides && view.kind !== "play" && request !== undefined;
  const selectionEnabled = requestPanelVisible && request.canComment;
  const bridgeOf = (frame: SceneFrame): ArtboardBridge | undefined =>
    selectionEnabled && frame.source !== undefined && artboardOf(frame)?.kind === "ready"
      ? artboardBridgeOf(frame, threads, request)
      : undefined;
  const requestFrames = selectionEnabled
    ? scene.frames.flatMap((frame) => {
        const bridge = bridgeOf(frame);
        if (bridge === undefined || frame.source === undefined) return [];
        const content = artboardOf(frame);
        return [
          {
            id: frame.id,
            revisionId: frame.source.revisionId,
            revisionNumber: content?.kind === "ready" ? content.revisionNumber : null,
            name: frame.name,
            bridgeNonce: bridge.nonce,
          },
        ];
      })
    : [];
  const placementOf = (id: string): FramePlacement => {
    const found = surface === null ? undefined : surface.placements.find((entry) => entry.frameId === id);
    return found === undefined ? { x: 0, y: 0 } : { x: found.x, y: found.y };
  };
  const requested = frameId !== undefined && scene.frames.some((frame) => frame.id === frameId) ? frameId : null;
  const decorationOf = (node: SceneCanvasNode): NodeDecoration =>
    node.annotation === undefined
      ? NO_DECORATION
      : {
          className: "scene-annotation",
          attributes: ` data-annotation="${escapeAttribute(node.annotation.kind)}"`,
        };
  const looseOf = (): string => {
    if (slides || looseNodes.length === 0) return "";
    const visible = framed ? looseNodes.filter((node) => node.annotation === undefined) : looseNodes;
    return `\n${visible.map((node) => renderNode(node, source, surfaceOrigin, decorationOf(node))).join("")}`;
  };
  const slidesOf = pageFrames.map((frame) =>
    slides
      ? renderFrame(frame, frame.id === selectedId, source, pinsOf(frame.id), null, artboardOf(frame))
      : renderFrame(
          frame,
          true,
          source,
          pinsOf(frame.id),
          placementOf(frame.id),
          artboardOf(frame),
          renderView,
          framed && frame.id === selectedId,
          bridgeOf(frame),
        ),
  );
  const surfaceSize = `data-surface-w="${num(surface === null ? 0 : surface.width)}" data-surface-h="${num(surface === null ? 0 : surface.height)}"`;
  const indexHidden = pageFrames.length === 0 ? " hidden" : "";
  const guides =
    surface === null || scene.guides === undefined || framed
      ? []
      : guideLines(scene.guides, { w: surface.width, h: surface.height });
  const pagesOf = (): string => {
    if (!paged || pages.length === 0) return "";
    return `<nav class="scene-pages" id="scene-pages" aria-label="Design pages">${pages
      .map(
        (page) =>
          `<a class="scene-page" href="?page=${encodeURIComponent(page.id)}"${
            page.id === activePage?.id ? ' aria-current="page"' : ""
          }>${escapeAttribute(page.name)}</a>`,
      )
      .join("")}</nav>`;
  };
  const guidesOf = (): string =>
    guides.length === 0
      ? ""
      : `<div class="scene-guides" data-guides-kind="${escapeAttribute(scene.guides?.kind ?? "grid")}" aria-hidden="true">${guides
          .map(
            (line) =>
              `<span style="left:${px(line.x)};top:${px(line.y)};width:${px(line.w)};height:${px(line.h)}"></span>`,
          )
          .join("")}</div>`;
  const activeAttribute = requested === null ? "" : ` data-active-frame="${escapeAttribute(requested)}"`;
  const surfaceOf = (): string => `<div class="scene-surface" id="surface"${activeAttribute} ${surfaceSize}>
${guidesOf()}${slidesOf.join("\n")}${looseOf()}
</div>`;
  const singleChrome = (): string =>
    `<div class="scene-stage" id="stage"${guides.length === 0 ? "" : ' data-guides="off"'}>${
      view.kind === "play"
        ? '\n<button type="button" class="scene-play-exit" data-scene-exit="true">Exit Play</button>'
        : ""
    }
${surfaceOf()}
</div>`;
  const chrome = framed
    ? singleChrome()
    : empty
      ? slides
        ? `<div class="scene-stage scene-slides" id="stage">
<p class="scene-empty">This deck has no slides yet.</p>
</div>
<nav class="scene-index" id="frame-index" aria-label="Slides" hidden></nav>`
        : `<div class="scene-stage" id="stage">
<p class="scene-empty">This design has no frames yet.</p>
</div>
${pagesOf()}
<nav class="scene-index" id="frame-index" aria-label="Frames" hidden></nav>`
      : slides
        ? `<div class="scene-stage scene-slides" id="stage">
<div class="scene-tools"><button type="button" id="prev" title="Previous slide">Back</button><button type="button" id="next" title="Next slide">Forward</button><button type="button" id="strip" aria-pressed="false" title="Show the slide list">Slides</button>${renderCounter(selectedIndex, scene.frames.length)}</div>
${slidesOf.join("\n")}
</div>
<nav class="scene-index" id="frame-index" aria-label="Slides" hidden>${renderIndex(pageFrames, selectedId)}</nav>`
        : `<div class="scene-stage" id="stage"${guides.length === 0 ? "" : ' data-guides="off"'}>
<div class="scene-tools"><button type="button" id="fit" title="Fit the surface to the screen">Fit</button>${guides.length === 0 ? "" : '<button type="button" id="guides" aria-pressed="false" title="Show alignment guides">Guides</button>'}</div>
${surfaceOf()}
</div>
${pagesOf()}
<nav class="scene-index" id="frame-index" aria-label="Frames"${indexHidden}>${renderIndex(pageFrames, selectedId)}</nav>`;
  const requestOf = (thread: SceneRequestThread, index: number): string => {
    const anchor = thread.anchor;
    if (!isArtboardAnchor(anchor) || request === undefined) return "";
    const frame = scene.frames.find((candidate) => candidate.id === anchor.boardId);
    const content = frame === undefined ? undefined : artboardOf(frame);
    const available = content !== undefined && content.kind === "ready";
    const sourceRevisionId = frame?.source?.revisionId ?? null;
    const status = designRequestStatus({
      anchoredRevisionId: anchor.revisionId,
      currentSourceRevisionId: sourceRevisionId,
    });
    const label = available ? designRequestStatusLabel(status) : "Not available";
    const state = available ? status : "unavailable";
    const name = frame?.name ?? anchor.boardId;
    const link = sceneViewHref(`/artifact/${request.designId}`, {
      view: view.kind,
      frameId: anchor.boardId,
      width: view.kind === "canvas" ? null : view.width,
      page: null,
    });
    const reference = available
      ? designRequestReference({
          design: { id: request.designId, title: request.designTitle },
          link,
          artboard: { frameId: anchor.boardId, name },
          revision: { id: anchor.revisionId, number: content.revisionNumber },
          selection: {
            selector: anchor.selector,
            textHint: anchor.textHint,
            point: { x: anchor.x, y: anchor.y },
            viewportWidth: anchor.viewportWidth,
          },
          request: thread.body ?? "",
        })
      : null;
    const referenceText = reference !== null && reference.ok ? reference.text : "";
    const body =
      available && (thread.body ?? "").trim() !== ""
        ? `<p class="scene-request-body">${escapeAttribute(thread.body ?? "")}</p>`
        : "";
    const unavailable = available ? "" : '<p class="scene-request-unavailable">You cannot see this proposal.</p>';
    const copy =
      referenceText === ""
        ? ""
        : `<label class="scene-request-reference">Portable reference<textarea readonly rows="7" data-request-reference>${escapeAttribute(referenceText)}</textarea></label>`;
    return `<li class="scene-request" data-request-thread="${escapeAttribute(thread.id)}" data-request-frame="${escapeAttribute(anchor.boardId)}">
<p class="scene-request-head"><span class="scene-request-number">${index + 1}</span><span class="scene-request-artboard">${escapeAttribute(name)}</span><span class="scene-request-status" data-status="${state}">${escapeAttribute(label)}</span></p>
${body}${unavailable}${copy}<button type="button" class="scene-request-show" data-request-show="${escapeAttribute(thread.id)}" data-request-frame="${escapeAttribute(anchor.boardId)}">Show on artboard</button>
</li>`;
  };
  const requestCards = requestPanelVisible
    ? threads
        .map(requestOf)
        .filter((card) => card !== "")
        .join("\n")
    : "";
  const requestList =
    requestCards === ""
      ? ""
      : `\n<aside class="scene-requests" id="scene-requests" aria-label="Change requests">\n<p class="scene-requests-title">Change requests</p>\n<ul>\n${requestCards}\n</ul>\n</aside>`;
  const requestComposer =
    requestFrames.length === 0
      ? ""
      : `\n<button type="button" class="scene-request-start" data-request-start aria-pressed="false">Request change</button>\n<div id="scene-request-draft" class="scene-request-draft"></div>`;
  const requestUi = requestComposer + requestList;
  const requestConfig =
    requestFrames.length === 0
      ? ""
      : `\n<script type="application/json" id="${SCENE_REQUEST_STORAGE_KEY}">${escapeJsonText(
          JSON.stringify({
            nonce: request?.nonce ?? "",
            canComment: request?.canComment === true,
            frames: requestFrames,
          }),
        )}</script>`;

  const viewAttributes = framed ? ` data-scene-view="${view.kind}"` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="content-security-policy" content="${policy}"><title>${escapeAttribute(title)}</title>
<style>
${slides ? `${DOCUMENT_CSS}\n${SLIDES_CSS}` : `${DOCUMENT_CSS}\n${SURFACE_CSS}\n${PAGES_CSS}`}${hasArtboards ? `\n${ARTBOARD_CSS}` : ""}
</style></head>
${"<body"}${viewAttributes}>
${chrome}${requestUi}${orphans === "" ? "" : `\n${orphans}`}${requestConfig}
<script>
${slides ? deckControllerScript() : canvasControllerScript()}
</script>${hasArtboards ? `\n<script>\n${artboardControllerScript()}\n</script>` : ""}${requestFrames.length === 0 ? "" : `\n<script>\n${designRequestControllerScript()}\n</script>`}
</body></html>`;
}

export type SceneViewInput = {
  readonly scene: Scene;
  readonly frameId?: string | undefined;
  readonly images?: SceneImages | undefined;
  readonly threads?: readonly SceneRequestThread[];
  readonly kind?: string;
  readonly artboards?: SceneArtboards | undefined;
  readonly view?: SceneRenderView | undefined;
  readonly request?: DesignRequestShellConfig | undefined;
  readonly pageId?: string | null | undefined;
};

export const sceneView = (model: ViewerModel, input: SceneViewInput): ArtifactPage =>
  artifactView(model, {
    srcdoc: escapeAttribute(
      renderSceneDocument(
        input.scene,
        input.frameId,
        input.images,
        input.threads,
        input.kind,
        input.artboards ?? {},
        input.view ?? CANVAS_RENDER_VIEW,
        input.request ?? model.designRequest,
        input.pageId ?? null,
      ),
    ),
    images: input.images?.origin,
  });
