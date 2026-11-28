import {
  BRIDGE_CHANNEL,
  BRIDGE_VERSION,
  MAX_SELECTION_HINT,
  MAX_SELECTION_SELECTOR,
  MAX_SELECTION_VIEWPORT,
} from "@artiflow/domain/html-bridge";
import {
  DESIGN_BRIDGE_CHANNEL,
  DESIGN_BRIDGE_VERSION,
  DESIGN_ID_MAX_LENGTH,
  DESIGN_REQUEST_ID_MAX_LENGTH,
} from "@artiflow/domain/design-bridge";
import { MAX_REQUEST_TEXT } from "@artiflow/domain/design-request";

export const SCENE_REQUEST_STORAGE_KEY = "scene-request-data";

const literal = (value: unknown): string => JSON.stringify(value).replaceAll("<", "\\u003c");

export function designRequestControllerScript(): string {
  return `(() => {
  const node = document.getElementById(${literal(SCENE_REQUEST_STORAGE_KEY)});
  if (node === null) return;
  let config = null;
  try { config = JSON.parse(node.textContent || ""); } catch (error) { config = null; }
  if (config === null || typeof config !== "object" || config.canComment !== true) return;
  if (!Array.isArray(config.frames)) return;
  const PARENT_CHANNEL = ${literal(BRIDGE_CHANNEL)};
  const PARENT_VERSION = ${literal(BRIDGE_VERSION)};
  const SHELL_CHANNEL = ${literal(DESIGN_BRIDGE_CHANNEL)};
  const SHELL_VERSION = ${literal(DESIGN_BRIDGE_VERSION)};
  const SELECTOR_MAX = ${literal(MAX_SELECTION_SELECTOR)};
  const HINT_MAX = ${literal(MAX_SELECTION_HINT)};
  const VIEWPORT_MAX = ${literal(MAX_SELECTION_VIEWPORT)};
  const BODY_MAX = ${literal(MAX_REQUEST_TEXT)};
  const ID_MAX = ${literal(DESIGN_ID_MAX_LENGTH)};
  const RESULT_MAX = ${literal(DESIGN_REQUEST_ID_MAX_LENGTH)};
  const frames = [];
  for (const entry of config.frames) {
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.id !== "string" || typeof entry.bridgeNonce !== "string") continue;
    const host = document.querySelector('[data-frame-id="' + (window.CSS && CSS.escape ? CSS.escape(entry.id) : entry.id) + '"]');
    const element = host === null ? null : host.querySelector("iframe");
    if (element === null || element.contentWindow === null) continue;
    frames.push({ id: entry.id, name: typeof entry.name === "string" ? entry.name : "", revisionId: entry.revisionId, nonce: entry.bridgeNonce, element });
  }
  if (frames.length === 0) return;
  const frameOf = (source) => {
    for (const entry of frames) if (entry.element.contentWindow === source) return entry;
    return null;
  };
  const send = (entry, message) => {
    try { entry.element.contentWindow.postMessage({ channel: PARENT_CHANNEL, version: PARENT_VERSION, nonce: entry.nonce, ...message }, "*"); } catch (error) {}
  };
  const start = document.querySelector("[data-request-start]");
  const stage = document.getElementById("stage");
  const panel = document.getElementById("scene-request-draft");
  const requests = document.getElementById("scene-requests");
  let selecting = false;
  let draft = null;
  let saving = false;
  const sceneView = () => {
    if (document.body === null || typeof document.body.getAttribute !== "function") return "canvas";
    return document.body.getAttribute("data-scene-view") || "canvas";
  };
  const locked = () => sceneView() === "play";
  const setSelecting = (on) => {
    if (on === true && locked()) return;
    selecting = on === true;
    if (start !== null) start.setAttribute("aria-pressed", String(selecting));
    if (stage !== null) stage.setAttribute("data-request-selecting", String(selecting));
    for (const entry of frames) send(entry, { type: "mode", on: selecting });
  };
  const clearDraft = () => {
    draft = null;
    if (panel !== null) panel.textContent = "";
  };
  const cancelDraft = () => {
    saving = false;
    clearDraft();
    setSelecting(false);
  };
  const stateLine = (text, tone) => {
    if (panel === null) return;
    let line = panel.querySelector("[data-request-state]");
    if (line === null) {
      line = document.createElement("p");
      line.setAttribute("data-request-state", "");
      panel.append(line);
    }
    line.textContent = text;
    line.setAttribute("data-tone", tone || "neutral");
  };
  const showDraft = () => {
    if (panel === null || draft === null) return;
    panel.textContent = "";
    const title = document.createElement("p");
    title.className = "scene-request-draft-title";
    title.textContent = "Request a change in " + (draft.name || "this artboard");
    const where = document.createElement("p");
    where.className = "scene-request-draft-where";
    where.textContent = "Element " + (draft.selection.selector || "identified by its text") + " · revision " + draft.revisionId;
    const label = document.createElement("label");
    label.className = "scene-request-draft-label";
    label.textContent = "What should change?";
    const input = document.createElement("textarea");
    input.value = draft.body;
    input.rows = 3;
    input.maxLength = BODY_MAX;
    input.setAttribute("data-request-body", "");
    input.addEventListener("input", () => { if (draft !== null) draft.body = input.value; });
    label.append(input);
    const actions = document.createElement("p");
    actions.className = "scene-request-draft-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = saving ? "Saving…" : "Send request";
    save.disabled = saving;
    save.addEventListener("click", () => submit());
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => cancelDraft());
    actions.append(save, cancel);
    panel.append(title, where, label, actions);
    input.focus();
  };
  const submit = () => {
    if (draft === null || panel === null) return;
    const body = draft.body.trim();
    if (body === "") {
      stateLine("Write what should change first.", "error");
      return;
    }
    saving = true;
    stateLine("Saving…", "neutral");
    const selection = draft.selection;
    try {
      window.parent.postMessage(
        {
          channel: SHELL_CHANNEL,
          version: SHELL_VERSION,
          nonce: config.nonce,
          type: "submit",
          frameId: draft.frameId,
          revisionId: draft.revisionId,
          selection: {
            selector: selection.selector,
            textHint: selection.textHint,
            point: { x: selection.x, y: selection.y },
            viewportWidth: selection.viewportWidth,
          },
          body,
        },
        "*",
      );
    } catch (error) {
      saving = false;
      stateLine("The request was not saved.", "error");
    }
  };
  const onlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
  const SELECT_KEYS = ["channel", "version", "nonce", "type", "selector", "textHint", "x", "y", "viewportWidth"];
  const ratio = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  const selectionOf = (data, entry) => {
    if (data === null || typeof data !== "object") return null;
    if (data.channel !== PARENT_CHANNEL || data.version !== PARENT_VERSION || data.nonce !== entry.nonce) return null;
    if (data.type !== "select" || !onlyKeys(data, SELECT_KEYS)) return null;
    if (typeof data.selector !== "string" || data.selector.length > SELECTOR_MAX) return null;
    if (typeof data.textHint !== "string" || data.textHint.length > HINT_MAX) return null;
    if (!ratio(data.x) || !ratio(data.y)) return null;
    if (!Number.isSafeInteger(data.viewportWidth) || data.viewportWidth < 1 || data.viewportWidth > VIEWPORT_MAX) return null;
    if (data.selector.trim() === "" && data.textHint.trim() === "") return null;
    return { selector: data.selector, textHint: data.textHint, x: data.x, y: data.y, viewportWidth: data.viewportWidth };
  };
  const RESULT_KEYS = ["channel", "version", "nonce", "type", "requestId", "error"];
  const resultOf = (data) => {
    if (data === null || typeof data !== "object") return null;
    if (data.channel !== SHELL_CHANNEL || data.version !== SHELL_VERSION || data.nonce !== config.nonce) return null;
    if (data.type !== "result" || !onlyKeys(data, RESULT_KEYS)) return null;
    const requestId =
      data.requestId === null ? null : typeof data.requestId === "string" && data.requestId.length <= RESULT_MAX ? data.requestId : undefined;
    const error = data.error === null ? null : typeof data.error === "string" && data.error.length <= RESULT_MAX ? data.error : undefined;
    if (requestId === undefined || error === undefined) return null;
    if ((requestId === null) === (error === null)) return null;
    return { requestId, error };
  };
  window.addEventListener("message", (event) => {
    if (event.source === window.parent) {
      const result = resultOf(event.data);
      if (result === null) return;
      saving = false;
      if (result.error !== null) {
        stateLine(result.error, "error");
        return;
      }
      draft = null;
      stateLine("Saved. The artboard does not change until the agent's edit is published.", "saved");
      return;
    }
    const entry = frameOf(event.source);
    if (entry === null) return;
    const data = event.data;
    if (locked()) {
      send(entry, { type: "mode", on: false });
      return;
    }
    if (data !== null && typeof data === "object" && data.type === "pin-click") {
      const card = requests === null ? null : requests.querySelector('[data-request-thread="' + (window.CSS && CSS.escape ? CSS.escape(data.id) : data.id) + '"]');
      if (card !== null) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      send(entry, { type: "focus", id: data.id });
      return;
    }
    if (data !== null && typeof data === "object" && data.type === "cancel") {
      cancelDraft();
      return;
    }
    const selection = selectionOf(data, entry);
    if (selection === null) return;
    draft = { frameId: entry.id, name: entry.name, revisionId: entry.revisionId, selection, body: "" };
    setSelecting(false);
    showDraft();
  });
  if (typeof MutationObserver === "function" && document.body !== null && typeof document.body.getAttribute === "function") {
    new MutationObserver(() => {
      if (!locked()) return;
      clearDraft();
      setSelecting(false);
    }).observe(document.body, { attributes: true, attributeFilter: ["data-scene-view"] });
  }
  if (locked()) setSelecting(false);
  if (start !== null) {
    start.addEventListener("click", () => {
      if (selecting) {
        setSelecting(false);
        return;
      }
      saving = false;
      clearDraft();
      setSelecting(true);
    });
  }
  if (requests !== null) {
    requests.addEventListener("click", (event) => {
      const target = event.target && typeof event.target.closest === "function" ? event.target.closest("[data-request-show]") : null;
      if (target === null) return;
      const frameId = target.getAttribute("data-request-frame");
      const threadId = target.getAttribute("data-request-show");
      for (const entry of frames) if (entry.id === frameId) send(entry, { type: "focus", id: threadId });
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (draft === null && !selecting) return;
    cancelDraft();
  });
})();`;
}
