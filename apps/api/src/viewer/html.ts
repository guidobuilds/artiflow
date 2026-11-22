import { assetsHead, assetsScripts, type viewerCommentsAssets } from "./assets.ts";

export const WRAPPER_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'";
export const VIEWER_CSP: string = `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; connect-src 'self'`;
export const VIEWER_HEADERS = {
  "content-security-policy": VIEWER_CSP,
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
} as const;
export const SANDBOX = "allow-scripts";

export const originOf = (url: string): string | null => {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
};

export const sceneCsp = (origin: string): string =>
  `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; img-src ${origin}; base-uri 'none'; form-action 'none'; connect-src 'self'`;

export const sceneDocumentCsp = (origin: string): string =>
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${origin}; base-uri 'none'; form-action 'none'`;

export const sceneHeaders = (origin: string | null) =>
  ({
    "content-security-policy": origin === null ? VIEWER_CSP : sceneCsp(origin),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  }) as const;

export const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const decls = (tokens: ReadonlyArray<readonly [string, string]>): string =>
  tokens.map(([name, value]) => `--${name}:${value}`).join(";");

const STRUCTURE_DARK = [
  ["bg", "#0b0f0d"],
  ["bg-raised", "#111613"],
  ["surface", "#161c18"],
  ["line", "#212924"],
  ["line-strong", "#2f3933"],
  ["fg", "#f4f4f2"],
  ["fg-muted", "#a9b0ab"],
  ["fg-subtle", "#858d88"],
] as const;
const STRUCTURE_LIGHT = [
  ["bg", "#ffffff"],
  ["bg-raised", "#ffffff"],
  ["surface", "#f4f4f3"],
  ["line", "#ebebea"],
  ["line-strong", "#d9d9d6"],
  ["fg", "#0f1d16"],
  ["fg-muted", "#545b57"],
  ["fg-subtle", "#6b716d"],
] as const;
const ACCENT_DARK = [
  ["danger-text", "#ff8f84"],
  ["accent", "#ff6a2b"],
  ["accent-fg", "#170b05"],
  ["accent-text", "#ff8a55"],
] as const;
const ACCENT_LIGHT = [
  ["danger-text", "#b42318"],
  ["accent", "#fa5a1e"],
  ["accent-fg", "#ffffff"],
  ["accent-text", "#c2410c"],
] as const;

const DARK_TOKENS = `${decls([...STRUCTURE_DARK, ...ACCENT_DARK])}`;
const LIGHT_TOKENS = `color-scheme:light;${decls([...STRUCTURE_LIGHT, ...ACCENT_LIGHT])}`;

export const VIEWER_TOKENS = `:root{color-scheme:dark;${DARK_TOKENS};--hover:color-mix(in srgb, var(--fg) 4%, transparent)}
@media(prefers-color-scheme:light){:root:not([data-theme="dark"]){${LIGHT_TOKENS}}}
:root[data-theme="light"]{${LIGHT_TOKENS}}`;

export const THEME_BOOTSTRAP = `<script>try{var stored=localStorage.getItem("artiflow-theme");document.documentElement.dataset.theme=stored==="light"||stored==="dark"?stored:matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}catch(error){document.documentElement.dataset.theme="dark"}</script>`;

const MONO = "ui-monospace,SFMono-Regular,Consolas,monospace";

const LOGO_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 19.5V12a5.5 5.5 0 0 1 11 0v7.5M17 6.5h4M14.5 13h5"/><circle cx="9" cy="15.5" r="2" fill="var(--accent)" stroke="none"/></svg>`;

export const VIEWER_CHROME_CSS = `${VIEWER_TOKENS}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.vbar{display:flex;flex:0 0 48px;min-width:0;border-bottom:1px solid var(--line)}
.vbar-cell{display:flex;align-items:center;min-width:0;padding:0 16px;border-right:1px solid var(--line)}
.vbar-back{width:48px;flex:none;justify-content:center;padding:0;color:var(--fg-muted);transition:background .12s,color .12s}
.vbar-back:hover{background:var(--hover);color:var(--fg)}
.vbar-back svg{width:16px;height:16px}
.vbar-brand{flex-shrink:0;gap:9px;font-size:15px;font-weight:500;letter-spacing:-0.02em}
.vbar-brand svg{width:20px;height:20px;flex-shrink:0}
.vbar-title{gap:10px;flex:0 1 auto}
.vbar-title b{overflow:hidden;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
.vbar-version{flex:none;padding:1px 8px;border:1px solid var(--line-strong);border-radius:999px;color:var(--fg-muted);font:11.5px/1.5 ${MONO}}
.vbar-actions{flex:none;margin-left:auto;padding:0 10px;border-right:0}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(max-width:760px){.vbar-actions{padding:0 6px}.vbar-cell{padding-inline:12px}.vbar-back{padding:0}}
@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}`;

export type ViewerMeta = { title: string | null; version: number | null };

export type ViewerRefresh = {
  metaUrl: string;
  srcdocUrl?: string;
  revisionNumber: number;
  sha256: string;
};

