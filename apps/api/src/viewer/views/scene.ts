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
  type SceneFrame,
  type SceneNode,
  type TextNode,
} from "@artiflow/domain/scene";

import { presentsSlides } from "@artiflow/domain/kinds";
import { artifactView, originOf, sceneDocumentCsp, type ArtifactPage } from "../artifact.ts";
import { escapeAttribute } from "../chrome/theme.ts";
import { sceneThreadPlacement, type SceneThreadOrphan, type SceneThreadPin } from "../comments-data.ts";
import type { ViewerModel } from "../model.ts";
import { artboardControllerScript } from "./artboard-controller.ts";
import { canvasControllerScript } from "./canvas-controller.ts";
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

const renderRect = (node: RectNode, offset: NodeOffset = NO_OFFSET): string => {
  const fill = safeColor(node.fill);
  const background = fill === null ? "" : `;background:${escapeAttribute(fill)}`;
  const radius =
    typeof node.radius === "number" && Number.isFinite(node.radius) && node.radius >= 0
      ? `;border-radius:${px(node.radius)}`
      : "";
  return `<div class="node node-rect" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node, offset)}${background}${radius}"></div>`;
};

const renderText = (node: TextNode, offset: NodeOffset = NO_OFFSET): string => {
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
  return `<div class="node node-text" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node, offset)};font-size:${px(size)};font-weight:${weight};color:${escapeAttribute(color)};text-align:${align}">${escapeAttribute(node.text)}</div>`;
};

const imageUrl = (node: ImageNode, images: SceneImages): string | null => {
  if (!HEX_SHA256.test(node.assetId) || !images.digests.has(node.assetId)) return null;
  const token = images.token === undefined ? "" : `?token=${encodeURIComponent(images.token)}`;
  return `${images.origin}/artifact/${encodeURIComponent(images.artifactId)}/asset/${node.assetId}${token}`;
};

const renderImage = (node: ImageNode, images?: SceneImages, offset: NodeOffset = NO_OFFSET): string => {
  const url = images === undefined ? null : imageUrl(node, images);
  if (url === null)
    return `<div class="node node-image" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node, offset)}"><span class="node-image-label">Image</span><code class="node-image-id">${escapeAttribute(node.assetId)}</code></div>`;
  return `<img class="node node-image node-image-asset" data-node-id="${escapeAttribute(node.id)}" alt="${escapeAttribute(node.id)}" src="${escapeAttribute(url)}" style="${geometry(node, offset)};object-fit:contain">`;
};

const renderPath = (node: PathNode, offset: NodeOffset = NO_OFFSET): string => {
  if (!(node.w > 0) || !(node.h > 0)) return "";
  const fill = safeColor(node.fill) ?? "none";
  const stroke = safeColor(node.stroke);
  const strokeWidth =
    typeof node.strokeWidth === "number" && Number.isFinite(node.strokeWidth) && node.strokeWidth > 0
      ? node.strokeWidth
      : 1;
  const strokeAttributes =
    stroke === null ? "" : ` stroke="${escapeAttribute(stroke)}" stroke-width="${num(strokeWidth)}"`;
  return `<svg class="node node-path" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node, offset)}" viewBox="0 0 ${num(node.w)} ${num(node.h)}" fill="none" aria-hidden="true"><path d="${escapeAttribute(node.d)}" fill="${escapeAttribute(fill)}"${strokeAttributes}/></svg>`;
};

