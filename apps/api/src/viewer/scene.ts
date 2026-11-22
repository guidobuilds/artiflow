import {
  TEXT_ALIGNS,
  type ImageNode,
  type PathNode,
  type RectNode,
  type Scene,
  type SceneFrame,
  type SceneNode,
  type TextNode,
} from "@artiflow/domain/scene";

import { escapeAttribute } from "./html.ts";

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL_COLOR = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/+-]*\)$/;
const NAMED_COLOR = /^[a-zA-Z]{3,24}$/;

const safeColor = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const candidate = value.trim();
  const safe = HEX_COLOR.test(candidate) || FUNCTIONAL_COLOR.test(candidate) || NAMED_COLOR.test(candidate);
  return safe ? candidate : null;
};

const num = (value: number): string => String(Math.round((Number.isFinite(value) ? value : 0) * 1000) / 1000);
const px = (value: number): string => `${num(value)}px`;

const geometry = (node: SceneNode): string =>
  `left:${px(node.x)};top:${px(node.y)};width:${px(node.w)};height:${px(node.h)}`;

const renderRect = (node: RectNode): string => {
  const fill = safeColor(node.fill);
  const background = fill === null ? "" : `;background:${escapeAttribute(fill)}`;
  const radius =
    typeof node.radius === "number" && Number.isFinite(node.radius) && node.radius >= 0
      ? `;border-radius:${px(node.radius)}`
      : "";
  return `<div class="node node-rect" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node)}${background}${radius}"></div>`;
};

const renderText = (node: TextNode): string => {
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
  return `<div class="node node-text" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node)};font-size:${px(size)};font-weight:${weight};color:${escapeAttribute(color)};text-align:${align}">${escapeAttribute(node.text)}</div>`;
};

const renderImage = (node: ImageNode): string =>
  `<div class="node node-image" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node)}"><span class="node-image-label">Image</span><code class="node-image-id">${escapeAttribute(node.assetId)}</code></div>`;

const renderPath = (node: PathNode): string => {
  if (!(node.w > 0) || !(node.h > 0)) return "";
  const fill = safeColor(node.fill) ?? "none";
  const stroke = safeColor(node.stroke);
  const strokeWidth =
    typeof node.strokeWidth === "number" && Number.isFinite(node.strokeWidth) && node.strokeWidth > 0
      ? node.strokeWidth
      : 1;
  const strokeAttributes =
    stroke === null ? "" : ` stroke="${escapeAttribute(stroke)}" stroke-width="${num(strokeWidth)}"`;
  return `<svg class="node node-path" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node)}" viewBox="0 0 ${num(node.w)} ${num(node.h)}" fill="none" aria-hidden="true"><path d="${escapeAttribute(node.d)}" fill="${escapeAttribute(fill)}"${strokeAttributes}/></svg>`;
};

const renderNode = (node: SceneNode): string => {
  if (node.type === "rect") return renderRect(node);
  if (node.type === "text") return renderText(node);
  if (node.type === "image") return renderImage(node);
  if (node.type === "path") return renderPath(node);
  return "";
};

const renderFrame = (frame: SceneFrame, visible: boolean): string => {
  const label = `${frame.name}, ${num(frame.w)} by ${num(frame.h)}`;
  return `<section class="scene-frame" id="frame-${escapeAttribute(frame.id)}" data-frame-id="${escapeAttribute(frame.id)}" data-frame-w="${num(frame.w)}" data-frame-h="${num(frame.h)}"${visible ? "" : " hidden"} aria-label="${escapeAttribute(label)}">
<p class="scene-frame-name">${escapeAttribute(frame.name)}<span class="scene-frame-size">${num(frame.w)} × ${num(frame.h)}</span></p>
<div class="scene-frame-body" style="width:${px(frame.w)};height:${px(frame.h)}">${frame.nodes.map(renderNode).join("")}</div>
</section>`;
};