const escapeJsonText = (json: string): string =>
  json.replace(/[<>&\u2028\u2029]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));

const scriptValue = (value: string | number): string => JSON.stringify(value).replaceAll("<", "\\u003c");

export function viewerBarStart(backHref?: string, meta?: ViewerMeta, embed = false): string {
  const back =
    backHref === undefined
      ? ""
      : `<a class="vbar-cell vbar-back" href="${escapeAttribute(backHref)}" aria-label="Back to library"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5m6-6-6 6 6 6"/></svg></a>\n`;
  const name =
    meta === undefined
      ? ""
      : `<div class="vbar-cell vbar-title">${embed ? "" : `<b>${escapeAttribute(meta.title?.trim() || "Untitled artifact")}</b>`}${meta.version === null ? "" : `<span class="vbar-version">v${meta.version}</span>`}</div>\n`;
  return `${back}<div class="vbar-cell vbar-brand">${LOGO_MARK}<span>artiflow</span></div>\n${name}`;
}

export function viewerRefreshScript(refresh: ViewerRefresh): string {
  const config = `{metaUrl:${scriptValue(refresh.metaUrl)},srcdocUrl:${
    refresh.srcdocUrl === undefined ? "null" : scriptValue(refresh.srcdocUrl)
  },revisionNumber:${scriptValue(refresh.revisionNumber)},sha256:${scriptValue(refresh.sha256)}}`;
  return `const refresh = ${config};
const INTERVAL_MS = 8000;
let seen = { revisionNumber: refresh.revisionNumber, sha256: refresh.sha256 };
let inFlight = false;
let timer = null;

const isChanged = (revision) =>
  revision !== null &&
  typeof revision === "object" &&
  (revision.revisionNumber !== seen.revisionNumber || revision.sha256 !== seen.sha256);

const bumpBadge = (revision) => {
  const badge = document.querySelector(".vbar-version");
  if (badge === null || typeof revision.revisionNumber !== "number") return;
  badge.textContent = "v" + revision.revisionNumber;
};

// The frame's document is an opaque origin, so its scroll offset is usually unreadable: this is a
// best-effort attempt that must never break the refresh.
const frameOffset = (frame) => {
  try {
    return frame.contentWindow ? Number(frame.contentWindow.scrollY) || 0 : 0;
  } catch (error) {
    return 0;
  }
};

const restoreOffset = (frame, offset) => {
  if (offset === 0) return;
  try {
    frame.contentWindow.scrollTo(0, offset);
  } catch (error) {
    // best-effort only; see frameOffset
  }
};

const swapDocument = async (frame) => {
  const response = await fetch(refresh.srcdocUrl, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "text/html" },
  });
  if (!response.ok) return false;
  // The gated page already escaped the stored bytes into its srcdoc attribute. Parsing is inert (no
  // script runs) and the DOM hands those exact bytes back, so nothing here rebuilds the document.
  const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
  const fresh = parsed.querySelector("iframe");
  const bytes = fresh === null ? null : fresh.getAttribute("srcdoc");
  if (typeof bytes !== "string" || bytes.length === 0) return false;
  const offset = frameOffset(frame);
  frame.addEventListener("load", () => restoreOffset(frame, offset), { once: true });
  frame.setAttribute("srcdoc", bytes);
  return true;
};

const applyRevision = async (revision) => {
  if (refresh.srcdocUrl === null) {
    // A server-rendered document has no byte endpoint to read: reload, asking the browser to keep
    // the reader where they were.
    if (document.querySelector("[data-comment-draft='typed'], [data-comment-input='typed']") !== null) return;
    try {
      history.scrollRestoration = "auto";
    } catch (error) {
      // unsupported: the reload simply lands at the top
    }
    location.reload();
    return;
  }
  const frame = document.querySelector("iframe");
  if (frame === null) return;
  if (!(await swapDocument(frame))) return;
  seen = { revisionNumber: revision.revisionNumber, sha256: revision.sha256 };
  bumpBadge(revision);
};

const poll = async () => {
  if (inFlight) return;
  inFlight = true;
  try {
    const response = await fetch(refresh.metaUrl, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return;
    const body = await response.json();
    const revision = body !== null && typeof body === "object" && body.revision ? body.revision : body;
    if (isChanged(revision)) await applyRevision(revision);
  } catch (error) {
    // A failed read is retried on the next tick; the page never surfaces an error of its own.
  } finally {
    inFlight = false;
  }
};

const startPolling = () => {
  if (timer === null) timer = setInterval(poll, INTERVAL_MS);
};
const stopPolling = () => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
    return;
  }
  startPolling();
  poll();
});
if (!document.hidden) startPolling();`;
}

export type WrapperComments = {
  nonce: string;
  bridge: string;
  config: unknown;
  assets: ReturnType<typeof viewerCommentsAssets>;
};

