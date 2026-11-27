export const deckControllerScript = (): string => `(() => {
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
