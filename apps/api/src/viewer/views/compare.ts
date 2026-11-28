import { bannerMarkup, NOTICE_CSS, SANDBOX, sceneHeaders, VIEWER_HEADERS, type ArtifactPage } from "../artifact.ts";
import { artifactBar } from "../chrome/bar.ts";
import { escapeAttribute, THEME_BOOTSTRAP, VIEWER_CHROME_CSS } from "../chrome/theme.ts";
import type { ViewerModel } from "../model.ts";

export type CompareSide = {
  readonly label: "A" | "B";
  readonly number: number;
  readonly publishedAt: string;
  readonly srcdoc: string;
};

export type CompareInput = {
  readonly frameName: string | null;
  readonly sides: readonly CompareSide[];
  readonly images?: string | undefined;
};

const COMPARE_CSS = `.cmp{display:grid;flex:1;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1px;min-height:0;background:var(--line)}
@media(max-width:820px){.cmp{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr)}}
.cmp-pane{display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0;min-height:0;background:var(--bg)}
.cmp-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;padding:8px 14px;border-bottom:1px solid var(--line);color:var(--fg-muted);font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.cmp-head b{color:var(--fg);font:600 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace;padding:2px 7px;border:1px solid var(--line-strong);border-radius:5px}
.cmp-head strong{color:var(--fg);font-weight:600;font-size:12.5px}
.cmp-head time{margin-left:auto;color:var(--fg-muted);font:11.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
.cmp-pane iframe{width:100%;height:100%;min-height:0;border:0;background:white}
.cmp-empty{padding:24px;color:var(--fg-muted);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}`;

const day = (value: string): string => (value.length >= 10 ? value.slice(0, 10) : value);

const pageOf = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeAttribute(title)}</title>
${THEME_BOOTSTRAP}
<style>${VIEWER_CHROME_CSS}${NOTICE_CSS}${COMPARE_CSS}</style></head>
<body>${body}</body></html>`;

export const comparisonUnavailablePage = (): string =>
  pageOf(
    "Compare versions",
    '<div class="cmp-empty" role="status">Comparison is available for a Design with at least two publications.</div>',
  );

export const compareView = (model: ViewerModel, input: CompareInput): ArtifactPage => {
  const bar = artifactBar({ chrome: model.chrome, backHref: model.backHref, meta: model.meta });
  const panes = input.sides
    .map(
      (side) => `<section class="cmp-pane" aria-label="${escapeAttribute(`Version ${side.number}, labelled ${side.label}`)}" data-compare-side="${side.label}">
<header class="cmp-head"><b>${side.label}</b><strong>Version ${side.number}</strong><time datetime="${escapeAttribute(side.publishedAt)}">${escapeAttribute(day(side.publishedAt))}</time></header>
<iframe sandbox="${SANDBOX}" referrerpolicy="no-referrer" srcdoc="${side.srcdoc}"></iframe>
</section>`,
    )
    .join("\n");
  const title = input.frameName === null ? "Compare versions" : `Compare versions · ${input.frameName}`;
  const html = pageOf(title, `${bar}\n${bannerMarkup(model.banner)}<div class="cmp">${panes}</div>`);
  const headers = input.images === undefined ? { ...VIEWER_HEADERS } : { ...sceneHeaders(input.images) };
  return { html, headers };
};