export function wrapperPage(
  escaped: string,
  backHref: string | undefined,
  meta: ViewerMeta | undefined,
  embed: boolean,
  refresh: ViewerRefresh,
  comments?: WrapperComments,
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Artifact</title>
${THEME_BOOTSTRAP}
<style>
${VIEWER_CHROME_CSS}
.vbar-focus{height:30px;padding:0 11px;border:0;border-radius:8px;background:none;color:var(--fg-muted);font:500 12.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;transition:background .12s,color .12s}
.vbar-focus:hover{background:var(--hover);color:var(--fg)}
.vbar-exit{display:none;position:fixed;top:10px;right:10px;width:30px;height:30px;border:1px solid var(--line-strong);border-radius:8px;background:var(--bg-raised);color:var(--fg-muted);font-size:16px;line-height:1;cursor:pointer;opacity:.45;transition:opacity .12s}
.vbar-exit:hover,.vbar-exit:focus-visible{opacity:1}
body.focus .vbar{display:none}
body.focus .vbar-exit{display:block}
.docshell{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);flex:1;min-height:0;overflow:hidden}
.docshell.comments-visible{grid-template-columns:minmax(0,1fr) 360px}
.viewer-comments{display:none}
.docshell.comments-visible .viewer-comments{display:block;position:relative;overflow:hidden;padding:12px;border-left:1px solid var(--line-strong);background:var(--bg)}
.docshell.comments-visible .viewer-comments .comment-thread-unplaced{position:absolute;top:12px}
@media(max-width:800px){.docshell.comments-visible{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto}.docshell.comments-visible .viewer-comments{grid-column:1;grid-row:2;padding:4px 12px;border-left:0;border-top:1px solid var(--line-strong)}.docshell.comments-visible .viewer-comments .comment-thread-margin-root{height:auto}}
iframe{height:100%;min-height:0;width:100%;border:0;background:white}
</style>
${comments === undefined ? "" : assetsHead(comments.assets)}</head>
<body>${
    embed
      ? ""
      : `<header class="vbar">
${viewerBarStart(backHref, meta)}<div class="vbar-cell vbar-actions"><button class="vbar-focus" type="button" title="Focus mode (F)">Focus</button></div>
</header>
<button class="vbar-exit" type="button" aria-label="Exit focus mode" title="Exit focus mode (Esc)">×</button>`
  }
<div class="docshell${comments === undefined ? "" : " comments-available"}" id="docshell">
<iframe sandbox="${SANDBOX}" referrerpolicy="no-referrer" srcdoc="${escaped}${comments === undefined ? "" : escapeAttribute(comments.bridge)}"></iframe>
${comments === undefined ? "" : `<div id="viewer-comments" class="viewer-comments"></div>`}
</div>
${
  comments === undefined
    ? ""
    : `<script type="application/json" id="viewer-comments-data">${escapeJsonText(JSON.stringify(comments.config))}</script>
${assetsScripts(comments.assets)}`
}
<script>
const exitButton = document.querySelector(".vbar-exit");
const setFocus = (on) => {
  document.body.classList.toggle("focus", on);
  // Keep keyboard focus on this page: keys pressed inside the iframe never reach it.
  if (on && exitButton) exitButton.focus();
};
// Neither control exists in embed mode, where the bar is not rendered at all.
const focusButton = document.querySelector(".vbar-focus");
if (focusButton) focusButton.addEventListener("click", () => setFocus(true));
if (exitButton) exitButton.addEventListener("click", () => setFocus(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setFocus(false);
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === "f" || event.key === "F") setFocus(!document.body.classList.contains("focus"));
});
${viewerRefreshScript(refresh)}
</script></body></html>`;
}

export const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found — Artiflow</title>
<style>
${VIEWER_TOKENS}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:9px;flex:0 0 54px;padding:0 22px;border-bottom:1px solid var(--line);font-size:15px;font-weight:500;letter-spacing:-0.02em}
header svg{width:20px;height:20px}
main{flex:1;display:grid;place-content:center;justify-items:start;gap:14px;width:min(620px,100%);margin:0 auto;padding:40px 16px}
small{color:var(--fg-subtle);font:13px ${MONO}}
h1{margin:0;font-size:clamp(32px,5vw,52px);font-weight:600;line-height:1.08;letter-spacing:-0.045em;text-wrap:balance}
.caret{display:inline-block;width:.52em;height:.95em;margin-left:.08em;vertical-align:-.08em;background:var(--accent);animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
p{margin:0;max-width:52ch;color:var(--fg-muted);font-size:16px}
a{display:inline-flex;align-items:center;height:38px;margin-top:10px;padding:0 16px;border-radius:8px;background:var(--fg);color:var(--bg);font-size:13.5px;font-weight:500;text-decoration:none}
a:hover{opacity:.9}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.caret{animation:none}}
</style></head>
<body>
<header>${LOGO_MARK}<span>artiflow</span></header>
<main>
<small>404 · Not found</small>
<h1>This page isn&#39;t here.<span class="caret" aria-hidden="true"></span></h1>
<p>The link may be mistyped, or the artifact was deleted or never shared with you. If someone sent it, ask them to share it with your account.</p>
<a href="/">Back to your library</a>
</main>
</body></html>`;

export const NOT_FOUND_HEADERS = {
  "content-security-policy": WRAPPER_CSP,
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
} as const;
