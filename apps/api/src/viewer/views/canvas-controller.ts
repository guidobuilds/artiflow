export const PLAY_CHANNEL = "artiflow-play";
export const PLAY_VERSION = 1;
export const PLAY_STATE_MAX_LENGTH = 2048;

export const canvasControllerScript = (): string => `(() => {
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
  const VIEW_PAD = 48;
  const PLAY_CHANNEL = "${PLAY_CHANNEL}";
  const PLAY_VERSION = ${PLAY_VERSION};
  const STATE_MAX_LENGTH = ${PLAY_STATE_MAX_LENGTH};
  const view = { x: 0, y: 0, scale: 1 };
  const bodyElement = document.body === undefined ? null : document.body;
  let active = frames.length === 0 ? null : frames[0].getAttribute("data-frame-id");
  let drag = null;
  let space = false;
  let sceneMode = "canvas";
  let savedView = null;

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

  const stageSize = () => ({ w: (stage === null ? 0 : stage.clientWidth) || 1, h: (stage === null ? 0 : stage.clientHeight) || 1 });

  const bodyAttributeOf = (name) => {
    if (bodyElement === null || typeof bodyElement.getAttribute !== "function") return null;
    return bodyElement.getAttribute(name);
  };

  const setBodyAttribute = (name, value) => {
    if (bodyElement === null || typeof bodyElement.setAttribute !== "function") return;
    bodyElement.setAttribute(name, value);
  };

  const modeOf = (value) => (value === "focus" || value === "play" ? value : "canvas");
  const elementIn = (frame, selector) => (typeof frame.querySelector === "function" ? frame.querySelector(selector) : null);
  const innerOf = (frame) => elementIn(frame, ".scene-artboard-frame");
  const activeFrameOf = () => frames.find((frame) => idOf(frame) === active) || null;
  const isArtboard = (frame) => frame.getAttribute("data-artboard") === "true";

  const widthIn = (element) => {
    if (element === null || element === undefined) return NaN;
    return Number.parseFloat(element.style.width);
  };

  const boxWidthOf = (frame) => {
    if (sceneMode === "canvas") return sizeOf(frame).w;
    const applied = widthIn(frame);
    return Number.isFinite(applied) && applied > 0 ? applied : sizeOf(frame).w;
  };

  const artboardWidthOf = (frame) => {
    const applied = widthIn(innerOf(frame));
    return Number.isFinite(applied) && applied > 0 ? applied : sizeOf(frame).w;
  };

  const setBox = (frame, width) => {
    frame.style.width = width + "px";
    const host = elementIn(frame, ".scene-frame-body");
    if (host !== null) host.style.width = width + "px";
    const artboard = elementIn(frame, ".scene-artboard");
    if (artboard !== null) artboard.style.width = width + "px";
  };

  const clearBox = (frame) => {
    frame.style.width = "";
    const declared = sizeOf(frame).w + "px";
    const host = elementIn(frame, ".scene-frame-body");
    if (host !== null) host.style.width = declared;
    const artboard = elementIn(frame, ".scene-artboard");
    if (artboard !== null) artboard.style.width = declared;
  };

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

  const fitFrame = (frame) => {
    const width = boxWidthOf(frame);
    const height = sizeOf(frame).h;
    const at = atOf(frame);
    const available = stageSize();
    view.scale = clamp(
      Math.min(1, (available.w - VIEW_PAD) / width, (available.h - VIEW_PAD) / height),
      MIN_SCALE,
      MAX_SCALE,
    );
    view.x = (available.w - width * view.scale) / 2 - at.x * view.scale;
    view.y = (available.h - height * view.scale) / 2 - at.y * view.scale;
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

  const markActive = () => {
    for (const frame of frames) frame.setAttribute("data-scene-active", idOf(frame) === active ? "true" : "false");
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

  const setMode = (next, id) => {
    const wanted = typeof id === "string" && id !== "" ? id : active;
    const target = frames.find((frame) => idOf(frame) === wanted);
    if (target === undefined) return;
    if (sceneMode === "canvas" && next !== "canvas") savedView = { x: view.x, y: view.y, scale: view.scale };
    sceneMode = next;
    setBodyAttribute("data-scene-view", next);
    activate(target);
    if (next === "canvas") {
      for (const frame of frames) {
        frame.removeAttribute("data-scene-active");
        clearBox(frame);
      }
      if (savedView !== null) {
        view.x = savedView.x;
        view.y = savedView.y;
        view.scale = savedView.scale;
        apply();
      } else {
        fit();
      }
      savedView = null;
    } else {
      markActive();
      if (innerOf(target) !== null) setBox(target, artboardWidthOf(target));
      fitFrame(target);
    }
  };

  const setWidth = (frame, width) => {
    const inner = innerOf(frame);
    if (inner !== null) inner.style.width = width + "px";
    setBox(frame, width);
    fitFrame(frame);
  };

  const stateOf = (value) => {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== "object" || Array.isArray(value)) return { ok: false, value: null };
    let serialized = "";
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      return { ok: false, value: null };
    }
    if (typeof serialized !== "string" || serialized.length > STATE_MAX_LENGTH) return { ok: false, value: null };
    return { ok: true, value: value };
  };

  const deliver = (frame, payload) => {
    const inner = innerOf(frame);
    const target = inner === null ? null : inner.contentWindow;
    if (target === null || target === undefined || typeof target.postMessage !== "function") return;
    try {
      target.postMessage(payload, "*");
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

  document.addEventListener("click", (event) => {
    const target = event.target;
    const closest = (selector) =>
      target !== null && typeof target === "object" && typeof target.closest === "function" ? target.closest(selector) : null;
    const enter = closest("[data-scene-enter]");
    if (enter !== null) {
      const next = enter.getAttribute("data-scene-enter");
      if (next === "focus" || next === "play") setMode(next, enter.getAttribute("data-scene-target"));
      return;
    }
    if (closest("[data-scene-exit]") !== null) {
      setMode("canvas", null);
      return;
    }
    if (sceneMode === "canvas") return;
    const button = closest(".scene-artboard-width");
    if (button === null) return;
    const frame = typeof button.closest === "function" ? button.closest("[data-frame-id]") : null;
    const width = Number(button.getAttribute("data-artboard-width"));
    if (frame === null || !Number.isFinite(width) || width <= 0) return;
    setWidth(frame, width);
  });

  window.addEventListener("message", (event) => {
    if (sceneMode !== "play") return;
    const current = activeFrameOf();
    const inner = current === null ? null : innerOf(current);
    if (inner === null || inner.contentWindow === undefined || event.source !== inner.contentWindow) return;
    const data = event.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return;
    if (data.channel !== PLAY_CHANNEL || data.version !== PLAY_VERSION || data.kind !== "navigate") return;
    if (typeof data.frame !== "string") return;
    const target = frames.find((frame) => idOf(frame) === data.frame);
    if (target === undefined || target === current || !isArtboard(target)) return;
    const state = stateOf(data.state);
    if (!state.ok) return;
    setMode("play", idOf(target));
    deliver(target, { channel: PLAY_CHANNEL, version: PLAY_VERSION, kind: "enter", frame: idOf(target), state: state.value });
  });

  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key;
    if (key === " " || key === "Spacebar") {
      space = true;
      return;
    }
    if (sceneMode === "play") return;
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
    if (sceneMode === "canvas") {
      fit();
      return;
    }
    const focused = activeFrameOf();
    if (focused !== null) fitFrame(focused);
  });

  sceneMode = modeOf(bodyAttributeOf("data-scene-view"));
  if (frames.length > 0) {
    fit();
    const declared = surface === null ? null : surface.getAttribute("data-active-frame");
    const wanted = readHash() !== "" ? readHash() : declared === null ? "" : declared;
    const target = frames.find((frame) => idOf(frame) === wanted);
    if (target === undefined) activate(frames[0]);
    else show(wanted, false);
    if (sceneMode !== "canvas") {
      const focused = activeFrameOf();
      if (focused !== null) {
        markActive();
        fitFrame(focused);
      }
    }
  }
})();`;
