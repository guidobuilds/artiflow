import { assetsHead, assetsScripts } from "./assets.ts";
import { artifactBar } from "./chrome/bar.ts";
import { commentsHost, PANEL_CSS, shellCommentsClass } from "./chrome/panel.ts";
import { escapeAttribute, escapeJsonText, THEME_BOOTSTRAP, VIEWER_CHROME_CSS } from "./chrome/theme.ts";
import {
  bridgeComments,
  type ViewerMeta,
  type ViewerModel,
  type ViewerRefresh,
  type WrapperComments,
} from "./model.ts";

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

const FRAME_CSS = `iframe{height:100%;min-height:0;width:100%;border:0;background:white}`;

const SHELL_CSS = `.docshell{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);flex:1;min-height:0;overflow:hidden}`;

const FOCUS_CSS = `.vbar-focus{height:30px;padding:0 11px;border:0;border-radius:8px;background:none;color:var(--fg-muted);font:500 12.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;transition:background .12s,color .12s}
.vbar-focus:hover{background:var(--hover);color:var(--fg)}
.vbar-exit{display:none;position:fixed;top:10px;right:10px;width:30px;height:30px;border:1px solid var(--line-strong);border-radius:8px;background:var(--bg-raised);color:var(--fg-muted);font-size:16px;line-height:1;cursor:pointer;opacity:.45;transition:opacity .12s}
.vbar-exit:hover,.vbar-exit:focus-visible{opacity:1}
body.focus .vbar{display:none}
body.focus .vbar-exit{display:block}`;

const DOCUMENT_CSS = `${FOCUS_CSS}
${SHELL_CSS}
${PANEL_CSS}
${FRAME_CSS}`;

const FOCUS_CONTROL = `<button class="vbar-focus" type="button" title="Focus mode (F)">Focus</button>`;

const FOCUS_EXIT = `<button class="vbar-exit" type="button" aria-label="Exit focus mode" title="Exit focus mode (Esc)">×</button>`;

const FOCUS_SCRIPT = `const exitButton = document.querySelector(".vbar-exit");
const setFocus = (on) => {
  document.body.classList.toggle("focus", on);
  if (on && exitButton) exitButton.focus();
};
const focusButton = document.querySelector(".vbar-focus");
if (focusButton) focusButton.addEventListener("click", () => setFocus(true));
if (exitButton) exitButton.addEventListener("click", () => setFocus(false));
const isEditable = (target) => {
  if (target === null || typeof target !== "object") return false;
  if (target.isContentEditable === true) return true;
  if (typeof target.closest === "function")
    return target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null;
  const tag = typeof target.tagName === "string" ? target.tagName.toLowerCase() : "";
  return tag === "input" || tag === "textarea" || tag === "select";
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setFocus(false);
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === "f" || event.key === "F") {
    if (isEditable(event.target)) return;
    setFocus(!document.body.classList.contains("focus"));
  }
});`;

const scriptValue = (value: string | number): string => JSON.stringify(value).replaceAll("<", "\\u003c");