const renderIndex = (scene: Scene): string =>
  scene.frames
    .map(
      (frame, position) =>
        `<button type="button" data-target="${escapeAttribute(frame.id)}"${position === 0 ? ' aria-current="true"' : ""}>${escapeAttribute(frame.name)}</button>`,
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
@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;animation-duration:.01ms!important}}`;

const SCENE_SCRIPT = `(() => {
  const stage = document.getElementById("stage");
  const index = document.getElementById("frame-index");
  const fitControl = document.getElementById("fit");
  const frames = Array.from(document.querySelectorAll("[data-frame]"));
  const tabs = index === null ? [] : Array.from(index.querySelectorAll("button[data-target]"));
  const HASH_PREFIX = "#frame-";
  const MIN_SCALE = 0.02;
  const MAX_SCALE = 12;
  const FIT_RATIO = 0.86;
  const views = new Map();
  let active = null;
  let drag = null;
  let space = false;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const idOf = (frame) => frame.getAttribute("data-frame-id");
  const activeFrame = () => frames.find((frame) => idOf(frame) === active) || null;

  const sizeOf = (frame) => {
    const w = Number(frame.getAttribute("data-frame-w"));
    const h = Number(frame.getAttribute("data-frame-h"));
    return { w: Number.isFinite(w) && w > 0 ? w : 1, h: Number.isFinite(h) && h > 0 ? h : 1 };
  };

  const apply = (frame, view) => {
    frame.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.scale + ")";
  };

  const fit = (frame) => {
    const size = sizeOf(frame);
    const width = stage.clientWidth || 1;
    const height = stage.clientHeight || 1;
    const scale = clamp(Math.min(width / size.w, height / size.h) * FIT_RATIO, MIN_SCALE, MAX_SCALE);
    const view = { scale: scale, x: (width - size.w * scale) / 2, y: (height - size.h * scale) / 2 };
    views.set(idOf(frame), view);
    apply(frame, view);
    return view;
  };

  const readHash = () => {
    try {
      const hash = location.hash;
      return hash.indexOf(HASH_PREFIX) === 0 ? decodeURIComponent(hash.slice(HASH_PREFIX.length)) : "";
    } catch (error) {
      return "";
    }
  };

  const writeHash = (id) => {
    try {
      const next = HASH_PREFIX + encodeURIComponent(id);
      if (location.hash !== next) history.replaceState(null, "", next);
    } catch (error) {
      return;
    }
  };

  const show = (id, sync) => {
    const target = frames.find((frame) => idOf(frame) === id) || frames[0];
    if (target === undefined) return;
    active = idOf(target);
    for (const frame of frames) frame.hidden = frame !== target;
    for (const tab of tabs) {
      if (tab.getAttribute("data-target") === active) tab.setAttribute("aria-current", "true");
      else tab.removeAttribute("aria-current");
    }
    fit(target);
    if (sync) writeHash(active);
  };

  const step = (delta) => {
    const at = frames.findIndex((frame) => idOf(frame) === active);
    if (at < 0) return;
    const next = frames[clamp(at + delta, 0, frames.length - 1)];
    if (next !== undefined) show(idOf(next), true);
  };

  const jump = (last) => {
    const next = last ? frames[frames.length - 1] : frames[0];
    if (next !== undefined) show(idOf(next), true);
  };

  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key;
    if (key === " " || key === "Spacebar") {
      space = true;
      return;
    }
    const delta = key === "ArrowRight" || key === "PageDown" ? 1 : key === "ArrowLeft" || key === "PageUp" ? -1 : 0;
    if (delta !== 0) {
      event.preventDefault();
      step(delta);
      return;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      jump(key === "End");
    }
  });

  document.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Spacebar") space = false;
  });

  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const frame = activeFrame();
      const view = views.get(active);
      if (frame === null || view === undefined) return;
      const box = stage.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      const next = clamp(view.scale * Math.exp(-event.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
      const ratio = next / view.scale;
      view.x = x - (x - view.x) * ratio;
      view.y = y - (y - view.y) * ratio;
      view.scale = next;
      apply(frame, view);
    },
    { passive: false },
  );

  stage.addEventListener("pointerdown", (event) => {
    if (!(event.button === 1 || (event.button === 0 && space))) return;
    event.preventDefault();
    drag = { x: event.clientX, y: event.clientY };
    if (typeof stage.setPointerCapture === "function") stage.setPointerCapture(event.pointerId);
  });

  stage.addEventListener("pointermove", (event) => {
    if (drag === null) return;
    const frame = activeFrame();
    const view = views.get(active);
    if (frame === null || view === undefined) return;
    view.x += event.clientX - drag.x;
    view.y += event.clientY - drag.y;
    drag = { x: event.clientX, y: event.clientY };
    apply(frame, view);
  });

  const endDrag = () => {
    drag = null;
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });

  if (fitControl !== null) {
    fitControl.addEventListener("click", () => {
      const frame = activeFrame();
      if (frame !== null) fit(frame);
    });
  }

  if (index !== null) {
    index.addEventListener("click", (event) => {
      const target = event.target;
      const tab = target !== null && typeof target.closest === "function" ? target.closest("button[data-target]") : null;
      if (tab === null) return;
      const id = tab.getAttribute("data-target");
      if (id !== null) show(id, true);
    });
  }

  window.addEventListener("hashchange", () => {
    const id = readHash();
    if (id !== "") show(id, false);
  });

  window.addEventListener("resize", () => {
    const frame = activeFrame();
    if (frame !== null) fit(frame);
  });

  if (frames.length > 0) {
    const wanted = readHash();
    const known = frames.some((frame) => idOf(frame) === wanted);
    show(known ? wanted : idOf(frames[0]), false);
  }
})();`;

export function renderSceneDocument(scene: Scene): string {
  const empty = scene.frames.length === 0;
  const title = scene.frames[0]?.name ?? "Canvas";
  const chrome = empty
    ? `<div class="scene-stage" id="stage">
<p class="scene-empty">This canvas has no frames yet.</p>
</div>
<nav class="scene-index" id="frame-index" aria-label="Frames" hidden></nav>`
    : `<div class="scene-stage" id="stage">
<div class="scene-tools"><button type="button" id="fit" title="Fit the frame to the screen">Fit</button></div>
${scene.frames.map((frame, position) => renderFrame(frame, position === 0)).join("\n")}
</div>
<nav class="scene-index" id="frame-index" aria-label="Frames">${renderIndex(scene)}</nav>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="content-security-policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeAttribute(title)}</title>
<style>
${DOCUMENT_CSS}
</style></head>
<body>
${chrome}
<script>
${SCENE_SCRIPT}
</script>
</body></html>`;
}
