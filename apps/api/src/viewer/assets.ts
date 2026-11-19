import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(here, "../../../../apps/dashboard");
const devEntry = "/src/viewer-comments.tsx";

type ManifestChunk = { file?: string; css?: string[]; imports?: string[] };
type Assets = { script: string; styles: string[]; dev: boolean };

let memo: { key: string; value: Assets } | null = null;

const readManifest = (file: string): Record<string, ManifestChunk> | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, ManifestChunk>;
  } catch {
    return null;
  }
};

const collectStyles = (manifest: Record<string, ManifestChunk>, key: string, seen = new Set<string>()): string[] => {
  if (seen.has(key)) return [];
  seen.add(key);
  const chunk = manifest[key];
  if (chunk === undefined) return [];
  const own = (chunk.css ?? []).map((file) => "/" + file.replace(/^\/+/, ""));
  return [...own, ...(chunk.imports ?? []).flatMap((next) => collectStyles(manifest, next, seen))];
};

export function viewerCommentsAssets(env: Record<string, string | undefined> = process.env): Assets {
  const explicit = env.ARTIFLOW_VIEWER_COMMENTS_ASSET;
  if (explicit !== undefined && explicit.trim() !== "") return { script: explicit.trim(), styles: [], dev: false };
  const dist = env.ARTIFLOW_DASHBOARD_DIST ?? join(dashboardRoot, "dist");
  const key = join(dist, ".vite", "manifest.json");
  if (memo !== null && memo.key === key) return memo.value;
  const manifest = readManifest(key);
  const entryKey =
    manifest === null ? undefined : Object.keys(manifest).find((name) => name.endsWith("viewer-comments.tsx"));
  const value: Assets =
    manifest === null || entryKey === undefined
      ? { script: devEntry, styles: [], dev: true }
      : {
          script: "/" + (manifest[entryKey]?.file ?? "").replace(/^\/+/, ""),
          styles: collectStyles(manifest, entryKey),
          dev: false,
        };
  memo = { key, value };
  return value;
}

export const viewerCommentsAsset = (env: Record<string, string | undefined> = process.env): string =>
  viewerCommentsAssets(env).script;

export function resetViewerCommentsAssetCache(): void {
  memo = null;
}

export const DEV_PREAMBLE = `<script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script>
<script type="module" src="/@vite/client"></script>`;

export const assetsHead = (assets: Assets): string =>
  assets.styles.map((href) => `<link rel="stylesheet" href="${href}">`).join("\n");

export const assetsScripts = (assets: Assets): string =>
  `${assets.dev ? DEV_PREAMBLE + "\n" : ""}<script type="module" src="${assets.script}"></script>`;
