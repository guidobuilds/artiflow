import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(here, "../../../../apps/dashboard");
const devEntry = "/src/viewer-comments.tsx";

let memo: { key: string; value: string } | null = null;

function manifestEntry(file: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, { file?: string }>;
    const found = Object.entries(manifest).find(([name]) => name.endsWith("viewer-comments.tsx"));
    return found?.[1]?.file ?? null;
  } catch {
    return null;
  }
}

export function viewerCommentsAsset(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.ARTIFLOW_VIEWER_COMMENTS_ASSET;
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  const dist = env.ARTIFLOW_DASHBOARD_DIST ?? join(dashboardRoot, "dist");
  const key = join(dist, ".vite", "manifest.json");
  if (memo !== null && memo.key === key) return memo.value;
  const file = manifestEntry(key);
  const value = file === null ? devEntry : "/" + file.replace(/^\/+/, "");
  memo = { key, value };
  return value;
}

export function resetViewerCommentsAssetCache(): void {
  memo = null;
}