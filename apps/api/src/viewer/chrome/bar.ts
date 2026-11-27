import type { ViewerMeta } from "../model.ts";
import { escapeAttribute, LOGO_MARK } from "./theme.ts";

export type BarProps = {
  readonly backHref?: string | undefined;
  readonly meta?: ViewerMeta | undefined;
  readonly embed: boolean;
  readonly control?: string | undefined;
};

const backCell = (backHref: string | undefined): string =>
  backHref === undefined
    ? ""
    : `<a class="vbar-cell vbar-back" href="${escapeAttribute(backHref)}" aria-label="Back to library"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5m6-6-6 6 6 6"/></svg></a>\n`;

const titleCell = (meta: ViewerMeta | undefined): string =>
  meta === undefined
    ? ""
    : `<div class="vbar-cell vbar-title"><b>${escapeAttribute(meta.title?.trim() || "Untitled artifact")}</b>${meta.version === null ? "" : `<span class="vbar-version">v${meta.version}</span>`}</div>\n`;

export const artifactBar = (props: BarProps): string =>
  props.embed
    ? ""
    : `<header class="vbar">
${backCell(props.backHref)}<div class="vbar-cell vbar-brand">${LOGO_MARK}<span>artiflow</span></div>
${titleCell(props.meta)}${props.control === undefined ? "" : `<div class="vbar-cell vbar-actions">${props.control}</div>\n`}</header>`;
