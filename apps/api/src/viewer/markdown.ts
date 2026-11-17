import MarkdownIt from "markdown-it";

import {
  escapeAttribute,
  VIEWER_CHROME_CSS,
  viewerBarStart,
  viewerRefreshScript,
  type ViewerMeta,
  type ViewerRefresh,
} from "./html.ts";

const md = new MarkdownIt({ html: false, linkify: true });

export function renderMarkdownFragment(text: string): string {
  return md.render(text);
}

const DOCUMENT_CSS = `:root{color-scheme:dark light;--doc-bg:#1c1c1c;--doc-fg:#f5f5f5;--doc-fg-muted:#b3b3b3;--doc-surface:#262626;--doc-line:#3d3d3d;--doc-line-strong:#565656;--doc-link:#8ab4f8}
@media(prefers-color-scheme:light){:root{--doc-bg:#ffffff;--doc-fg:#111111;--doc-fg-muted:#555555;--doc-surface:#f2f2f2;--doc-line:#d9d9d9;--doc-line-strong:#bfbfbf;--doc-link:#0a529c}}
*{box-sizing:border-box}html{background:var(--doc-bg)}body{margin:0}
.mdpage{max-width:72ch;margin:0 auto;padding:32px 24px 64px;font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--doc-fg)}
.mdpage h1,.mdpage h2,.mdpage h3,.mdpage h4{font-weight:600;line-height:1.2;letter-spacing:-0.02em;margin:1.4em 0 .5em}
.mdpage h1{font-size:1.7em;margin-top:0}
.mdpage a{color:var(--doc-link)}
.mdpage code{background:var(--doc-surface);border:1px solid var(--doc-line);border-radius:4px;padding:.1em .35em;font:0.92em ui-monospace,SFMono-Regular,Consolas,monospace}
.mdpage pre{background:var(--doc-surface);border:1px solid var(--doc-line);border-radius:8px;padding:12px 14px;overflow:auto}
.mdpage pre code{border:0;background:none;padding:0}
.mdpage table{border-collapse:collapse;margin:1em 0;width:100%}
.mdpage th,.mdpage td{border:1px solid var(--doc-line-strong);padding:6px 10px;text-align:left}
.mdpage th{background:var(--doc-surface)}
.mdpage blockquote{margin:1em 0;padding:.1em 1em;border-left:3px solid var(--doc-line-strong);color:var(--doc-fg-muted)}
.mdpage img{max-width:100%}
.mdpage hr{border:0;border-top:1px solid var(--doc-line);margin:2em 0}`;

export function markdownViewerPage(
  fragment: string,
  backHref: string | undefined,
  meta: ViewerMeta | undefined,
  embed: boolean,
  refresh: ViewerRefresh,
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="content-security-policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'; connect-src 'self'"><title>Document</title>
<style>
${VIEWER_CHROME_CSS}
iframe{flex:1;min-height:0;width:100%;border:0;background:var(--bg)}
</style></head>
<body>${
    embed
      ? ""
      : `<header class="vbar">
${viewerBarStart(backHref, meta)}</header>`
  }
<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(`<!doctype html><style>${DOCUMENT_CSS}</style><div class="mdpage">${fragment}</div>`)}"></iframe>
<script>
${viewerRefreshScript(refresh)}
</script>
</body></html>`;
}
