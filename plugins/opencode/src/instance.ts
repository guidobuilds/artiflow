import { instanceUrl } from "@artiflow/plugin-core/core";

export const urlKey = "url";

export interface UrlStorage {
  get(key: string): Promise<unknown>;
}

export interface UrlSources {
  readonly options: { url?: unknown };
  readonly env: string | undefined;
  readonly storage: UrlStorage;
}

export async function resolvedInstanceUrl(sources: UrlSources): Promise<string> {
  return instanceUrl(sources.options, sources.env, await sources.storage.get(urlKey));
}

export async function optionalInstanceUrl(sources: UrlSources): Promise<string | null> {
  const stored = await sources.storage.get(urlKey);
  if ((sources.options.url ?? stored ?? sources.env) === undefined) return null;
  return instanceUrl(sources.options, sources.env, stored);
}

export async function configUrl(sources: UrlSources): Promise<{ url: string | null }> {
  try {
    return { url: await resolvedInstanceUrl(sources) };
  } catch {
    return { url: null };
  }
}
