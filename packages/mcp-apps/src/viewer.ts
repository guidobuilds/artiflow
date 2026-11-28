import { KIND_CAPABILITIES } from "@artiflow/domain/kinds";

export type ViewerCapabilities = Record<string, { viewer: string } | undefined>;

const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );

export const viewerScriptMap = (capabilities: ViewerCapabilities): string =>
  scriptJson(Object.fromEntries(Object.entries(capabilities).map(([kind, row]) => [kind, row?.viewer ?? null])));

export const VIEWER_DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'";

export type ViewerOptions = { imageOrigin?: string };

const CSP_SAFE_ORIGIN = /^https?:\/\/[a-z0-9._:\-[\]]+$/i;

export const viewerImageOrigin = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return CSP_SAFE_ORIGIN.test(url.origin) ? url.origin : null;
  } catch {
    return null;
  }
};

export const SCENE_DOCUMENT_CSP = (imageOrigin?: string): string =>
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${viewerImageOrigin(imageOrigin) ?? "'none'"}; base-uri 'none'; form-action 'none'`;

export const mcpAppsViewerHtml = (
  capabilities: ViewerCapabilities = KIND_CAPABILITIES,
  options: ViewerOptions = {},
): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artiflow</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; background: var(--color-background-primary, transparent); color: var(--color-text-primary, inherit); }
  #status { padding: 12px 16px; font-size: 13px; opacity: 0.75; }
  #status.error { opacity: 1; color: #b42318; }
  #frame { display: block; width: 100%; height: 70vh; border: 0; background: #fff; }
  pre { margin: 0; padding: 12px 16px; font: 13px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
</head>
<body>
<div id="status">Connecting…</div>
<pre id="text" hidden></pre>
<iframe id="frame" hidden sandbox="allow-scripts" title="Artifact preview"></iframe>
<script>
"use strict";
var statusEl = document.getElementById("status");
var textEl = document.getElementById("text");
var frameEl = document.getElementById("frame");
var DOCUMENT_CSP = "${VIEWER_DOCUMENT_CSP}";
var SCENE_DOCUMENT_CSP = "${SCENE_DOCUMENT_CSP(options.imageOrigin)}";
var HOST_TOOL_CALL_CAP_MS = 4 * 60 * 1000;
var REQUEST_TIMEOUT_MS = HOST_TOOL_CALL_CAP_MS - 60 * 1000;
var loadSeq = 0;
var currentBlobUrl = null;
var currentArtifactId = null;
var pinned = null;
var renderedSha256 = null;

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "";
  statusEl.hidden = false;
}

function canonicalHint() {
  if (!currentArtifactId) return "";
  return " Open it in the dashboard: /artifact/" + encodeURIComponent(currentArtifactId) + ".";
}

function revokeCurrentBlob() {
  if (currentBlobUrl !== null) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

function cancelPending() {
  for (var key in pending) {
    if (pending[key].timer !== undefined) clearTimeout(pending[key].timer);
    delete pending[key];
  }
}

function teardownPreviousLoad() {
  cancelPending();
  loadSeq++;
  revokeCurrentBlob();
  frameEl.hidden = true;
  textEl.hidden = true;
}

var nextId = 1;
var pending = Object.create(null);
function sendRequest(method, params) {
  var id = nextId++;
  return new Promise(function (resolve, reject) {
    var entry = {
      resolve: function (value) { clearTimeout(entry.timer); resolve(value); },
      reject: function (error) { clearTimeout(entry.timer); reject(error); },
      timer: undefined
    };
    entry.timer = setTimeout(function () {
      if (pending[id] !== entry) return;
      delete pending[id];
      reject(new Error(method + " did not answer within " + REQUEST_TIMEOUT_MS + " ms"));
    }, REQUEST_TIMEOUT_MS);
    pending[id] = entry;
    window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
  });
}
function sendNotification(method, params) {
  window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params }, "*");
}

function base64Decode(value) {
  var binary = atob(value);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function metadataOf(params) {
  var out = { artifactId: null, revisionId: null, sha256: null };
  var fill = function (structured) {
    if (!structured || typeof structured !== "object") return false;
    if (typeof structured.artifactId === "string") out.artifactId = structured.artifactId;
    if (typeof structured.revisionId === "string") out.revisionId = structured.revisionId;
    if (typeof structured.sha256 === "string") out.sha256 = structured.sha256;
    return out.artifactId !== null;
  };
  var structured = params && params.structuredContent;
  if (fill(structured)) return out;
  try {
    var parsed = JSON.parse(params && params.content && params.content[0] && params.content[0].text);
    fill(parsed);
  } catch (error) {}
  return out;
}

function showHtml(html) {
  showDocument(html, DOCUMENT_CSP);
}

function showDocument(html, policy) {
  textEl.hidden = true;
  frameEl.hidden = false;
  currentBlobUrl = URL.createObjectURL(new Blob([withCspAfterDoctype(html, policy)], { type: "text/html" }));
  frameEl.src = currentBlobUrl;
}

function withCspAfterDoctype(html, policy) {
  var meta = '<meta http-equiv="Content-Security-Policy" content="' + policy + '">';
  var doctype = html.slice(0, 200).toLowerCase().indexOf("<!doctype");
  var close = doctype === -1 ? -1 : html.indexOf(">", doctype);
  if (close === -1) return meta + html;
  return html.slice(0, close + 1) + meta + html.slice(close + 1);
}

var KIND_VIEWERS = ${viewerScriptMap(capabilities)};

function viewerIsSandboxedDocument(kind) {
  return KIND_VIEWERS[kind] === "sandboxed-html";
}

function viewerRendersScene(kind) {
  return KIND_VIEWERS[kind] === "scene";
}

function showText(text) {
  frameEl.hidden = true;
  textEl.hidden = false;
  textEl.textContent = text;
}

function showPayload(payload) {
  var content = typeof payload.contentBase64 === "string" ? base64Decode(payload.contentBase64) : null;
  if (content === null) { setStatus("This artifact has no readable content." + canonicalHint(), true); return; }
  if (viewerIsSandboxedDocument(payload.kind)) showHtml(content);
  else showText(content);
  setStatus("");
  statusEl.hidden = true;
}

function toolPayload(result) {
  var payload = result && result.structuredContent;
  if (payload && typeof payload === "object") return payload;
  try {
    var parsed = JSON.parse(result && result.content && result.content[0] && result.content[0].text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    return null;
  }
}

async function loadSceneDocument(artifactId) {
  var result = await sendRequest("tools/call", { name: "artifact_get_scene", arguments: { artifactId: artifactId } });
  if (result && result.isError) {
    setStatus("The scene could not be read: " + JSON.stringify(result.content) + canonicalHint(), true);
    return null;
  }
  var payload = toolPayload(result);
  var html = payload === null ? null : payload.documentHtml;
  if (typeof html !== "string" || html === "") {
    setStatus("The scene response carried no document." + canonicalHint(), true);
    return null;
  }
  return html;
}

async function loadArtifact(artifactId, revisionId) {
  var seq = loadSeq;
  currentArtifactId = artifactId;
  setStatus("Loading artifact…", false);
  try {
    var result = await sendRequest("tools/call", {
      name: "artifact_get",
      arguments: revisionId ? { artifactId: artifactId, revisionId: revisionId } : { artifactId: artifactId }
    });
    if (seq !== loadSeq) return;
    if (result && result.isError) { setStatus("The artifact could not be read: " + JSON.stringify(result.content) + canonicalHint(), true); return; }
    var payload = toolPayload(result);
    if (!payload) { setStatus("The artifact response was empty." + canonicalHint(), true); return; }
    if (viewerRendersScene(payload.kind)) {
      var documentHtml = await loadSceneDocument(artifactId);
      if (seq !== loadSeq) return;
      if (documentHtml === null) return;
      showDocument(documentHtml, SCENE_DOCUMENT_CSP);
      setStatus("");
      statusEl.hidden = true;
    } else {
      showPayload(payload);
    }
    if (typeof payload.sha256 === "string") renderedSha256 = payload.sha256;
  } catch (error) {
    if (seq !== loadSeq) return;
    setStatus("The artifact could not be loaded: " + (error && error.message ? error.message : error) + canonicalHint(), true);
  }
}

async function main() {
  try {
    await sendRequest("ui/initialize", {
      protocolVersion: "2026-01-26",
      clientInfo: { name: "artiflow-viewer", version: "0.1.0" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] }
    });
    sendNotification("ui/notifications/initialized", {});
    setStatus("Waiting for the artifact…", false);
  } catch (error) {
    setStatus("This host does not support MCP Apps.", true);
  }
}

function sameRenderedBytes(metadata) {
  return renderedSha256 !== null && metadata.sha256 === renderedSha256;
}

window.addEventListener("message", function (event) {
  var data = event.data;
  if (!data || data.jsonrpc !== "2.0") return;
  if (data.id !== undefined && pending[data.id]) {
    var entry = pending[data.id];
    delete pending[data.id];
    if (data.error) entry.reject(new Error(data.error.message || JSON.stringify(data.error)));
    else entry.resolve(data.result);
    return;
  }
  if (data.method === "ui/notifications/tool-result") {
    var metadata = metadataOf(data.params);
    if (!metadata.artifactId) {
      teardownPreviousLoad();
      setStatus("No artifact was created by this tool call.", true);
      return;
    }
    if (sameRenderedBytes(metadata)) {
      pinned = metadata;
      return;
    }
    teardownPreviousLoad();
    pinned = metadata;
    loadArtifact(metadata.artifactId, metadata.revisionId);
  }
});

main();
</script>
</body>
</html>
`;
