import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(here, "../../../../apps/dashboard");
const COMMENTS_ENTRY = "viewer-comments.tsx";
const devEntry = `/src/${COMMENTS_ENTRY}`;

type ManifestChunk = { file?: string; css?: string[]; imports?: string[] };
export type Assets = { script: string; styles: string[]; dev: boolean };
export type AssetLog = (message: string) => void;

const memo = new Map<string, Assets>();

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

export function viewerCommentsAssets(
  env: Record<string, string | undefined> = process.env,
  log: AssetLog = (message) => console.error(message),
): Assets {
  const explicit = env.ARTIFLOW_VIEWER_COMMENTS_ASSET;
  if (explicit !== undefined && explicit.trim() !== "") return { script: explicit.trim(), styles: [], dev: false };
  return entryAssets(COMMENTS_ENTRY, env, log);
}

function entryAssets(entry: string, env: Record<string, string | undefined>, log: AssetLog): Assets {
  const dist = env.ARTIFLOW_DASHBOARD_DIST ?? join(dashboardRoot, "dist");
  const key = join(dist, ".vite", "manifest.json");
  const cacheKey = `${key}\u0000${entry}`;
  const cached = memo.get(cacheKey);
  if (cached !== undefined) return cached;
  const manifest = readManifest(key);
  const entryKey = manifest === null ? undefined : Object.keys(manifest).find((name) => name.endsWith(entry));
  const value: Assets =
    manifest !== null && entryKey !== undefined
      ? {
          script: "/" + (manifest[entryKey]?.file ?? "").replace(/^\/+/, ""),
          styles: collectStyles(manifest, entryKey),
          dev: false,
        }
      : (env.NODE_ENV ?? "").trim() === "production" || (env.ARTIFLOW_REQUIRE_ASSETS ?? "") === "1"
        ? (log(`[viewer] no comment bundle in ${key}; production serves the viewer without comments`),
          { script: "", styles: [], dev: false })
        : { script: devEntry, styles: [], dev: true };
  memo.set(cacheKey, value);
  return value;
}

export const viewerCommentsAsset = (env: Record<string, string | undefined> = process.env): string =>
  viewerCommentsAssets(env).script;

export function resetViewerCommentsAssetCache(): void {
  memo.clear();
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
