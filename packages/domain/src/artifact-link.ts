import { parseSceneLink, sceneViewHref, type SceneLink } from "./scene-link.ts";

export const ARTIFACT_LINK_MAX_LENGTH = 2000;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARTIFACT_PATH = /^\/artifact\/([^/]+)\/?$/;
const LINK_SCHEMES = ["http:", "https:"];

export type ArtifactLinkProblem =
  "blank" | "too_long" | "not_a_link" | "not_an_artifact_link" | "invalid_artifact_id" | "invalid_revision_id";

export type ArtifactLink = {
  readonly artifactId: string;
  readonly revisionId: string | null;
  readonly scene: SceneLink;
};

export type ArtifactLinkResult =
  { readonly ok: true; readonly link: ArtifactLink } | { readonly ok: false; readonly reason: ArtifactLinkProblem };

const invalid = (reason: ArtifactLinkProblem): ArtifactLinkResult => ({ ok: false, reason });

export const isCanonicalArtifactId = (value: string): boolean => CANONICAL_UUID.test(value);

export const parseArtifactLink = (value: string): ArtifactLinkResult => {
  const trimmed = value.trim();
  if (trimmed === "") return invalid("blank");
  if (trimmed.length > ARTIFACT_LINK_MAX_LENGTH) return invalid("too_long");
  let url: URL;
  try {
    url = new URL(trimmed, "http://artifact.invalid");
  } catch {
    return invalid("not_a_link");
  }
  if (!LINK_SCHEMES.includes(url.protocol)) return invalid("not_a_link");
  if (url.username !== "" || url.password !== "") return invalid("not_a_link");
  const matched = ARTIFACT_PATH.exec(url.pathname);
  if (matched === null) return invalid("not_an_artifact_link");
  const artifactId = matched[1] ?? "";
  if (!CANONICAL_UUID.test(artifactId)) return invalid("invalid_artifact_id");
  const requestedRevision = url.searchParams.get("revision");
  const revisionId = requestedRevision === null || requestedRevision === "" ? null : requestedRevision;
  if (revisionId !== null && !CANONICAL_UUID.test(revisionId)) return invalid("invalid_revision_id");
  return {
    ok: true,
    link: { artifactId, revisionId, scene: parseSceneLink(url.searchParams) },
  };
};

export const artifactLinkHref = (link: ArtifactLink): string => {
  const path = `/artifact/${encodeURIComponent(link.artifactId)}`;
  const search = sceneViewHref(path, link.scene);
  if (link.revisionId === null) return search;
  const [base, query] = search.split("?");
  return `${base}?revision=${encodeURIComponent(link.revisionId)}${query === undefined ? "" : `&${query}`}`;
};