export function viewerRefreshScript(refresh: ViewerRefresh): string {
  if (refresh.plan.kind === "none") return "";
  const config = `{metaUrl:${scriptValue(refresh.plan.metaUrl)},revisionNumber:${scriptValue(
    refresh.revisionNumber,
  )},sha256:${scriptValue(refresh.sha256)}${refresh.comments === undefined ? "" : `,comments:${refresh.comments}`}}`;
  return `const refresh = ${config};
const INTERVAL_MS = 8000;
let seen = { revisionNumber: refresh.revisionNumber, sha256: refresh.sha256 };
let inFlight = false;
let timer = null;
let reloadedFor = null;
let deferred = false;

const shell = () => document.getElementById("docshell");

const draftTyped = () => {
  const host = shell();
  if (host === null || host.dataset === undefined || host.dataset === null) return false;
  return host.dataset.commentDraft === "typed";
};

const markStale = (revision) => {
  const host = shell();
  if (host === null || host.dataset === undefined || host.dataset === null) return;
  host.dataset.revisionStale = String(revision.revisionNumber);
};

const bumpBadge = (revision) => {
  const badge = document.querySelector(".vbar-version");
  if (badge === null || typeof revision.revisionNumber !== "number") return;
  badge.textContent = "v" + revision.revisionNumber;
};

const stopPolling = () => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
};

const keyOf = (revision) => "revision:" + revision.revisionNumber + ":" + revision.sha256;

const reloadOnce = (key) => {
  if (reloadedFor === key) return;
  reloadedFor = key;
  stopPolling();
  try {
    history.scrollRestoration = "auto";
  } catch (error) {}
  location.reload();
};

const revisionOf = (body) =>
  body !== null && typeof body === "object" && body.revision ? body.revision : body;

const isRevision = (revision) =>
  revision !== null &&
  typeof revision === "object" &&
  typeof revision.revisionNumber === "number" &&
  Number.isFinite(revision.revisionNumber) &&
  typeof revision.sha256 === "string";

const isChanged = (revision) =>
  revision.revisionNumber !== seen.revisionNumber || revision.sha256 !== seen.sha256;

const commentsHidden = (body) => body !== null && typeof body === "object" && body.comments === false;

const observe = (revision) => {
  seen = { revisionNumber: revision.revisionNumber, sha256: revision.sha256 };
  bumpBadge(revision);
  if (draftTyped()) {
    deferred = true;
    markStale(revision);
    return;
  }
  reloadOnce(keyOf(revision));
};

const releaseDeferred = () => {
  if (deferred && !draftTyped()) reloadOnce(keyOf(seen));
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
    if (response.status === 404) {
      reloadOnce("gone");
      return;
    }
    if (!response.ok) return;
    const body = await response.json();
    if (refresh.comments === true && commentsHidden(body)) {
      reloadOnce("comments:off");
      return;
    }
    const revision = revisionOf(body);
    if (isRevision(revision) && isChanged(revision)) observe(revision);
  } catch (error) {
  } finally {
    inFlight = false;
  }
};

const host = shell();
if (host !== null && typeof MutationObserver === "function") {
  new MutationObserver(releaseDeferred).observe(host, {
    attributes: true,
    attributeFilter: ["data-comment-draft"],
  });
}

const startPolling = () => {
  if (timer === null) timer = setInterval(poll, INTERVAL_MS);
};
const resume = () => {
  startPolling();
  poll();
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
    return;
  }
  resume();
});
window.addEventListener("pageshow", resume);
if (!document.hidden) startPolling();`;
}

export type ArtifactFrame = { readonly srcdoc: string; readonly images?: string | null };

export type ArtifactPage = { readonly html: string; readonly headers: Record<string, string> };

type ArtifactSlots = {
  readonly srcdoc: string;
  readonly images?: string | null;
  readonly backHref?: string | undefined;
  readonly meta?: ViewerMeta | undefined;
  readonly embed: boolean;
  readonly refresh: ViewerRefresh;
  readonly comments?: WrapperComments | undefined;
};

const frameHeaders = (images: string | null | undefined): Record<string, string> =>
  images === undefined ? { ...VIEWER_HEADERS } : { ...sceneHeaders(images) };

function artifactPage(slots: ArtifactSlots): ArtifactPage {
  const comments = slots.comments;
  const bridge = comments === undefined ? "" : escapeAttribute(comments.bridge);
  const bar = artifactBar({
    backHref: slots.backHref,
    meta: slots.meta,
    embed: slots.embed,
    control: FOCUS_CONTROL,
  });
  const chrome = bar === "" ? "" : `${bar}\n${FOCUS_EXIT}`;
  const tail =
    comments === undefined
      ? ""
      : `<script type="application/json" id="viewer-comments-data">${escapeJsonText(JSON.stringify(comments.config))}</script>
${assetsScripts(comments.assets)}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Artifact</title>
${THEME_BOOTSTRAP}
<style>
${VIEWER_CHROME_CSS}
${DOCUMENT_CSS}
</style>
${comments === undefined ? "" : assetsHead(comments.assets)}</head>
<body>${chrome}
<div class="docshell${shellCommentsClass(comments !== undefined)}" id="docshell">
<iframe sandbox="${SANDBOX}" referrerpolicy="no-referrer" srcdoc="${slots.srcdoc}${bridge}"></iframe>
${commentsHost(comments !== undefined)}
</div>
${tail}
<script>
${FOCUS_SCRIPT}
${viewerRefreshScript(slots.refresh)}
</script></body></html>`;
  return { html, headers: frameHeaders(slots.images) };
}

export const artifactView = (model: ViewerModel, frame: ArtifactFrame): ArtifactPage =>
  artifactPage({
    srcdoc: frame.srcdoc,
    images: frame.images,
    backHref: model.backHref,
    meta: model.meta,
    embed: model.embed,
    refresh: model.refresh,
    comments: bridgeComments(model.comments),
  });

export const wrapperPage = (
  escaped: string,
  backHref: string | undefined,
  meta: ViewerMeta | undefined,
  embed: boolean,
  refresh: ViewerRefresh,
  comments?: WrapperComments,
): string => artifactPage({ srcdoc: escaped, backHref, meta, embed, refresh, comments }).html;
