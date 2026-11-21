import type { UiIconProps } from "@opencode/plugin/gui";
import { capabilitiesFor } from "@artiflow/domain/kinds";
import type { Association } from "@artiflow/plugin-core/associations";

const HEADLESS_ICON: UiIconProps["name"] = "stop";
const pluginIcons: Record<string, UiIconProps["name"] | undefined> = {
  html: "globe",
  markdown: "file-document",
};
export const artifactIcon = (kind?: string): UiIconProps["name"] => {
  const capabilities = capabilitiesFor(kind ?? "");
  return (capabilities === null ? undefined : pluginIcons[capabilities.glyph]) ?? HEADLESS_ICON;
};

export function recentWrite(row: Association, openedAt?: string, now = Date.now()): boolean {
  const age = now - Date.parse(row.at);
  return openedAt !== row.at && age >= 0 && age < 180_000;
}
