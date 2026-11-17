export const VIEWER_DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'";

export const mcpAppsViewerHtml = (): string => `<!DOCTYPE html>
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
// Hosts cap a proxied tool call at roughly four minutes, so the viewer stops waiting
// before that and reports an error instead of hanging on a host that never replies.
var REQUEST_TIMEOUT_MS = 180000;
// Identity is per viewer instance: only this document's last delivered tool result is
// tracked and nothing is persisted, so two host panes cannot cross-read.
var loadSeq = 0;
var currentBlobUrl = null;
var currentArtifactId = null;
// Per-instance pin {artifactId, revisionId, revisionNumber, sha256} taken from each
// tool result; renderedSha256 is the byte identity actually on screen, so a repeated
// tool result for identical bytes skips the refetch instead of re-rendering.
var pinned = null;
var renderedSha256 = null;

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "";
  statusEl.hidden = false;
}

// The dashboard owner viewer route is the canonical private location for a known artifact;
// shown as text because this opaque-origin document cannot resolve relative links.
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

// Supersedes any in-flight load: dropping its pending entries strands every late reply and
// its timer, and the previous artifact document is released.
function teardownPreviousLoad() {
  cancelPending();
  loadSeq++;
  revokeCurrentBlob();
  frameEl.hidden = true;
  textEl.hidden = true;
}

// Minimal JSON-RPC 2.0 client over postMessage (SEP-1865 transport layer): the sandbox
// proxy forwards to the host, which proxies server requests with the user's credentials.
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

// The tool result carries the artifact identity in structuredContent (declared output
// schema: artifactId, revisionId, revisionNumber, sha256); the JSON text body is the
// fallback for hosts that strip structured content. Fields beyond artifactId stay absent
// when a host sends only the older shape.
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
  } catch (error) { /* not a JSON payload: no artifact to show */ }
  return out;
}

function showHtml(html) {
  textEl.hidden = true;
  frameEl.hidden = false;
  // blob: URL instead of srcdoc so the declared CSP frame-src stays a single explicit
  // scheme; the nested iframe keeps allow-scripts only, matching the dashboard sandbox.
  currentBlobUrl = URL.createObjectURL(new Blob([cspDocument(html)], { type: "text/html" }));
  frameEl.src = currentBlobUrl;
}

// The policy element goes ahead of every artifact element. When the artifact opens with a
// doctype it goes right after it instead: before the doctype the parser drops that token and
// the artifact would render in quirks mode, which changes how the dashboard viewer renders it.
function cspDocument(html) {
  var meta = '<meta http-equiv="Content-Security-Policy" content="' + DOCUMENT_CSP + '">';
  var doctype = html.slice(0, 200).toLowerCase().indexOf("<!doctype");
  var close = doctype === -1 ? -1 : html.indexOf(">", doctype);
  if (close === -1) return meta + html;
  return html.slice(0, close + 1) + meta + html.slice(close + 1);
}

// Fail closed: only an explicit "html" kind may render bytes as a document. Any other or
// missing kind stays inert text, so an unknown kind never inherits the frame by default.
function rendersAsFrame(kind) {
  return kind === "html";
}

function showText(text) {
  frameEl.hidden = true;
  textEl.hidden = false;
  textEl.textContent = text;
}

function showPayload(payload) {
  var content = typeof payload.contentBase64 === "string" ? base64Decode(payload.contentBase64) : null;
  if (content === null) { setStatus("This artifact has no readable content." + canonicalHint(), true); return; }
  if (rendersAsFrame(payload.kind)) showHtml(content);
  else showText(content);
  setStatus("");
  statusEl.hidden = true;
}

async function loadArtifact(artifactId, revisionId) {
  var seq = loadSeq;
  currentArtifactId = artifactId;
  setStatus("Loading artifact…", false);
  try {
    // Byte fetch stays the legacy full output: the metadataOnly projection carries no
    // contentBase64, so it is reserved for the deferred harness-side poll path.
    var result = await sendRequest("tools/call", {
      name: "artifact_get",
      arguments: revisionId ? { artifactId: artifactId, revisionId: revisionId } : { artifactId: artifactId }
    });
    if (seq !== loadSeq) return; // a newer tool result superseded this load
    if (result && result.isError) { setStatus("The artifact could not be read: " + JSON.stringify(result.content) + canonicalHint(), true); return; }
    var payload = result && result.structuredContent;
    if (!payload) {
      try { payload = JSON.parse(result && result.content && result.content[0] && result.content[0].text); }
      catch (error) { payload = null; }
    }
    if (!payload) { setStatus("The artifact response was empty." + canonicalHint(), true); return; }
    showPayload(payload);
    if (payload && typeof payload.sha256 === "string") renderedSha256 = payload.sha256;
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
    // sha256 is the byte identity: identical bytes on a re-pinned tool result skip the
    // refetch, whatever the revision number says. Any other change reloads the pin.
    if (renderedSha256 !== null && metadata.sha256 === renderedSha256) {
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
