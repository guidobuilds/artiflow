export const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const escapeJsonText = (json: string): string =>
  json.replace(/[<>&\u2028\u2029]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));

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

export const LOGO_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 19.5V12a5.5 5.5 0 0 1 11 0v7.5M17 6.5h4M14.5 13h5"/><circle cx="9" cy="15.5" r="2" fill="var(--accent)" stroke="none"/></svg>`;

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

export const WRAPPER_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'";

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
