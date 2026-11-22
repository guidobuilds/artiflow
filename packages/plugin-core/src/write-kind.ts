import { ARTIFACT_KINDS, DEFAULT_ARTIFACT_KIND, extensionsFor, type ArtifactKind } from "@artiflow/domain/kinds";

const EXTENSIONS: readonly { extension: string; kind: ArtifactKind }[] = ARTIFACT_KINDS.flatMap((kind) =>
  extensionsFor(kind).map((extension) => ({ extension, kind })),
).sort((left, right) => right.extension.length - left.extension.length);

export const fileKind = (path: string): ArtifactKind => {
  const lower = path.toLowerCase();
  return EXTENSIONS.find(({ extension }) => lower.endsWith(extension))?.kind ?? DEFAULT_ARTIFACT_KIND;
};
