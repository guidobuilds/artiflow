import type { UiIconProps } from "@opencode/plugin/gui";
import { iconFor, type KindIcon } from "@artiflow/domain/kinds";
import type { Association } from "@artiflow/plugin-core/associations";

const PLUGIN_ICONS: Record<KindIcon, UiIconProps["name"]> = {
  page: "globe",
  document: "file-document",
  canvas: "dot-grid",
  slides: "expand",
  unknown: "stop",
};
export const artifactIcon = (kind?: string): UiIconProps["name"] => PLUGIN_ICONS[iconFor(kind ?? "")];

export function recentWrite(row: Association, openedAt?: string, now = Date.now()): boolean {
  const age = now - Date.parse(row.at);
  return openedAt !== row.at && age >= 0 && age < 180_000;
}
