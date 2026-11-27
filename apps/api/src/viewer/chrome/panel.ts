export const commentsHost = (mounted: boolean): string =>
  mounted ? `<div id="viewer-comments" class="viewer-comments"></div>` : "";

export const shellCommentsClass = (mounted: boolean): string => (mounted ? " comments-available" : "");

export const PANEL_CSS = `.docshell.comments-visible{grid-template-columns:minmax(0,1fr) 360px}
.viewer-comments{display:none}
.docshell.comments-visible .viewer-comments{display:block;position:relative;overflow:hidden;padding:12px;border-left:1px solid var(--line-strong);background:var(--bg)}
.docshell.comments-visible .viewer-comments .comment-thread-unplaced{position:absolute;top:12px}
@media(max-width:800px){.docshell.comments-visible{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto}.docshell.comments-visible .viewer-comments{grid-column:1;grid-row:2;padding:4px 12px;border-left:0;border-top:1px solid var(--line-strong)}.docshell.comments-visible .viewer-comments .comment-thread-margin-root{height:auto}}`;

export const DOCUMENT_PANEL_CSS = `.docshell.comments-visible{grid-template-columns:minmax(0,1fr) 360px}
.viewer-comments{display:none}
.docshell.comments-visible .viewer-comments{display:block;padding:16px;border-left:1px solid var(--doc-line);background:var(--doc-bg)}
@media (max-width:800px){.docshell.comments-visible{grid-template-columns:minmax(0,1fr);grid-auto-rows:auto}.docshell.comments-visible .viewer-comments{position:sticky;bottom:0;z-index:5;padding:4px 12px;border-left:0;border-top:1px solid var(--doc-line)}.docshell.comments-visible .viewer-comments .comment-thread-margin-root{height:auto}}`;
