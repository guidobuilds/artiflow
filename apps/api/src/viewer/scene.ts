import {
  TEXT_ALIGNS,
  surfaceLayout,
  type ImageNode,
  type PathNode,
  type RectNode,
  type Scene,
  type SceneFrame,
  type SceneNode,
  type TextNode,
} from "@artiflow/domain/scene";

import { presentsSlides } from "@artiflow/domain/kinds";
import { escapeAttribute, originOf, sceneDocumentCsp } from "./html.ts";
import { sceneThreadPlacement, type SceneThreadOrphan, type SceneThreadPin } from "./comments-data.ts";

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

const imageUrl = (node: ImageNode, images: SceneImages): string | null => {
  if (!HEX_SHA256.test(node.assetId) || !images.digests.has(node.assetId)) return null;
  const token = images.token === undefined ? "" : `?token=${encodeURIComponent(images.token)}`;
  return `${images.origin}/artifact/${encodeURIComponent(images.artifactId)}/asset/${node.assetId}${token}`;
};

const renderImage = (node: ImageNode, images?: SceneImages): string => {
  const url = images === undefined ? null : imageUrl(node, images);
  if (url === null)
    return `<div class="node node-image" data-node-id="${escapeAttribute(node.id)}" style="${geometry(node)}"><span class="node-image-label">Image</span><code class="node-image-id">${escapeAttribute(node.assetId)}</code></div>`;
  return `<img class="node node-image node-image-asset" data-node-id="${escapeAttribute(node.id)}" alt="${escapeAttribute(node.id)}" src="${escapeAttribute(url)}" style="${geometry(node)};object-fit:contain">`;
};

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

