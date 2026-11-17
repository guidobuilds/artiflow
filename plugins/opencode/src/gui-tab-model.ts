import type { UiIconProps } from "@opencode/plugin/gui";
import type { Association } from "@artiflow/plugin-core/associations";

const icons = new Map<string, UiIconProps["name"]>([
  ["html", "globe"],
  ["markdown", "file-document"],
]);
export const artifactIcon = (kind?: string): UiIconProps["name"] => icons.get(kind ?? "") ?? "stop";

export function recentWrite(row: Association, openedAt?: string, now = Date.now()): boolean {
  const age = now - Date.parse(row.at);
  return openedAt !== row.at && age >= 0 && age < 180_000;
}
