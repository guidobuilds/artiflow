export function instanceUrl(options: { url?: unknown }, env: string | undefined): string {
  const invalid = () =>
    new Error(
      "Configure artiflow.url (options.url) or ARTIFLOW_URL with an absolute http(s) origin without credentials, path, query, or fragment.",
    );
  const value = options.url ?? env;
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) throw invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname.replace(/\/+$/, "") ||
    url.search ||
    url.hash
  )
    throw invalid();
  return url.origin;
}

export const viewerUrl = (base: string, artifactId: string): string =>
  `${base}/artifact/${encodeURIComponent(artifactId)}`;

export { ArtifactRefusal, createArtifactApi, type ArtifactApi, type Refusal } from "./api.ts";
