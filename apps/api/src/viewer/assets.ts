import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(here, "../../../../apps/dashboard");

type Entry = { readonly name: string; readonly override: string; readonly noun: string; readonly without: string };

const COMMENTS: Entry = {
  name: "viewer-comments.tsx",
  override: "ARTIFLOW_VIEWER_COMMENTS_ASSET",
  noun: "comment",
  without: "without comments",
};

const ACTIONS: Entry = {
  name: "viewer-actions.tsx",
  override: "ARTIFLOW_VIEWER_ACTIONS_ASSET",
  noun: "actions",
  without: "without management",
};

type ManifestChunk = { file?: string; css?: string[]; imports?: string[] };
export type Assets = { script: string; styles: string[]; dev: boolean };
export type AssetLog = (message: string) => void;

const memo = new Map<string, Assets>();

const logTo = (message: string): void => console.error(message);

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

function entryAssets(entry: Entry, env: Record<string, string | undefined>, log: AssetLog): Assets {
  const dist = env.ARTIFLOW_DASHBOARD_DIST ?? join(dashboardRoot, "dist");
  const key = join(dist, ".vite", "manifest.json");
  const cacheKey = `${key}\u0000${entry.name}`;
  const cached = memo.get(cacheKey);
  if (cached !== undefined) return cached;
  const manifest = readManifest(key);
  const entryKey = manifest === null ? undefined : Object.keys(manifest).find((name) => name.endsWith(entry.name));
  const value: Assets =
    manifest !== null && entryKey !== undefined
      ? {
          script: "/" + (manifest[entryKey]?.file ?? "").replace(/^\/+/, ""),
          styles: collectStyles(manifest, entryKey),
          dev: false,
        }
      : (env.NODE_ENV ?? "").trim() === "production" || (env.ARTIFLOW_REQUIRE_ASSETS ?? "") === "1"
        ? (log(`[viewer] no ${entry.noun} bundle in ${key}; production serves the viewer ${entry.without}`),
          { script: "", styles: [], dev: false })
        : { script: `/src/${entry.name}`, styles: [], dev: true };
  memo.set(cacheKey, value);
  return value;
}

function assetsOf(entry: Entry, env: Record<string, string | undefined>, log: AssetLog): Assets {
  const explicit = (env[entry.override] ?? "").trim();
  if (explicit !== "") return { script: explicit, styles: [], dev: false };
  return entryAssets(entry, env, log);
}

export function viewerCommentsAssets(
  env: Record<string, string | undefined> = process.env,
  log: AssetLog = logTo,
): Assets {
  return assetsOf(COMMENTS, env, log);
}

export function viewerActionsAssets(
  env: Record<string, string | undefined> = process.env,
  log: AssetLog = logTo,
): Assets {
  return assetsOf(ACTIONS, env, log);
}

export const viewerCommentsAsset = (env: Record<string, string | undefined> = process.env): string =>
  viewerCommentsAssets(env).script;

export const viewerActionsAsset = (env: Record<string, string | undefined> = process.env): string =>
  viewerActionsAssets(env).script;

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

export const assetsHead = (...sets: Assets[]): string =>
  [...new Set(sets.flatMap((assets) => assets.styles))]
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("\n");

export const assetsScripts = (...sets: Assets[]): string =>
  `${sets.some((assets) => assets.dev) ? DEV_PREAMBLE + "\n" : ""}${sets
    .map((assets) => `<script type="module" src="${assets.script}"></script>`)
    .join("\n")}`;