const renderNode = (node: SceneNode, images?: SceneImages, offset: NodeOffset = NO_OFFSET): string => {
  if (node.type === "rect") return renderRect(node, offset);
  if (node.type === "text") return renderText(node, offset);
  if (node.type === "image") return renderImage(node, images, offset);
  if (node.type === "path") return renderPath(node, offset);
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

const baseTagOf = (origin: string | null, artifactId: string): string =>
  origin === null ? "" : `<base href="${escapeAttribute(`${origin}/artifact/${encodeURIComponent(artifactId)}/`)}">`;

const sourcePageOf = (source: ArtboardSource, content: Extract<SceneArtboardContent, { kind: "ready" }>): string =>
  Buffer.from(`${baseTagOf(content.origin, source.artifactId)}${content.html}`, "utf8").toString("base64");

const initialViewportOf = (frame: SceneFrame, mode: ArtboardSource["mode"]): ArtboardViewportWidth => {
  if (mode === "fixed") return ARTBOARD_VIEWPORT_WIDTHS[0];
  const authored = ARTBOARD_VIEWPORT_WIDTHS.find((width) => width === frame.w);
  return authored ?? ARTBOARD_VIEWPORT_WIDTHS[ARTBOARD_VIEWPORT_WIDTHS.length - 1];
};

const renderViewportControls = (frame: SceneFrame, active: ArtboardViewportWidth): string =>
  `<span class="scene-artboard-bar" role="group" aria-label="Viewport width for ${escapeAttribute(frame.name)}">${ARTBOARD_VIEWPORT_WIDTHS.map(
    (width) =>
      `<button type="button" class="scene-artboard-width" data-artboard-width="${num(width)}" aria-pressed="${width === active ? "true" : "false"}">${num(width)}</button>`,
  ).join("")}<span class="scene-artboard-mode">Fluid</span></span>`;

const renderArtboard = (frame: SceneFrame, source: ArtboardSource, content: SceneArtboardContent | undefined): string => {
  const width = artboardViewportWidth(source, initialViewportOf(frame, source.mode), frame.w);
  if (content === undefined || content.kind === "unavailable") {
    const reason = content === undefined ? "forbidden" : content.reason;
    return `<div class="scene-artboard scene-artboard-unavailable" role="status" style="width:${px(frame.w)};height:${px(frame.h)}"><p>${ARTBOARD_UNAVAILABLE_TEXT[reason]}</p><span class="scene-artboard-name">${escapeAttribute(frame.name)}</span></div>`;
  }
  const bar =
    source.mode === "fluid"
      ? renderViewportControls(frame, initialViewportOf(frame, source.mode))
      : `<span class="scene-artboard-bar"><span class="scene-artboard-mode">Fixed ${num(frame.w)}</span></span>`;
  return `<div class="scene-artboard" style="width:${px(frame.w)};height:${px(frame.h)}"><iframe class="scene-artboard-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeAttribute(frame.name)}" src="data:text/html;base64,${sourcePageOf(source, content)}" style="width:${num(width)}px;height:100%"></iframe>${bar}</div>`;
};

const renderFrame = (
  frame: SceneFrame,
  visible: boolean,
  images?: SceneImages,
  pins: readonly SceneThreadPin[] = [],
  placement: FramePlacement | null = null,
  artboard?: SceneArtboardContent,
): string => {
  const source = frame.source;
  const revisionName = source === undefined ? "" : ` · ${revisionLabel(artboard?.kind === "ready" ? artboard.revisionNumber : null, source.revisionId)}`;
  const label = `${frame.name}, ${num(frame.w)} by ${num(frame.h)}${source === undefined ? "" : `, ${source.mode} artboard`}`;
  const placed =
    placement === null
      ? ""
      : ` data-frame-x="${num(placement.x)}" data-frame-y="${num(placement.y)}" style="left:${px(placement.x)};top:${px(placement.y)}"`;
  return `<section class="scene-frame" id="frame-${escapeAttribute(frame.id)}" data-frame-id="${escapeAttribute(frame.id)}" data-frame-w="${num(frame.w)}" data-frame-h="${num(frame.h)}"${placed}${visible ? "" : " hidden"} aria-label="${escapeAttribute(label)}">
<p class="scene-frame-name">${escapeAttribute(frame.name)}<span class="scene-frame-size">${num(frame.w)} × ${num(frame.h)}${revisionName}</span></p>
<div class="scene-frame-body${source === undefined ? "" : " scene-artboard-host"}" style="width:${px(frame.w)};height:${px(frame.h)}">${
    source === undefined
      ? `${frame.nodes.map((node) => renderNode(node, images)).join("")}${renderPins(pins)}`
      : renderArtboard(frame, source, artboard)
  }</div>
</section>`;
};

const renderCounter = (selectedIndex: number, total: number): string =>
  `<p class="scene-counter" id="frame-counter" aria-live="polite">${selectedIndex + 1} / ${total}</p>`;

const renderIndex = (scene: Scene, selectedId: string | null): string =>
  scene.frames
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
.scene-artboard-name{font:500 11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#8a9096}`;

const SLIDES_CSS = `.scene-slides{background-image:none}
.scene-counter{margin:0;display:grid;place-content:center;height:28px;padding:0 12px;border:1px solid #333333;border-radius:8px;background:#202020;color:#c3c8cd;font:500 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace}`;

const SURFACE_CSS = `.scene-surface{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}
.scene-frame-body{overflow:visible}`;

const BASE_DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export function renderSceneDocument(
  scene: Scene,
  frameId?: string,
  images?: SceneImages,
  threads: readonly { id: string; anchor?: unknown }[] = [],
  kind = "canvas",
  artboards: SceneArtboards = {},
): string {
  const slides = presentsSlides(kind);
  const origin = images === undefined ? null : originOf(images.origin);
  const source = images !== undefined && origin !== null ? { ...images, origin } : undefined;
  let policy = source === undefined ? BASE_DOCUMENT_CSP : sceneDocumentCsp(source.origin);
  const looseNodes = scene.nodes ?? [];
  const empty = scene.frames.length === 0 && (slides || looseNodes.length === 0);
  const title = scene.frames[0]?.name ?? (slides ? "Deck" : "Design");
  const selected = scene.frames.find((frame) => frame.id === frameId) ?? scene.frames[0];
  const selectedId = selected === undefined ? null : selected.id;
  const selectedIndex = selected === undefined ? 0 : scene.frames.indexOf(selected);
  const placement = sceneThreadPlacement(scene, threads);
  const orphans = renderOrphans(placement.orphans);
  const pinsOf = (id: string): SceneThreadPin[] => placement.pins.filter((pin) => pin.frameId === id);
  const surface = slides ? null : surfaceLayout(scene.frames, looseNodes);
  const surfaceOrigin = surface === null ? NO_OFFSET : surface.origin;
  const artboardOf = (frame: SceneFrame): SceneArtboardContent | undefined => {
    if (frame.source === undefined) return undefined;
    return Object.hasOwn(artboards, frame.id) ? artboards[frame.id] : undefined;
  };
  const hasArtboards = scene.frames.some((frame) => frame.source !== undefined);
  if (hasArtboards) policy = `${policy}; frame-src data:`;
  const placementOf = (id: string): FramePlacement => {
    const found = surface === null ? undefined : surface.placements.find((entry) => entry.frameId === id);
    return found === undefined ? { x: 0, y: 0 } : { x: found.x, y: found.y };
  };
  const requested = frameId !== undefined && scene.frames.some((frame) => frame.id === frameId) ? frameId : null;
  const looseOf = (): string => {
    if (slides || looseNodes.length === 0) return "";
    return `\n${looseNodes.map((node) => renderNode(node, source, surfaceOrigin)).join("")}`;
  };
  const slidesOf = scene.frames.map((frame) =>
    slides
      ? renderFrame(frame, frame.id === selectedId, source, pinsOf(frame.id), null, artboardOf(frame))
      : renderFrame(frame, true, source, pinsOf(frame.id), placementOf(frame.id), artboardOf(frame)),
  );
  const surfaceSize = `data-surface-w="${num(surface === null ? 0 : surface.width)}" data-surface-h="${num(surface === null ? 0 : surface.height)}"`;
  const indexHidden = scene.frames.length === 0 ? " hidden" : "";
  const activeAttribute = requested === null ? "" : ` data-active-frame="${escapeAttribute(requested)}"`;
  const chrome = empty
    ? slides
      ? `<div class="scene-stage scene-slides" id="stage">
<p class="scene-empty">This deck has no slides yet.</p>
</div>
<nav class="scene-index" id="frame-index" aria-label="Slides" hidden></nav>`
      : `<div class="scene-stage" id="stage">
<p class="scene-empty">This design has no frames yet.</p>
</div>
<nav class="scene-index" id="frame-index" aria-label="Frames" hidden></nav>`
    : slides
      ? `<div class="scene-stage scene-slides" id="stage">
<div class="scene-tools"><button type="button" id="prev" title="Previous slide">Back</button><button type="button" id="next" title="Next slide">Forward</button><button type="button" id="strip" aria-pressed="false" title="Show the slide list">Slides</button>${renderCounter(selectedIndex, scene.frames.length)}</div>
${slidesOf.join("\n")}
</div>
<nav class="scene-index" id="frame-index" aria-label="Slides" hidden>${renderIndex(scene, selectedId)}</nav>`
      : `<div class="scene-stage" id="stage">
<div class="scene-tools"><button type="button" id="fit" title="Fit the surface to the screen">Fit</button></div>
<div class="scene-surface" id="surface"${activeAttribute} ${surfaceSize}>
${slidesOf.join("\n")}${looseOf()}
</div>
</div>
<nav class="scene-index" id="frame-index" aria-label="Frames"${indexHidden}>${renderIndex(scene, selectedId)}</nav>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="content-security-policy" content="${policy}"><title>${escapeAttribute(title)}</title>
<style>
${slides ? `${DOCUMENT_CSS}\n${SLIDES_CSS}` : `${DOCUMENT_CSS}\n${SURFACE_CSS}`}${hasArtboards ? `\n${ARTBOARD_CSS}` : ""}
</style></head>
<body>
${chrome}${orphans === "" ? "" : `\n${orphans}`}
<script>
${slides ? deckControllerScript() : canvasControllerScript()}
</script>${hasArtboards ? `\n<script>\n${artboardControllerScript()}\n</script>` : ""}
</body></html>`;
}

export type SceneViewInput = {
  readonly scene: Scene;
  readonly frameId?: string | undefined;
  readonly images?: SceneImages | undefined;
  readonly threads?: readonly { id: string; anchor?: unknown }[];
  readonly kind?: string;
  readonly artboards?: SceneArtboards | undefined;
};

export const sceneView = (model: ViewerModel, input: SceneViewInput): ArtifactPage =>
  artifactView(model, {
    srcdoc: escapeAttribute(
      renderSceneDocument(input.scene, input.frameId, input.images, input.threads, input.kind, input.artboards ?? {}),
    ),
    images: input.images?.origin,
  });
