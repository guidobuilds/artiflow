import { DESIGN_BRIDGE_CHANNEL, DESIGN_BRIDGE_VERSION } from "@artiflow/domain/design-bridge";

export const DESIGN_REQUEST_STORAGE_KEY = "viewer-design-request-data";

const literal = (value: unknown): string => JSON.stringify(value).replaceAll("<", "\\u003c");

export function designRequestShellScript(): string {
  return `(() => {
  const CHANNEL = ${literal(DESIGN_BRIDGE_CHANNEL)};
  const VERSION = ${literal(DESIGN_BRIDGE_VERSION)};
  const node = document.getElementById(${literal(DESIGN_REQUEST_STORAGE_KEY)});
  if (node === null) return;
  let config = null;
  try { config = JSON.parse(node.textContent || ""); } catch (error) { config = null; }
  if (config === null || typeof config !== "object") return;
  const frame = document.querySelector("#docshell iframe");
  if (frame === null) return;
  const reply = (message) => {
    try {
      frame.contentWindow.postMessage(
        { channel: CHANNEL, version: VERSION, nonce: config.nonce, type: "result", ...message },
        "*",
      );
    } catch (error) {}
  };
  const text = (value, max) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed === "" || trimmed.length > max) return null;
    for (const character of trimmed) {
      const code = character.codePointAt(0) || 0;
      if (code === 9 || code === 10) continue;
      if (code < 32 || code === 127) return null;
    }
    return trimmed;
  };
  const ratio = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  const onlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
  const SELECT_KEYS = ["selector", "textHint", "point", "viewportWidth"];
  const selectionOf = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    if (!onlyKeys(value, SELECT_KEYS)) return null;
    if (typeof value.selector !== "string" || value.selector.length > 512) return null;
    if (typeof value.textHint !== "string" || value.textHint.length > 120) return null;
    if (value.point === null || typeof value.point !== "object" || !onlyKeys(value.point, ["x", "y"])) return null;
    if (!ratio(value.point.x) || !ratio(value.point.y)) return null;
    if (!Number.isSafeInteger(value.viewportWidth) || value.viewportWidth < 1 || value.viewportWidth > 1000000) return null;
    if (value.selector.trim() === "" && value.textHint.trim() === "") return null;
    return value;
  };
  const SUBMIT_KEYS = ["channel", "version", "nonce", "type", "frameId", "revisionId", "selection", "body"];
  const submitOf = (data) => {
    if (data === null || typeof data !== "object") return null;
    if (data.channel !== CHANNEL || data.version !== VERSION || data.nonce !== config.nonce) return null;
    if (data.type !== "submit" || !onlyKeys(data, SUBMIT_KEYS)) return null;
    const frameId = text(data.frameId, 200);
    const revisionId = text(data.revisionId, 200);
    const selection = selectionOf(data.selection);
    const body = text(data.body, 4000);
    if (frameId === null || revisionId === null || selection === null || body === null) return null;
    return { frameId, revisionId, selection, body };
  };
  let saving = false;
  const save = async (submit) => {
    if (config.canComment !== true) {
      reply({ requestId: null, error: "You can see this design but you cannot comment on it." });
      return;
    }
    saving = true;
    try {
      const response = await fetch(config.commentsEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          anchor: {
            kind: "artboard-point",
            boardId: submit.frameId,
            revisionId: submit.revisionId,
            selector: submit.selection.selector,
            textHint: submit.selection.textHint,
            x: submit.selection.point.x,
            y: submit.selection.point.y,
            viewportWidth: submit.selection.viewportWidth,
          },
          body: submit.body,
          expectedRevisionId: config.expectedRevisionId,
        }),
      });
      if (response.status === 201) {
        let requestId = null;
        try { requestId = (await response.json()).id || null; } catch (error) { requestId = null; }
        reply({ requestId, error: null });
        setTimeout(() => { location.reload(); }, 300);
        return;
      }
      const error =
        response.status === 409
          ? "This design changed while you were writing. Reopen it and try again."
          : response.status === 403
            ? "You cannot comment on this design."
            : "The request was not saved (" + response.status + ").";
      reply({ requestId: null, error });
    } catch (error) {
      reply({ requestId: null, error: "The request was not saved." });
    } finally {
      saving = false;
    }
  };
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const submit = submitOf(event.data);
    if (submit === null) return;
    if (saving) return;
    void save(submit);
  });
})();`;
}