const renderNode = (node: SceneNode, images?: SceneImages): string => {
  if (node.type === "rect") return renderRect(node);
  if (node.type === "text") return renderText(node);
  if (node.type === "image") return renderImage(node, images);
  if (node.type === "path") return renderPath(node);
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

const renderFrame = (
  frame: SceneFrame,
  visible: boolean,
  images?: SceneImages,
  pins: readonly SceneThreadPin[] = [],
  placement: FramePlacement | null = null,
): string => {
  const label = `${frame.name}, ${num(frame.w)} by ${num(frame.h)}`;
  const placed =
    placement === null
      ? ""
      : ` data-frame-x="${num(placement.x)}" data-frame-y="${num(placement.y)}" style="left:${px(placement.x)};top:${px(placement.y)}"`;
  return `<section class="scene-frame" id="frame-${escapeAttribute(frame.id)}" data-frame-id="${escapeAttribute(frame.id)}" data-frame-w="${num(frame.w)}" data-frame-h="${num(frame.h)}"${placed}${visible ? "" : " hidden"} aria-label="${escapeAttribute(label)}">
<p class="scene-frame-name">${escapeAttribute(frame.name)}<span class="scene-frame-size">${num(frame.w)} × ${num(frame.h)}</span></p>
<div class="scene-frame-body" style="width:${px(frame.w)};height:${px(frame.h)}">${frame.nodes.map((node) => renderNode(node, images)).join("")}${renderPins(pins)}</div>
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

const SLIDES_CSS = `.scene-slides{background-image:none}
.scene-counter{margin:0;display:grid;place-content:center;height:28px;padding:0 12px;border:1px solid #333333;border-radius:8px;background:#202020;color:#c3c8cd;font:500 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace}`;

const SURFACE_CSS = `.scene-surface{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}`;

const SCENE_SCRIPT = `(() => {
  const stage = document.getElementById("stage");
  const surface = document.getElementById("surface");
  const index = document.getElementById("frame-index");
  const fitControl = document.getElementById("fit");
  const frames = Array.from(document.querySelectorAll("[data-frame-id]"));
  const tabs = index === null ? [] : Array.from(index.querySelectorAll("button[data-target]"));
  const HASH_PREFIX = "#frame-";
  const MIN_SCALE = 0.02;
  const MAX_SCALE = 12;
  const FIT_RATIO = 0.86;
  const view = { x: 0, y: 0, scale: 1 };
  let active = frames.length === 0 ? null : frames[0].getAttribute("data-frame-id");
  let drag = null;
  let space = false;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const idOf = (frame) => frame.getAttribute("data-frame-id");

  const figure = (frame, name, fallback) => {
    const value = Number(frame.getAttribute(name));
    return Number.isFinite(value) ? value : fallback;
  };

  const sizeOf = (frame) => ({
    w: Math.max(1, figure(frame, "data-frame-w", 1)),
    h: Math.max(1, figure(frame, "data-frame-h", 1)),
  });

  const atOf = (frame) => ({
    x: figure(frame, "data-frame-x", 0),
    y: figure(frame, "data-frame-y", 0),
  });

  const stageSize = () => ({ w: stage.clientWidth || 1, h: stage.clientHeight || 1 });

  const boundsOf = () => {
    if (surface !== null) {
      const w = Number(surface.getAttribute("data-surface-w"));
      const h = Number(surface.getAttribute("data-surface-h"));
      if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) return { w: w, h: h };
    }
    let w = 0;
    let h = 0;
    for (const frame of frames) {
      const at = atOf(frame);
      const size = sizeOf(frame);
      w = Math.max(w, at.x + size.w);
      h = Math.max(h, at.y + size.h);
    }
    return { w: Math.max(1, w), h: Math.max(1, h) };
  };

  const apply = () => {
    if (surface === null) return;
    surface.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.scale + ")";
  };

  const fit = () => {
    const bounds = boundsOf();
    const available = stageSize();
    view.scale = clamp(Math.min(available.w / bounds.w, available.h / bounds.h) * FIT_RATIO, MIN_SCALE, MAX_SCALE);
    view.x = (available.w - bounds.w * view.scale) / 2;
    view.y = (available.h - bounds.h * view.scale) / 2;
    apply();
  };

  const centre = (frame) => {
    const at = atOf(frame);
    const size = sizeOf(frame);
    const available = stageSize();
    view.x = available.w / 2 - (at.x + size.w / 2) * view.scale;
    view.y = available.h / 2 - (at.y + size.h / 2) * view.scale;
    apply();
  };

  const activate = (frame) => {
    active = idOf(frame);
    for (const tab of tabs) {
      if (tab.getAttribute("data-target") === active) tab.setAttribute("aria-current", "true");
      else tab.removeAttribute("aria-current");
    }
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
    const target = frames.find((frame) => idOf(frame) === id);
    if (target === undefined) return;
    activate(target);
    centre(target);
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
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (surface === null) return;
        const box = stage.getBoundingClientRect();
        const x = event.clientX - box.left;
        const y = event.clientY - box.top;
        const next = clamp(view.scale * Math.exp(-event.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
        const ratio = next / view.scale;
        view.x = x - (x - view.x) * ratio;
        view.y = y - (y - view.y) * ratio;
        view.scale = next;
        apply();
        return;
      }
      event.preventDefault();
      if (surface === null) return;
      const sideways = event.shiftKey ? event.deltaY || 0 : event.deltaX || 0;
      const vertical = event.shiftKey ? 0 : event.deltaY || 0;
      view.x -= sideways;
      view.y -= vertical;
      apply();
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
    view.x += event.clientX - drag.x;
    view.y += event.clientY - drag.y;
    drag = { x: event.clientX, y: event.clientY };
    apply();
  });

  const endDrag = () => {
    drag = null;
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });

  if (fitControl !== null) fitControl.addEventListener("click", fit);

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
    fit();
  });

  if (frames.length > 0) {
    fit();
    const declared = surface === null ? null : surface.getAttribute("data-active-frame");
    const wanted = readHash() !== "" ? readHash() : declared === null ? "" : declared;
    const target = frames.find((frame) => idOf(frame) === wanted);
    if (target === undefined) activate(frames[0]);
    else show(wanted, false);
  }
})();`;

const SLIDES_SCRIPT = `(() => {
  const stage = document.getElementById("stage");
  const index = document.getElementById("frame-index");
  const back = document.getElementById("prev");
  const forward = document.getElementById("next");
  const strip = document.getElementById("strip");
  const counter = document.getElementById("frame-counter");
  const frames = Array.from(document.querySelectorAll("[data-frame-id]"));
  const tabs = index === null ? [] : Array.from(index.querySelectorAll("button[data-target]"));
  const HASH_PREFIX = "#frame-";
  const MIN_SCALE = 0.02;
  const MAX_SCALE = 12;
  const FIT_RATIO = 0.86;
  let active = null;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const idOf = (frame) => frame.getAttribute("data-frame-id");

  const sizeOf = (frame) => {
    const w = Number(frame.getAttribute("data-frame-w"));
    const h = Number(frame.getAttribute("data-frame-h"));
    return { w: Number.isFinite(w) && w > 0 ? w : 1, h: Number.isFinite(h) && h > 0 ? h : 1 };
  };

  const fit = (frame) => {
    const size = sizeOf(frame);
    const width = stage.clientWidth || 1;
    const height = stage.clientHeight || 1;
    const scale = clamp(Math.min(width / size.w, height / size.h) * FIT_RATIO, MIN_SCALE, MAX_SCALE);
    frame.style.transform =
      "translate(" + (width - size.w * scale) / 2 + "px," + (height - size.h * scale) / 2 + "px) scale(" + scale + ")";
  };

  const count = () => {
    if (counter === null) return;
    const at = frames.findIndex((frame) => idOf(frame) === active);
    counter.textContent = (at < 0 ? 0 : at + 1) + " / " + frames.length;
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
    count();
    if (sync) writeHash(active);
  };

  const step = (delta) => {
    const at = frames.findIndex((frame) => idOf(frame) === active);
    if (at < 0) return;
    const next = frames[clamp(at + delta, 0, frames.length - 1)];
    if (next !== undefined) show(idOf(next), true);
  };

  const nativelyActivated = (target) => {
    if (target === null || typeof target !== "object") return false;
    if (typeof target.closest === "function")
      return target.closest("button, a[href], input, select, textarea, summary") !== null;
    const tag = typeof target.tagName === "string" ? target.tagName.toLowerCase() : "";
    return tag === "button" || tag === "a" || tag === "input" || tag === "select" || tag === "textarea" || tag === "summary";
  };

  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key;
    if (key === " " || key === "Spacebar") {
      if (nativelyActivated(event.target)) return;
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
      return;
    }
    const delta = key === "ArrowRight" || key === "PageDown" ? 1 : key === "ArrowLeft" || key === "PageUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    step(delta);
  });

  if (back !== null) back.addEventListener("click", () => step(-1));
  if (forward !== null) forward.addEventListener("click", () => step(1));

  if (strip !== null && index !== null) {
    strip.addEventListener("click", () => {
      const opening = index.hidden;
      index.hidden = !opening;
      strip.setAttribute("aria-pressed", opening ? "true" : "false");
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
    const frame = frames.find((candidate) => idOf(candidate) === active);
    if (frame !== undefined) fit(frame);
  });

  if (frames.length > 0) {
    const wanted = readHash();
    const known = frames.some((frame) => idOf(frame) === wanted);
    const rendered = frames.find((frame) => !frame.hidden) || frames[0];
    show(known ? wanted : idOf(rendered), false);
  }
})();`;

const BASE_DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export function renderSceneDocument(
  scene: Scene,
  frameId?: string,
  images?: SceneImages,
  threads: readonly { id: string; anchor?: unknown }[] = [],
  kind = "canvas",
): string {
  const slides = presentsSlides(kind);
  const origin = images === undefined ? null : originOf(images.origin);
  const source = images !== undefined && origin !== null ? { ...images, origin } : undefined;
  const policy = source === undefined ? BASE_DOCUMENT_CSP : sceneDocumentCsp(source.origin);
  const empty = scene.frames.length === 0;
  const title = scene.frames[0]?.name ?? (slides ? "Deck" : "Canvas");
  const selected = scene.frames.find((frame) => frame.id === frameId) ?? scene.frames[0];
  const selectedId = selected === undefined ? null : selected.id;
  const selectedIndex = selected === undefined ? 0 : scene.frames.indexOf(selected);
  const placement = sceneThreadPlacement(scene, threads);
  const orphans = renderOrphans(placement.orphans);
  const pinsOf = (id: string): SceneThreadPin[] => placement.pins.filter((pin) => pin.frameId === id);
  const surface = slides ? null : surfaceLayout(scene.frames);
  const placementOf = (id: string): FramePlacement => {
    const found = surface === null ? undefined : surface.placements.find((entry) => entry.frameId === id);
    return found === undefined ? { x: 0, y: 0 } : { x: found.x, y: found.y };
  };
  const requested = frameId !== undefined && scene.frames.some((frame) => frame.id === frameId) ? frameId : null;
  const slidesOf = scene.frames.map((frame) =>
    slides
      ? renderFrame(frame, frame.id === selectedId, source, pinsOf(frame.id))
      : renderFrame(frame, true, source, pinsOf(frame.id), placementOf(frame.id)),
  );
  const surfaceSize = `data-surface-w="${num(surface === null ? 0 : surface.width)}" data-surface-h="${num(surface === null ? 0 : surface.height)}"`;
  const activeAttribute = requested === null ? "" : ` data-active-frame="${escapeAttribute(requested)}"`;
  const chrome = empty
    ? slides
      ? `<div class="scene-stage scene-slides" id="stage">
<p class="scene-empty">This deck has no slides yet.</p>
</div>
<nav class="scene-index" id="frame-index" aria-label="Slides" hidden></nav>`
      : `<div class="scene-stage" id="stage">
<p class="scene-empty">This canvas has no frames yet.</p>
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
${slidesOf.join("\n")}
</div>
</div>
<nav class="scene-index" id="frame-index" aria-label="Frames">${renderIndex(scene, selectedId)}</nav>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="content-security-policy" content="${policy}"><title>${escapeAttribute(title)}</title>
<style>
${slides ? `${DOCUMENT_CSS}\n${SLIDES_CSS}` : `${DOCUMENT_CSS}\n${SURFACE_CSS}`}
</style></head>
<body>
${chrome}${orphans === "" ? "" : `\n${orphans}`}
<script>
${slides ? SLIDES_SCRIPT : SCENE_SCRIPT}
</script>
</body></html>`;
}
