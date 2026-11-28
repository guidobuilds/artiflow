import { assetsHead, assetsScripts, type Assets } from "./assets.ts";
import { artifactBar } from "./chrome/bar.ts";
import { commentsHost, PANEL_CSS, shellCommentsClass } from "./chrome/panel.ts";
import { escapeAttribute, escapeJsonText, THEME_BOOTSTRAP, VIEWER_CHROME_CSS } from "./chrome/theme.ts";
import { DESIGN_REQUEST_STORAGE_KEY, designRequestShellScript } from "./design-request-shell.ts";
import {
  bridgeComments,
  managementMenu,
  type ViewerChrome,
  type ViewerManagementMenu,
  type ViewerMeta,
  type ViewerModel,
  type DesignRequestShellConfig,
  type ViewerRefresh,
  type ViewerBanner,
  type ViewerVersions,
  type WrapperComments,
} from "./model.ts";

const CSP_DIRECTIVES = [
  ["default-src", "'none'"],
  ["script-src", "'self' 'unsafe-inline'"],
  ["style-src", "'self' 'unsafe-inline'"],
  ["frame-src", "'self'"],
  ["img-src", "'self'"],
  ["base-uri", "'none'"],
  ["form-action", "'none'"],
  ["connect-src", "'self'"],
] as const;

const cspOf = (directives: ReadonlyArray<readonly [string, string]>): string =>
  directives.map(([directive, sources]) => `${directive} ${sources}`).join("; ");

export const VIEWER_CSP: string = cspOf(CSP_DIRECTIVES);

export const DOCUMENT_CSP: string = cspOf(CSP_DIRECTIVES.filter(([directive]) => directive !== "frame-src"));

export const VIEWER_HEADERS = {
  "content-security-policy": VIEWER_CSP,
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
} as const;

export const DOCUMENT_HEADERS = { ...VIEWER_HEADERS, "content-security-policy": DOCUMENT_CSP } as const;

const DOCUMENT_POLICY_META = `<meta http-equiv="content-security-policy" content="${escapeAttribute(DOCUMENT_CSP)}">`;
const LEADING_DOCTYPE = /^<!doctype[^>]*>/i;
const HTML_LEADING_SPACE = /^[ \t\n\f\r]*/;

export function withDocumentPolicy(html: string): string {
  const bom = html.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom === "" ? html : html.slice(1);
  const leading = HTML_LEADING_SPACE.exec(body)?.[0] ?? "";
  const doctype = LEADING_DOCTYPE.exec(body.slice(leading.length));
  if (doctype !== null) {
    const at = leading.length + doctype[0].length;
    return `${bom}${body.slice(0, at)}${DOCUMENT_POLICY_META}${body.slice(at)}`;
  }
  return `${bom}${DOCUMENT_POLICY_META}${body}`;
}

export const SANDBOX = "allow-scripts";

export const originOf = (url: string): string | null => {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
};

const imageSource = (origin: string): string => originOf(origin) ?? "'none'";

export const sceneCsp = (origin: string): string =>
  `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; img-src ${imageSource(origin)}; base-uri 'none'; form-action 'none'; connect-src 'self'`;

