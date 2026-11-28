import {
  BRIDGE_CHANNEL,
  BRIDGE_VERSION,
  MAX_SELECTION_HINT,
  MAX_SELECTION_SELECTOR,
} from "@artiflow/domain/html-bridge";

export type SelectionBridgeOptions = {
  nonce: string;
  pins: readonly { id: string; number: number; selector: string; textHint: string; x: number; y: number }[];
  allowSelect: boolean;
};

const literal = (value: unknown): string => JSON.stringify(value).replaceAll("<", "\\u003c");

export function selectionBridgeScript({ nonce, pins, allowSelect }: SelectionBridgeOptions): string {
  return `<script data-artiflow-selection="${BRIDGE_CHANNEL}">
(() => {
  const CHANNEL = ${literal(BRIDGE_CHANNEL)};
  const VERSION = ${literal(BRIDGE_VERSION)};
  const NONCE = ${literal(nonce)};
  const ALLOW_SELECT = ${literal(allowSelect)};
  const SELECTOR_LIMIT = ${literal(MAX_SELECTION_SELECTOR)};
  const HINT_LIMIT = ${literal(MAX_SELECTION_HINT)};
  const HINTS = ["h1","h2","h3","h4","p","li","td","th","figcaption","blockquote","button","a","span","div"];
  const SKIP = new Set(["html","head","body","script","style","meta","link","title"]);
  const PINS = ${literal(pins)};
  const post = (message) => {
    try { window.parent.postMessage({ channel: CHANNEL, version: VERSION, nonce: NONCE, ...message }, "*"); } catch (error) {}
  };
  const box = (element) => element.getBoundingClientRect();
  const cssEscape = (value) => {
    const characters = Array.from(value);
    return characters.map((character, index) => {
      const code = character.codePointAt(0) || 0;
      const leadingDigit = index === 0 && code >= 48 && code <= 57;
      if (code === 0) return "\\\\uFFFD";
      if ((code >= 1 && code <= 31) || code === 127 || leadingDigit) return "\\\\" + code.toString(16) + " ";
      if (code >= 128 || code === 45 || code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return character;
      return "\\\\" + character;
    }).join("");
  };
  const cssString = (value) =>
    String(value)
      .replace(/["\\\\]/g, (character) => "\\\\" + character)
      .replace(/\\n/g, "\\\\a ")
      .replace(/[\\u0000-\\u001f\\u007f]/g, (character) => "\\\\" + (character.codePointAt(0) || 0).toString(16) + " ");
  const describe = (element) => {
    if (element.id) return { selector: "#" + cssEscape(element.id), textHint: "" };
    const attributes = ["data-block","data-testid","data-widget","data-section","aria-label"];
    for (const name of attributes) {
      const value = element.getAttribute(name);
      if (value) return { selector: "[" + name + '="' + cssString(value) + '"]', textHint: "" };
    }
    const skipped = SKIP.has((element.tagName || "").toLowerCase());
    const text = (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, HINT_LIMIT);
    return { selector: "", textHint: skipped ? "" : text };
  };
  const resolve = (locator) => {
    try {
      const selector = (locator.selector || "").trim();
      if (selector.startsWith("#")) {
        const element = document.getElementById(selector.slice(1));
        return element ? element : null;
      }
      if (selector.startsWith("[")) {
        let matches = [];
        try { matches = Array.from(document.querySelectorAll(selector)); } catch (error) { matches = []; }
        return matches.length === 1 ? matches[0] : null;
      }
      const hint = (locator.textHint || "").replace(/\\s+/g, " ").trim();
      if (!hint) return null;
      const candidates = Array.from(document.querySelectorAll(HINTS.join(","))).filter(
        (element) => (element.textContent || "").replace(/\\s+/g, " ").trim().startsWith(hint),
      );
      return candidates.length === 1 ? candidates[0] : null;
    } catch (error) {
      return null;
    }
  };
  const layer = document.createElement("div");
  layer.setAttribute("data-artiflow-selection-layer", "");
  layer.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483645";
  const highlight = document.createElement("div");
  highlight.setAttribute("data-artiflow-hover", "");
  highlight.style.cssText = "position:absolute;pointer-events:none;border:2px solid #ff6a2b;border-radius:4px;display:none;z-index:2147483646";
  const chosen = document.createElement("div");
  chosen.setAttribute("data-artiflow-chosen", "");
  chosen.style.cssText = "position:absolute;pointer-events:none;border:2px dashed #ff6a2b;border-radius:4px;background:rgba(255,106,43,.12);display:none;z-index:2147483646";
  const draw = (element, target) => {
    if (!element) { target.style.display = "none"; return; }
    const rect = box(element);
    target.style.display = "block";
    target.style.transform =
      "translate(" + Math.round(rect.left + (window.scrollX || 0)) + "px," + Math.round(rect.top + (window.scrollY || 0)) + "px)";
    target.style.width = Math.round(rect.width) + "px";
    target.style.height = Math.round(rect.height) + "px";
  };
  const marks = new Map();
  const placePins = () => {
    for (const pin of PINS) {
      const mark = marks.get(pin.id);
      if (!mark) continue;
      const element = resolve(pin);
      if (!element) {
        mark.style.display = "none";
        continue;
      }
      const rect = box(element);
      mark.style.display = "grid";
      mark.style.transform =
        "translate(" + Math.round(rect.left + (window.scrollX || 0) + pin.x * rect.width) + "px," + Math.round(rect.top + (window.scrollY || 0) + pin.y * rect.height) + "px)";
    }
  };
  const mountPins = () => {
    marks.clear();
    for (const pin of PINS) {
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "artiflow-selection-pin";
      mark.textContent = String(pin.number);
      mark.title = "Change request " + pin.number;
      mark.style.cssText =
        "position:absolute;top:0;left:0;display:grid;place-content:center;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:999px;border:1px solid #fff;background:#ff6a2b;color:#170b05;font:600 11px/1 system-ui;pointer-events:auto;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)";
      mark.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        post({ type: "pin-click", id: pin.id });
      });
      marks.set(pin.id, mark);
      layer.appendChild(mark);
    }
    placePins();
  };
  let selecting = false;
  const setSelecting = (on) => {
    selecting = on && ALLOW_SELECT;
    document.documentElement.style.cursor = selecting ? "crosshair" : "";
    if (!selecting) draw(null, highlight);
  };
  const onMove = (event) => {
    if (!selecting) return;
    const element = event.target;
    draw(element instanceof Element ? element : null, highlight);
  };
  const onClick = (event) => {
    if (!selecting) return;
    const element = event.target;
    if (!(element instanceof Element)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = box(element);
    const described = describe(element);
    if (!described.selector && !described.textHint) return;
    draw(element, chosen);
    post({
      type: "select",
      selector: described.selector.slice(0, SELECTOR_LIMIT),
      textHint: described.textHint.slice(0, HINT_LIMIT),
      x: rect.width === 0 ? 0 : Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: rect.height === 0 ? 0 : Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      viewportWidth: Math.max(1, Math.round(window.innerWidth || 1)),
    });
  };
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.channel !== CHANNEL || data.version !== VERSION || data.nonce !== NONCE) return;
    if (data.type === "mode") {
      setSelecting(data.on === true);
      return;
    }
    if (data.type === "focus") {
      const pin = PINS.find((candidate) => candidate.id === data.id);
      const element = pin ? resolve(pin) : null;
      const mark = data.id ? marks.get(data.id) : null;
      const target = element || mark;
      if (!target) return;
      const rect = box(target);
      if (rect.bottom < 0 || rect.top > (window.innerHeight || 0)) {
        try { target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (error) {}
      }
      if (mark && typeof mark.animate === "function") {
        try {
          mark.animate(
            [{ boxShadow: "0 0 0 0 rgba(255,106,43,.7)" }, { boxShadow: "0 0 0 14px rgba(255,106,43,0)" }],
            { duration: 600, easing: "ease-out" },
          );
        } catch (error) {}
      }
    }
  });
  const start = () => {
    if (!document.documentElement) return;
    document.documentElement.appendChild(layer);
    layer.appendChild(highlight);
    layer.appendChild(chosen);
    mountPins();
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !selecting) return;
      setSelecting(false);
      post({ type: "cancel" });
    });
    window.addEventListener("scroll", placePins, true);
    window.addEventListener("resize", placePins, true);
    if (typeof ResizeObserver === "function") new ResizeObserver(placePins).observe(document.documentElement);
    placePins();
    post({ type: "ready" });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
</script>`;
}
