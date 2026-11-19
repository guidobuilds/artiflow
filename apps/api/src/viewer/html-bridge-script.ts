import { BRIDGE_CHANNEL, BRIDGE_VERSION } from "@artiflow/domain/html-bridge";

import type { BridgePin } from "./comments-data.ts";

export type { BridgePin };

export type HtmlBridgeOptions = { nonce: string; pins: BridgePin[] };

const literal = (value: unknown): string => JSON.stringify(value).replaceAll("<", "\\u003c");

export function htmlBridgeScript({ nonce, pins }: HtmlBridgeOptions): string {
  return `<script data-artiflow-bridge="${BRIDGE_CHANNEL}" data-nonce="${nonce}">
(() => {
  const CHANNEL = ${literal(BRIDGE_CHANNEL)};
  const VERSION = ${literal(BRIDGE_VERSION)};
  const NONCE = ${literal(nonce)};
  const PINS = ${literal(pins)};
  const HINT_LIMIT = 120;
  const HINTS = ["h1","h2","h3","h4","p","li","td","th","figcaption","blockquote","button","a","span","div"];
  const SKIP = new Set(["html","head","body","script","style","meta","link","title"]);
  const layer = document.createElement("div");
  layer.setAttribute("data-artiflow-pin-layer", "");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const post = (message) => {
    try { window.parent.postMessage({ channel: CHANNEL, version: VERSION, nonce: NONCE, ...message }, "*"); } catch (error) {}
  };
  const box = (element) => element.getBoundingClientRect();
  const cssEscape = (value) => value.replace(/([^\\w-])/g, "\\\\$1");
  const describe = (element) => {
    if (element.id) return { selector: "#" + cssEscape(element.id), textHint: "" };
    const attributes = ["data-block","data-testid","data-widget","data-section","aria-label"];
    for (const name of attributes) {
      const value = element.getAttribute(name);
      if (value) return { selector: "[" + name + '="' + value.replace(/"/g, '\\\\"') + '"]', textHint: "" };
    }
    const text = (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, HINT_LIMIT);
    return { selector: "", textHint: SKIP.has(element.tagName.toLowerCase()) ? "" : text };
  };
  const resolve = (pin) => {
    const selector = (pin.selector || "").trim();
    if (selector.startsWith("#")) {
      const element = document.getElementById(selector.slice(1));
      return element ? { element } : { missing: true };
    }
    if (selector.startsWith("[")) {
      let matches = [];
      try { matches = Array.from(document.querySelectorAll(selector)); } catch (error) { matches = []; }
      return matches.length === 1 ? { element: matches[0] } : { missing: true };
    }
    const hint = (pin.textHint || "").replace(/\\s+/g, " ").trim();
    if (!hint) return { missing: true };
    const candidates = Array.from(document.querySelectorAll(HINTS.join(","))).filter(
      (element) => (element.textContent || "").replace(/\\s+/g, " ").trim().startsWith(hint),
    );
    return candidates.length === 1 ? { element: candidates[0] } : { missing: true };
  };
  const marks = new Map();
  const place = () => {
    for (const pin of PINS) {
      const mark = marks.get(pin.id);
      if (!mark) continue;
      const found = resolve(pin);
      let left = 0;
      let top = 0;
      let visible = false;
      const previous = mark.dataset.at ? mark.dataset.at.split(",").map(Number) : null;
      if (found.element) {
        const rect = box(found.element);
        left = rect.left + pin.x * rect.width;
        top = rect.top + pin.y * rect.height;
        visible = true;
        mark.classList.toggle("artiflow-pin-stale", false);
        mark.style.borderStyle = "solid";
        mark.style.opacity = "1";
      } else if (pin.stalePixels === true) {
        left = pin.x * (window.innerWidth || 1);
        top = pin.y;
        mark.classList.add("artiflow-pin-stale");
        mark.style.borderStyle = "dashed";
        mark.style.opacity = "0.6";
        if (previous && pin.stalePixels !== true) {
          left = previous[0];
          top = previous[1];
        } else if (pin.stalePixels !== true) {
          left = pin.x * (window.innerWidth || 1);
          top = pin.y * (window.innerHeight || 1);
        }
      }
      mark.style.transform = "translate(" + Math.round(left) + "px," + Math.round(top) + "px)";
      if (visible) mark.dataset.at = Math.round(left) + "," + Math.round(top);
      post({ type: "geometry", id: pin.id, x: Math.round(left), y: Math.round(top), visible });
    }
  };
  const mount = () => {
    if (!layer.isConnected) document.documentElement.appendChild(layer);
    for (const pin of PINS) {
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "artiflow-pin";
      mark.dataset.pinId = pin.id;
      mark.textContent = String(pin.number);
      mark.style.cssText =
        "position:absolute;top:0;left:0;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:999px;border:1px solid #fff;background:#ff6a2b;color:#170b05;font:600 12px/22px system-ui;cursor:pointer;pointer-events:auto;box-shadow:0 2px 8px rgba(0,0,0,.3)";
      mark.style.transform =
        "translate(" + Math.round(pin.x * (window.innerWidth || 1)) + "px," + Math.round(pin.y * (window.innerHeight || 1)) + "px)";
      mark.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        post({ type: "pin-click", id: pin.id });
      });
      marks.set(pin.id, mark);
      layer.appendChild(mark);
    }
    place();
  };
  let mode = false;
  let hovered = null;
  const highlight = document.createElement("div");
  highlight.style.cssText =
    "position:absolute;pointer-events:none;border:2px solid #ff6a2b;border-radius:4px;z-index:2147483646;display:none";
  const showHighlight = (element) => {
    if (!element) { highlight.style.display = "none"; return; }
    const rect = box(element);
    highlight.style.display = "block";
    highlight.style.transform = "translate(" + Math.round(rect.left) + "px," + Math.round(rect.top) + "px)";
    highlight.style.width = Math.round(rect.width) + "px";
    highlight.style.height = Math.round(rect.height) + "px";
  };
  const onMove = (event) => {
    if (!mode) return;
    hovered = event.target;
    showHighlight(hovered);
  };
  const onClick = (event) => {
    if (!mode) return;
    const element = event.target;
    if (!(element instanceof Element)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = box(element);
    const described = describe(element);
    post({
      type: "pick",
      selector: described.selector,
      textHint: described.textHint,
      x: rect.width === 0 ? 0 : Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: rect.height === 0 ? 0 : Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      viewportWidth: window.innerWidth,
      viewportY: Math.round(event.clientY),
    });
  };
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.channel !== CHANNEL || data.version !== VERSION || data.nonce !== NONCE) return;
    if (event.source !== window.parent) return;
    if (data.type === "mode") {
      mode === false && data.on === true && post({ type: "ready" });
      mode = data.on === true;
      document.documentElement.style.cursor = mode ? "crosshair" : "";
      if (!mode) { showHighlight(null); hovered = null; }
      return;
    }
    if (data.type === "focus") {
      const mark = data.id ? marks.get(data.id) : null;
      for (const other of marks.values()) other.classList.toggle("artiflow-pin-active", other === mark);
    }
  });
  const start = () => {
    if (!document.documentElement) return;
    document.documentElement.appendChild(highlight);
    mount();
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place, true);
    if (typeof ResizeObserver === "function") new ResizeObserver(place).observe(document.documentElement);
    post({ type: "ready" });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
</script>`;
}