export const sceneDocumentCsp = (origin: string): string =>
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${imageSource(origin)}; base-uri 'none'; form-action 'none'`;

export const sceneHeaders = (origin: string | null) =>
  ({
    "content-security-policy": origin === null ? VIEWER_CSP : sceneCsp(origin),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  }) as const;

const FRAME_CSS = `iframe{height:100%;min-height:0;width:100%;border:0;background:white}`;

const SHELL_CSS = `.docshell{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);flex:1;min-height:0;overflow:hidden}`;

const FOCUS_CSS = `button[data-control]{height:30px;padding:0 11px;border:0;border-radius:8px;background:none;color:var(--fg-muted);font:500 12.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;transition:background .12s,color .12s}
button[data-control]:hover{background:var(--hover);color:var(--fg)}
.vbar-exit{display:none;position:fixed;top:10px;right:10px;width:30px;height:30px;border:1px solid var(--line-strong);border-radius:8px;background:var(--bg-raised);color:var(--fg-muted);font-size:16px;line-height:1;cursor:pointer;opacity:.45;transition:opacity .12s}
.vbar-exit:hover,.vbar-exit:focus-visible{opacity:1}
body.focus .vbar{display:none}
body.focus .vbar-exit{display:block}`;

export const NOTICE_CSS = `.vnotice{display:flex;flex:0 0 auto;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--bg-raised);color:var(--fg-muted);font:12.5px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.vnotice-text{margin:0;flex:1 1 280px;min-width:0}
.vnotice-link{color:var(--fg);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line-strong)}
.vnotice-link:hover{text-decoration-color:currentColor}
.vnotice-error{flex:1 1 100%;margin:0;color:#ff9a9a;font-size:12px}
.vbar-versions{position:relative;display:flex;align-items:center;min-width:0}
.vbar-versions summary{list-style:none;cursor:pointer;padding:5px 9px;border:1px solid var(--line-strong);border-radius:8px;color:var(--fg-muted);font:500 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif}
.vbar-versions summary::-webkit-details-marker{display:none}
.vbar-versions[open] summary,.vbar-versions summary:hover{color:var(--fg);background:var(--hover)}
.vbar-versions ol{position:absolute;top:calc(100% + 6px);left:0;z-index:5;margin:0;padding:6px;min-width:280px;max-height:min(60vh,420px);overflow:auto;list-style:none;background:var(--bg-raised);border:1px solid var(--line-strong);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.4)}
.vbar-versions li{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:6px;color:var(--fg-muted);font:12px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.vbar-versions li[data-current="true"]{color:var(--fg);font-weight:600;background:var(--hover)}
.vbar-versions li a{color:inherit;text-decoration:none}
.vbar-versions li a:hover{text-decoration:underline;text-underline-offset:3px}
.vbar-versions .vbar-version-date{margin-left:auto;color:var(--fg-muted);font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
.vbar-versions-note{margin:4px 8px 2px;color:var(--fg-muted);font-size:11px}`;

const DOCUMENT_CSS = `${FOCUS_CSS}
${SHELL_CSS}
${PANEL_CSS}
${FRAME_CSS}
${NOTICE_CSS}`;

const FOCUS_CONTROL = `<button type="button" title="Focus mode (F)" data-control="focus">Focus</button>`;

const FOCUS_EXIT = `<button class="vbar-exit" type="button" aria-label="Exit focus mode" title="Exit focus mode (Esc)">×</button>`;

const FOCUS_SCRIPT = `const exitButton = document.querySelector(".vbar-exit");
const setFocus = (on) => {
  document.body.classList.toggle("focus", on);
  if (on && exitButton) exitButton.focus();
};
const focusButton = document.querySelector('[data-control="focus"]');
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
  readonly chrome: ViewerChrome;
  readonly backHref?: string | undefined;
  readonly meta?: ViewerMeta | undefined;
  readonly refresh: ViewerRefresh;
  readonly comments?: WrapperComments | undefined;
  readonly management?: ViewerManagementMenu | undefined;
  readonly designRequest?: DesignRequestShellConfig | undefined;
  readonly banner?: ViewerBanner | undefined;
  readonly versions?: ViewerVersions | undefined;
};

const isoDay = (value: string): string => (value.length >= 10 ? value.slice(0, 10) : value);

function versionsOf(versions: ViewerVersions | undefined): string {
  if (versions === undefined || versions.rows.length === 0) return "";
  const restoreOf = (row: { id: string }): string =>
    versions.canRestore && row.id !== versions.expectedRevisionId
      ? `<span data-island="restore" data-artifact-id="${escapeAttribute(versions.artifactId)}" data-revision-id="${escapeAttribute(row.id)}" data-expected-revision-id="${escapeAttribute(versions.expectedRevisionId)}"></span>`
      : "";
  const rows = versions.rows
    .map((row) => {
      const compare =
        row.id === versions.expectedRevisionId
          ? ""
          : `<a href="${escapeAttribute(row.compareHref ?? "")}" data-versions-compare>Compare</a>`;
      return `<li data-current="${row.id === versions.viewingId ? "true" : "false"}"><a href="${escapeAttribute(row.href)}" data-versions-open>v${row.number}</a><span class="vbar-version-date">${escapeAttribute(isoDay(row.publishedAt))}</span>${compare}${restoreOf(row)}</li>`;
    })
    .join("");
  const note =
    versions.hidden > 0
      ? `<p class="vbar-versions-note">Showing the ${versions.rows.length} most recent; ${versions.hidden} older ${
          versions.hidden === 1 ? "version is" : "versions are"
        } in the history.</p>`
      : "";
  return `<details class="vbar-versions"><summary>Versions</summary><ol>${rows}</ol>${note}</details>`;
}

export function bannerMarkup(banner: ViewerBanner | undefined): string {
  if (banner === undefined) return "";
  const links = banner.links
    .map((link) => `<a class="vnotice-link" href="${escapeAttribute(link.href)}">${escapeAttribute(link.label)}</a>`)
    .join("");
  return `<div class="vnotice" role="status" data-tone="${banner.tone}"><p class="vnotice-text">${escapeAttribute(banner.text)}</p>${links}</div>`;
}

const frameHeaders = (images: string | null | undefined): Record<string, string> =>
  images === undefined ? { ...VIEWER_HEADERS } : { ...sceneHeaders(images) };

function artifactPage(slots: ArtifactSlots): ArtifactPage {
  const comments = slots.comments;
  const management = slots.management;
  const assets = [comments?.assets, management?.assets].filter((set): set is Assets => set !== undefined);
  const bridge = comments === undefined ? "" : escapeAttribute(comments.bridge);
  const bar = artifactBar({
    chrome: slots.chrome,
    backHref: slots.backHref,
    meta: slots.meta,
    control: FOCUS_CONTROL,
    management: management !== undefined,
    versions: versionsOf(slots.versions),
  });
  const chrome = bar === "" ? "" : `${bar}\n${FOCUS_EXIT}`;
  const commentsData =
    comments === undefined
      ? ""
      : `<script type="application/json" id="viewer-comments-data">${escapeJsonText(JSON.stringify(comments.config))}</script>`;
  const managementData =
    management === undefined
      ? ""
      : `<script type="application/json" id="viewer-management-data">${escapeJsonText(JSON.stringify(management.config))}</script>`;
  const designRequest = slots.designRequest;
  const designRequestData =
    designRequest === undefined
      ? ""
      : `<script type="application/json" id="${DESIGN_REQUEST_STORAGE_KEY}">${escapeJsonText(JSON.stringify(designRequest))}</script>`;
  const payloads = [commentsData, managementData, designRequestData].filter((value) => value !== "");
  const tail = payloads.length === 0 ? "" : `${payloads.join("\n")}\n${assetsScripts(...assets)}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Artifact</title>
${THEME_BOOTSTRAP}
<style>
${VIEWER_CHROME_CSS}
${DOCUMENT_CSS}
</style>
${assets.length === 0 ? "" : assetsHead(...assets)}</head>
<body>${chrome}
${bannerMarkup(slots.banner)}<div class="docshell${shellCommentsClass(comments !== undefined)}" id="docshell">
<iframe sandbox="${SANDBOX}" referrerpolicy="no-referrer" srcdoc="${slots.srcdoc}${bridge}"></iframe>
${commentsHost(comments !== undefined)}
</div>
${tail}
<script>
${FOCUS_SCRIPT}
${viewerRefreshScript(slots.refresh)}
</script>${designRequest === undefined ? "" : `\n<script>\n${designRequestShellScript()}\n</script>`}</body></html>`;
  return { html, headers: frameHeaders(slots.images) };
}

export const artifactView = (model: ViewerModel, frame: ArtifactFrame): ArtifactPage =>
  artifactPage({
    srcdoc: frame.srcdoc,
    images: frame.images,
    backHref: model.backHref,
    meta: model.meta,
    chrome: model.chrome,
    refresh: model.refresh,
    comments: bridgeComments(model.comments),
    management: managementMenu(model.management),
    designRequest: model.designRequest,
    banner: model.banner,
    versions: model.versions,
  });

export const wrapperPage = (
  escaped: string,
  backHref: string | undefined,
  meta: ViewerMeta | undefined,
  chrome: ViewerChrome,
  refresh: ViewerRefresh,
  comments?: WrapperComments,
  management?: ViewerManagementMenu,
): string => artifactPage({ srcdoc: escaped, backHref, meta, chrome, refresh, comments, management }).html;
